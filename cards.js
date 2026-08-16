'use strict';

/* ======================================================================
   Player cards: percentile-based fantasy ratings for a starting set of
   featured skaters. Uses the same season data as the stats page (data.js).

   Rating methodology:
   - Eligibility pool = skaters with gamesPlayed >= MIN_GP_FRACTION of the
     season's game count (itself derived from the data, not hardcoded —
     see seasonGameCount() in data.js — so this keeps working once
     2026-27 stats replace these).
   - Each category's rating = that player's percentile rank for the
     mapped stat, within the eligibility pool, linearly rescaled from a
     0-100 percentile to a RATING_FLOOR-RATING_CEIL "card" rating (so
     even a below-average-among-qualified-NHLers stat doesn't read as a
     harsh near-zero — everyone in the pool already cleared the games-
     played bar).
   - Overall (the circular badge) = average of the 8 category ratings.
   ====================================================================== */

const MIN_GP_FRACTION = 0.3;
const RATING_FLOOR = 55;
const RATING_CEIL = 99;

// Card category -> underlying stat (see data.js buildSkaters for stat shape).
// SHO/PAS/GRIT/etc are placeholders for whatever your league calls these —
// remap the `stat` values here if a pairing doesn't match your categories.
const CARD_CATEGORIES = [
  { key: 'SHO', label: 'Shooting', stat: 'goals' },
  { key: 'PAS', label: 'Passing', stat: 'assists' },
  { key: 'PP', label: 'Power Play', stat: 'ppPoints' },
  { key: 'PK', label: 'Penalty Kill', stat: 'shPoints' },
  { key: 'VOL', label: 'Volume', stat: 'sog' },
  { key: 'PHY', label: 'Physical', stat: 'hits' },
  { key: 'DEF', label: 'Defense', stat: 'blocks' },
  { key: 'GRIT', label: 'Grit', stat: 'pim' },
];

// How much each category counts toward a player's OVERALL badge, by
// position group — the 8 category ratings themselves are always plain
// percentiles (unweighted), this only changes how they're blended into
// one number. Tune freely; a weight is relative, not a percentage (they
// get normalized by their own sum, so e.g. doubling every weight for a
// group changes nothing).
const POSITION_WEIGHTS = {
  // Centers: two-way, playmaking, works both special-teams units.
  C: { SHO: 1.1, PAS: 1.4, PP: 1.2, PK: 1.3, VOL: 1.0, PHY: 0.7, DEF: 0.9, GRIT: 0.7 },
  // Wingers (L/R combined): finishers, PP flank shooters, board play.
  W: { SHO: 1.4, PAS: 1.0, PP: 1.3, PK: 0.6, VOL: 1.3, PHY: 1.1, DEF: 0.6, GRIT: 0.9 },
  // Defensemen: shot-blocking, physicality, PK staple, point-shot/assists over goals.
  D: { SHO: 0.6, PAS: 1.1, PP: 1.1, PK: 1.3, VOL: 0.7, PHY: 1.3, DEF: 1.8, GRIT: 1.0 },
};

/** Maps a raw position code (C/L/R/D) to a POSITION_WEIGHTS group. */
function positionGroup(pos) {
  if (pos === 'D') return 'D';
  if (pos === 'C') return 'C';
  return 'W'; // L, R
}

const POSITION_GROUP_LABEL = { C: 'center', W: 'winger', D: 'defenseman' };

// Starting set — the "top players" from the stats page. Add/remove names
// to change who gets a card; matched against the live dataset by name.
const FEATURED_SKATERS = [
  'Nathan MacKinnon',
  'Cole Caufield',
  'Connor McDavid',
  'Macklin Celebrini',
  'Kirill Kaprizov',
];

const el = {
  seasonLabel: document.getElementById('seasonLabel'),
  statusBanner: document.getElementById('statusBanner'),
  eligibilityNote: document.getElementById('eligibilityNote'),
  skeleton: document.getElementById('cardsSkeleton'),
  grid: document.getElementById('cardsGrid'),
};

let teamMetaCache = new Map();

/** Percentile rank (0-100) of `value` within `pool` — 0 = lowest, 100 = highest. */
function percentileRank(value, pool) {
  const n = pool.length;
  if (n <= 1) return 100;
  let below = 0;
  for (const v of pool) if (v < value) below += 1;
  return (below / (n - 1)) * 100;
}

function toCardRating(percentile) {
  const raw = RATING_FLOOR + (percentile / 100) * (RATING_CEIL - RATING_FLOOR);
  return Math.max(RATING_FLOOR, Math.min(RATING_CEIL, Math.round(raw)));
}

/** Weighted average of the category ratings, using the player's position group's weights. */
function weightedOverall(ratings, pos) {
  const weights = POSITION_WEIGHTS[positionGroup(pos)];
  let weightedSum = 0;
  let weightTotal = 0;
  for (const r of ratings) {
    const w = weights[r.key] ?? 1;
    weightedSum += r.rating * w;
    weightTotal += w;
  }
  return Math.round(weightedSum / weightTotal);
}

function showBanner(message) {
  el.statusBanner.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = message;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Retry';
  btn.addEventListener('click', init);
  el.statusBanner.append(span, btn);
  el.statusBanner.hidden = false;
}

async function init() {
  el.statusBanner.hidden = true;
  el.skeleton.hidden = false;
  el.grid.innerHTML = '';

  try {
    const { seasonId, teamMeta, skaters } = await loadSeasonData();
    teamMetaCache = teamMeta;
    el.seasonLabel.textContent = `${seasonLabel(seasonId)} · Ratings`;

    const maxGP = seasonGameCount(skaters);
    const minGP = Math.ceil(maxGP * MIN_GP_FRACTION);
    const eligible = skaters.filter((p) => p.gamesPlayed >= minGP);

    el.eligibilityNote.textContent =
      `Ratings are percentile ranks among the ${eligible.length.toLocaleString()} skaters who've ` +
      `played at least ${minGP} games this season (30% of ${maxGP}), scaled to ${RATING_FLOOR}–${RATING_CEIL}.`;

    const statPools = {};
    for (const cat of CARD_CATEGORIES) {
      statPools[cat.stat] = eligible.map((p) => p[cat.stat] ?? 0);
    }

    const featured = FEATURED_SKATERS
      .map((name) => skaters.find((p) => p.name === name))
      .filter(Boolean);

    const missing = FEATURED_SKATERS.filter((name) => !skaters.some((p) => p.name === name));
    if (missing.length) {
      console.warn('Featured skater(s) not found in current dataset:', missing);
    }

    const landings = await Promise.all(
      featured.map((p) => getJSON(`${API_WEB}/v1/player/${p.playerId}/landing`).catch(() => null)),
    );

    el.skeleton.hidden = true;
    featured.forEach((player, i) => {
      const ratings = CARD_CATEGORIES.map((cat) => {
        const value = player[cat.stat] ?? 0;
        return { ...cat, value, rating: toCardRating(percentileRank(value, statPools[cat.stat])) };
      });
      const overall = weightedOverall(ratings, player.pos);
      el.grid.appendChild(buildCard(player, landings[i], ratings, overall));
    });
  } catch (err) {
    el.skeleton.hidden = true;
    showBanner(`Couldn't load NHL data (${err.message}). Make sure the local server is running, then retry.`);
  }
}

function buildCard(player, landing, ratings, overall) {
  const colors = teamColor(player.team);
  const name = (landing?.firstName?.default && landing?.lastName?.default)
    ? `${landing.firstName.default} ${landing.lastName.default}`
    : player.name;
  const headshot = landing?.headshot || `https://assets.nhle.com/mugs/nhl/latest/${player.playerId}.png`;
  const meta = teamMetaCache.get(player.team);
  const teamName = meta?.name || player.team;
  const sweaterNumber = landing?.sweaterNumber;

  const card = document.createElement('div');
  card.className = 'player-card';
  card.style.setProperty('--card-primary', colors.primary);
  card.style.setProperty('--card-secondary', colors.secondary);

  card.innerHTML = `
    <div class="card-top">
      <div class="card-badge">
        <span class="card-overall" title="Overall, weighted for ${POSITION_GROUP_LABEL[positionGroup(player.pos)]}s">${overall}</span>
        <span class="card-pos">${escapeHtml(player.pos)}</span>
      </div>
      <div class="card-team-pill">
        ${meta?.logo ? `<img src="${meta.logo}" alt="">` : ''}
        <span>${escapeHtml(player.team)}</span>
      </div>
    </div>
    <div class="card-photo-wrap">
      <img class="card-photo" src="${headshot}" alt="" onerror="this.style.visibility='hidden'">
    </div>
    <div class="card-identity">
      <div class="card-name">${escapeHtml(name)}</div>
      <div class="card-subtitle">${escapeHtml(teamName)}${sweaterNumber ? ' · #' + sweaterNumber : ''}</div>
    </div>
    <div class="card-stats-grid">
      ${ratings.map((r) => `
        <div class="card-stat" title="${escapeHtml(r.label)}: ${r.value}">
          <span class="card-stat-num">${r.rating}</span>
          <span class="card-stat-lbl">${escapeHtml(r.key)}</span>
        </div>
      `).join('')}
    </div>
  `;
  return card;
}

init();
