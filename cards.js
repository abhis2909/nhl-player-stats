'use strict';

/* ======================================================================
   Player cards: percentile-based fantasy ratings for every qualified
   skater. Uses the same season data as the stats page (data.js) AND the
   same stat-column selection as the admin page (columns.js) — whichever
   skater columns are enabled in ⚙ Columns are exactly the categories
   shown here, so changing that selection changes the cards too (see the
   `storage` listener at the bottom for the same-tab-open-elsewhere case).

   Rating methodology:
   - Eligibility pool = skaters with gamesPlayed >= MIN_GP_FRACTION of the
     season's game count (itself derived from the data, not hardcoded —
     see seasonGameCount() in data.js — so this keeps working once
     2026-27 stats replace these). Only eligible skaters get a card.
   - Each category's rating = that player's percentile rank for the
     mapped stat, within the eligibility pool, rescaled to
     RATING_FLOOR-RATING_CEIL. (Giveaways is inverted — fewer is better.)
   - Overall (the circular badge): a straight average-of-percentiles
     regresses hard toward the middle (central limit theorem — averaging
     several roughly-independent percentiles rarely lands near either
     end), which is why ratings looked bunched in the 70s-80s for almost
     everyone. So overall is computed in two stages instead: (1) each
     player's position-weighted composite percentile, then (2) THAT
     composite is itself re-percentiled across the pool before the final
     floor/ceil rescale. Same relative ordering (it's a monotonic
     transform), but restores real use of the full 55-99 range instead of
     compressing everyone into a narrow band.
   ====================================================================== */

const MIN_GP_FRACTION = 0.3;
const RATING_FLOOR = 55;
const RATING_CEIL = 99;
const BATCH_SIZE = 48;

// Stats where a LOWER raw value is the better outcome (percentile gets
// inverted before rating). Everything else: higher = better.
const INVERT_STATS = new Set(['giveaways']);

// How much each stat counts toward a player's OVERALL badge, by position
// group (L and R share the winger profile). Individual category ratings
// are always plain percentiles — this only changes how they blend into
// one number. Covers every stat in columns.js's SKATER_COLUMNS catalog;
// anything selected there that's missing here just falls back to weight 1.
const POSITION_WEIGHTS = {
  // Centers: two-way, playmaking, faceoffs, works both special-teams units.
  C: {
    goals: 1.1, assists: 1.4, points: 1.3, plusMinus: 1.0, ppGoals: 1.1, ppPoints: 1.2,
    shGoals: 1.2, shPoints: 1.3, gameWinningGoals: 1.1, otGoals: 1.0, pim: 0.7, sog: 1.0,
    shootingPct: 0.9, gamesPlayed: 0.8, hits: 0.7, blocks: 0.9, giveaways: 1.0, takeaways: 1.1,
    faceoffPct: 1.5,
  },
  // Wingers (L/R combined): finishers, PP flank shooters, board play.
  W: {
    goals: 1.4, assists: 1.0, points: 1.2, plusMinus: 1.0, ppGoals: 1.3, ppPoints: 1.3,
    shGoals: 0.7, shPoints: 0.6, gameWinningGoals: 1.2, otGoals: 1.1, pim: 0.9, sog: 1.3,
    shootingPct: 1.1, gamesPlayed: 0.8, hits: 1.1, blocks: 0.6, giveaways: 0.9, takeaways: 0.8,
    faceoffPct: 0.3,
  },
  // Defensemen: shot-blocking, physicality, PK staple, point-shot/assists over goals.
  D: {
    goals: 0.6, assists: 1.1, points: 1.0, plusMinus: 1.1, ppGoals: 0.7, ppPoints: 1.1,
    shGoals: 1.0, shPoints: 1.3, gameWinningGoals: 0.7, otGoals: 0.6, pim: 1.0, sog: 0.7,
    shootingPct: 0.6, gamesPlayed: 0.9, hits: 1.3, blocks: 1.8, giveaways: 1.3, takeaways: 1.3,
    faceoffPct: 0.2,
  },
};

/** Maps a raw position code (C/L/R/D) to a POSITION_WEIGHTS group. */
function positionGroup(pos) {
  if (pos === 'D') return 'D';
  if (pos === 'C') return 'C';
  return 'W'; // L, R
}

const POSITION_GROUP_LABEL = { C: 'center', W: 'winger', D: 'defenseman' };

/** Catalog entries (from columns.js) for whichever skater stats are currently
 *  enabled on the admin page — read fresh each call so this always reflects
 *  the latest saved selection, not a stale snapshot. */
function activeColumns(mode) {
  const config = loadColumnConfig();
  const selected = new Set(config[mode] || []);
  return columnCatalog(mode).filter((c) => selected.has(c.id));
}

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
  rawSkaters: [],   // eligible skaters, unrated (re-rated whenever the column config changes)
  players: [],      // rawSkaters + .ratings + .overall for the CURRENT column config
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

/** Recomputes ratings + overall for every skater, using whichever columns are
 *  currently enabled on the admin page. Cheap (~tens of ms for ~700 players),
 *  safe to call whenever the column config might have changed. */
function rateAllPlayers() {
  const categories = activeColumns('skaters'); // from columns.js: catalog entries filtered to the saved selection
  const pool = state.rawSkaters;

  const statPools = {};
  for (const cat of categories) statPools[cat.id] = pool.map((p) => p[cat.id] ?? 0);

  // Stage 1: per-category percentile (also this player's individually-displayed rating)
  // and this player's position-weighted composite percentile.
  const withComposite = pool.map((player) => {
    const ratings = categories.map((cat) => {
      const value = player[cat.id] ?? 0;
      let pct = percentileRank(value, statPools[cat.id]);
      if (INVERT_STATS.has(cat.id)) pct = 100 - pct;
      return { id: cat.id, short: cat.short, label: cat.label, fmt: cat.fmt, value, rating: toCardRating(pct), pct };
    });
    const weights = POSITION_WEIGHTS[positionGroup(player.pos)];
    let weightedSum = 0;
    let weightTotal = 0;
    for (const r of ratings) {
      const w = weights[r.id] ?? 1;
      weightedSum += r.pct * w;
      weightTotal += w;
    }
    return { player, ratings, compositePct: weightTotal ? weightedSum / weightTotal : 50 };
  });

  // Stage 2: re-percentile the composite score itself so overall actually
  // spans the full range instead of clustering around the middle.
  const compositePool = withComposite.map((w) => w.compositePct);
  state.players = withComposite.map(({ player, ratings, compositePct }) => ({
    ...player,
    ratings,
    overall: toCardRating(percentileRank(compositePct, compositePool)),
  }));
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
    state.rawSkaters = skaters.filter((p) => p.gamesPlayed >= minGP);

    el.eligibilityNote.textContent =
      `Showing the ${state.rawSkaters.length.toLocaleString()} skaters who've played at least ${minGP} games ` +
      `this season (30% of ${maxGP}). Categories match your ⚙ Columns selection for skaters — change it there ` +
      `and these update too. Ratings are percentile ranks within this group, scaled to ${RATING_FLOOR}–${RATING_CEIL}.`;

    rateAllPlayers();
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

/** @param reset - true when a filter (or the column config) changed; false for "load more". */
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

// If the admin page (⚙ Columns) is open in another tab and saves a change,
// pick it up here live instead of requiring a reload.
window.addEventListener('storage', (e) => {
  if (e.key !== COLUMN_STORAGE_KEY) return;
  rateAllPlayers();
  render(true);
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
        <div class="card-stat" title="${escapeHtml(r.label)}: ${escapeHtml(formatColumnValue(r, r.value))}">
          <span class="card-stat-num">${r.rating}</span>
          <span class="card-stat-lbl">${escapeHtml(r.short)}</span>
        </div>
      `).join('')}
    </div>
  `;
  return card;
}

init();
