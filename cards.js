'use strict';

/* ======================================================================
   Player cards: percentile-based fantasy ratings for every qualified
   skater. Uses the same season data as the stats page (data.js).

   Rating methodology:
   - Eligibility pool = skaters with gamesPlayed >= MIN_GP_FRACTION of the
     season's game count (itself derived from the data, not hardcoded —
     see seasonGameCount() in data.js — so this keeps working once
     2026-27 stats replace these). Only eligible skaters get a card at
     all — a 3-game sample doesn't get a meaningful rating either way.
   - Each category's rating = that player's percentile rank for the
     mapped stat, within the eligibility pool, linearly rescaled from a
     0-100 percentile to a RATING_FLOOR-RATING_CEIL "card" rating.
   - Overall (the circular badge) = the 8 category ratings, averaged with
     position-specific weights (POSITION_WEIGHTS below).

   No per-card network requests — headshots are built from the player id
   (same asset URL pattern the stats page uses), name/team/stats all come
   from the one bulk fetch. That's what makes rendering ~700 cards
   feasible; a landing-page fetch per card (as the original 5-card
   version did) would be ~700 extra requests.
   ====================================================================== */

const MIN_GP_FRACTION = 0.3;
const RATING_FLOOR = 55;
const RATING_CEIL = 99;
const BATCH_SIZE = 48;

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

const el = {
  seasonLabel: document.getElementById('seasonLabel'),
  statusBanner: document.getElementById('statusBanner'),
  eligibilityNote: document.getElementById('eligibilityNote'),
  skeleton: document.getElementById('cardsSkeleton'),
  grid: document.getElementById('cardsGrid'),
  resultCount: document.getElementById('resultCount'),
  loadMoreWrap: document.getElementById('loadMoreWrap'),
  loadMoreBtn: document.getElementById('loadMoreBtn'),
  searchInput: document.getElementById('searchInput'),
  teamSelect: document.getElementById('teamSelect'),
  posButtons: Array.from(document.querySelectorAll('.toggle-btn[data-pos]')),
};

const state = {
  teamMeta: new Map(),
  players: [],      // eligible skaters, each with .ratings + .overall precomputed
  search: '',
  team: 'ALL',
  pos: 'ALL',
  visibleCount: BATCH_SIZE,
};

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

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function init() {
  el.statusBanner.hidden = true;
  el.skeleton.hidden = false;
  el.grid.innerHTML = '';

  try {
    const { seasonId, teamMeta, skaters } = await loadSeasonData();
    state.teamMeta = teamMeta;
    el.seasonLabel.textContent = `${seasonLabel(seasonId)} · Ratings`;

    const maxGP = seasonGameCount(skaters);
    const minGP = Math.ceil(maxGP * MIN_GP_FRACTION);
    const eligible = skaters.filter((p) => p.gamesPlayed >= minGP);

    el.eligibilityNote.textContent =
      `Showing the ${eligible.length.toLocaleString()} skaters who've played at least ${minGP} games ` +
      `this season (30% of ${maxGP}). Ratings are each player's percentile rank within that group, ` +
      `scaled to ${RATING_FLOOR}–${RATING_CEIL}, then blended into the overall badge with position-specific weights.`;

    const statPools = {};
    for (const cat of CARD_CATEGORIES) {
      statPools[cat.stat] = eligible.map((p) => p[cat.stat] ?? 0);
    }

    // Precompute ratings once so filtering/searching later is instant.
    state.players = eligible.map((player) => {
      const ratings = CARD_CATEGORIES.map((cat) => {
        const value = player[cat.stat] ?? 0;
        return { ...cat, value, rating: toCardRating(percentileRank(value, statPools[cat.stat])) };
      });
      return { ...player, ratings, overall: weightedOverall(ratings, player.pos) };
    });

    populateTeamSelect();
    el.skeleton.hidden = true;
    render(true);
  } catch (err) {
    el.skeleton.hidden = true;
    showBanner(`Couldn't load NHL data (${err.message}). Make sure the local server is running, then retry.`);
  }
}

function populateTeamSelect() {
  const teams = Array.from(state.teamMeta.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const frag = document.createDocumentFragment();
  const allOpt = document.createElement('option');
  allOpt.value = 'ALL';
  allOpt.textContent = 'All Teams';
  frag.appendChild(allOpt);
  for (const [abbrev, meta] of teams) {
    const opt = document.createElement('option');
    opt.value = abbrev;
    opt.textContent = meta.name;
    frag.appendChild(opt);
  }
  el.teamSelect.innerHTML = '';
  el.teamSelect.appendChild(frag);
}

function getFiltered() {
  const q = state.search.trim().toLowerCase();
  return state.players
    .filter((p) => {
      if (state.team !== 'ALL' && p.team !== state.team) return false;
      if (state.pos !== 'ALL' && positionGroup(p.pos) !== state.pos) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => b.overall - a.overall);
}

/** @param reset - true when a filter changed (rebuild from scratch); false for "load more". */
function render(reset) {
  if (reset) state.visibleCount = BATCH_SIZE;
  const filtered = getFiltered();
  const slice = filtered.slice(0, state.visibleCount);

  el.grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  slice.forEach((p) => frag.appendChild(buildCard(p)));
  el.grid.appendChild(frag);

  el.resultCount.textContent = `Showing ${slice.length.toLocaleString()} of ${filtered.length.toLocaleString()} skaters`;
  el.loadMoreWrap.hidden = slice.length >= filtered.length;
}

el.searchInput.addEventListener('input', debounce(() => {
  state.search = el.searchInput.value;
  render(true);
}, 150));

el.teamSelect.addEventListener('change', () => {
  state.team = el.teamSelect.value;
  render(true);
});

el.posButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.pos = btn.dataset.pos;
    el.posButtons.forEach((b) => b.classList.toggle('active', b === btn));
    render(true);
  });
});

el.loadMoreBtn.addEventListener('click', () => {
  state.visibleCount += BATCH_SIZE;
  render(false);
});

function buildCard(player) {
  const colors = teamColor(player.team);
  const headshot = `https://assets.nhle.com/mugs/nhl/latest/${player.playerId}.png`;
  const meta = state.teamMeta.get(player.team);
  const teamName = meta?.name || player.team;

  const card = document.createElement('div');
  card.className = 'player-card';
  card.style.setProperty('--card-primary', colors.primary);
  card.style.setProperty('--card-secondary', colors.secondary);

  card.innerHTML = `
    <div class="card-top">
      <div class="card-badge">
        <span class="card-overall" title="Overall, weighted for ${POSITION_GROUP_LABEL[positionGroup(player.pos)]}s">${player.overall}</span>
        <span class="card-pos">${escapeHtml(player.pos)}</span>
      </div>
      <div class="card-team-pill">
        ${meta?.logo ? `<img src="${meta.logo}" alt="" loading="lazy">` : ''}
        <span>${escapeHtml(player.team)}</span>
      </div>
    </div>
    <div class="card-photo-wrap">
      <img class="card-photo" src="${headshot}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    </div>
    <div class="card-identity">
      <div class="card-name">${escapeHtml(player.name)}</div>
      <div class="card-subtitle">${escapeHtml(teamName)}</div>
    </div>
    <div class="card-stats-grid">
      ${player.ratings.map((r) => `
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
