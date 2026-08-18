'use strict';

/* ======================================================================
   Player cards: percentile-based fantasy ratings for every qualified
   skater AND goalie, season-to-date. Uses the same season data as the
   stats page (data.js), the same stat-column selections as the admin
   page (columns.js), and the shared rating engine + card renderer in
   ratings.js (also used by range.js for week/month "Range Ratings").
   Whichever skater/goalie columns are enabled in ⚙ Columns are exactly
   the categories shown here, so changing that selection changes the
   cards too (see the `storage` listener near the bottom for the
   same-tab-open-elsewhere case).

   Rating methodology (full detail in ratings.js's header comment):
   - Eligibility pool here = players with gamesPlayed >= MIN_GAMES_PLAYED_
     SKATERS/GOALIES (flat counts, not scaled to the season length or
     either group's own max games played — goalies get a lower bar
     since they play far fewer games than skaters).
   - ratePool() (ratings.js) turns that pool into percentile-based
     ratings; buildCard() (ratings.js) renders the gem-tier card HTML.

   Card visuals: overall maps to one of six gem tiers (tierFor()) — Silver
   / Gold / Emerald / Ruby / Amethyst / Diamond — and tier drives more
   than color: border shimmer speed, sheen-sweep strength, badge/aura
   glow, pulse, sparkles, and stat-tile shape all scale with rarity (see
   the .tier-* rules in style.css). Team is just the small logo+
   abbreviation pill, not the card's theme color.

   Detail modal (click a card): bio, a rating-trend chart built from
   saved weekly snapshots (shows "Start of season" until at least 2
   points exist — see snapshots.js and buildSnapshotTrendPoints()), and
   the full scrollable game log for whichever season/type is selected —
   see the "player detail modal" section below.
   ====================================================================== */

const BATCH_SIZE = 48;

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
  seasonSelect: document.getElementById('seasonSelect'),
  modeButtons: Array.from(document.querySelectorAll('.toggle-btn[data-mode]')),
  posToggleGroup: document.getElementById('posToggleGroup'),
  posButtons: Array.from(document.querySelectorAll('.toggle-btn[data-pos]')),
  modalRoot: document.getElementById('modalRoot'),
  modalOverlay: document.getElementById('modalOverlay'),
  modalClose: document.getElementById('modalClose'),
  modalContent: document.getElementById('modalContent'),
  compareBar: document.getElementById('compareBar'),
  compareBarText: document.getElementById('compareBarText'),
  compareBtn: document.getElementById('compareBtn'),
  compareClearBtn: document.getElementById('compareClearBtn'),
  compareModalRoot: document.getElementById('compareModalRoot'),
  compareModalOverlay: document.getElementById('compareModalOverlay'),
  compareModalClose: document.getElementById('compareModalClose'),
  compareModalContent: document.getElementById('compareModalContent'),
};

const state = {
  teamMeta: new Map(),
  seasonId: null, // the CURRENT (live/active-snapshot) season — always fetched, regardless of which season is selected below
  selectedSeasonId: null, // whichever season the grid is actually showing ratings for
  seasonDataCache: new Map(), // seasonId -> { skaters, goalies } raw unfiltered — avoids refetching a season already looked at
  // Always the CURRENT season's ratings, independent of whichever season
  // is displayed below — used only by the Rating Trend chart's "Live"
  // point (see buildSnapshotTrendPoints()), so switching the season
  // selector to a past year can't leak into and mislabel that chart.
  currentSeasonRatedSkaters: [],
  currentSeasonRatedGoalies: [],
  mode: 'skaters', // 'skaters' | 'goalies'
  rawSkaters: [], ratedSkaters: [], skaterMinGP: 0, skaterMaxGP: 0,
  rawGoalies: [], ratedGoalies: [], goalieMinGP: 0, goalieMaxGP: 0,
  search: '',
  team: 'ALL',
  pos: 'ALL',
  visibleCount: BATCH_SIZE,
  compareSelections: new Map(), // playerId -> rated player, max 2, same mode only
  ratingConfig: null, // admin-tuned RatingSettings override (public-config.js) — null falls back to ratings.js's own defaults, see toCardRating()'s doc comment
};

// How far back the season selector goes — 2021-22 is the earliest
// "normal" 82-game season after the COVID-shortened 2019-20/2020-21
// ones, per explicit request to stop there.
const MIN_SEASON_ID = 20212022;

// GAMELOG_FIELD_MAP/REALTIME_FIELD_MAP moved to the shared
// player-modal.js along with the game-log rendering they fed — it owns
// the whole game-log/stats-window/compare-modal system now.

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

function rateAllPlayers() {
  state.ratedSkaters = ratePool(state.rawSkaters, 'skaters', state.ratingConfig);
  state.ratedGoalies = ratePool(state.rawGoalies, 'goalies', state.ratingConfig);
}

async function init() {
  el.statusBanner.hidden = true;
  el.skeleton.hidden = false;
  el.grid.innerHTML = '';
  await snapshotsReady; // snapshots.js — the rating-trend chart reads snapshot history
  // Admin-tuned rating weights/floor/ceil/premium/tiers (Admin -> Rating
  // Methodology) — null (fetch failure, or nothing saved yet) falls back
  // to ratings.js's own hardcoded defaults everywhere below.
  state.ratingConfig = await fetch('/api/fantasy/public-config')
    .then((r) => r.json()).then((d) => (d.ok ? d.ratingSettings : null)).catch(() => null);

  try {
    // Always fetch the CURRENT season (live, or the active local snapshot)
    // — it's the default season shown, and every OTHER season in the
    // dropdown is counted back from it (see availableSeasonIds()).
    const { seasonId, teamMeta, skaters, goalies, source, snapshotLabel } = await getSeasonData();
    state.teamMeta = teamMeta;
    state.seasonId = seasonId;
    el.seasonLabel.textContent = `${seasonLabel(seasonId)} · Ratings` +
      (source === 'snapshot' ? ` · ${snapshotLabel}` : '');

    state.seasonDataCache.set(seasonId, { skaters, goalies });

    populateSeasonSelect();
    populateTeamSelect();

    // Always rate the current season first — populates
    // state.currentSeasonRated* for the Rating Trend chart's "Live"
    // point even when a past season ends up displayed below (cheap: the
    // raw data was just cached above, this only redoes the rate pass).
    await loadAndRateSeason(seasonId);

    // A data-bar action (switching snapshots, Retrieve Latest Stats) re-runs
    // init() — keep whatever season the user had selected rather than
    // silently jumping back to current, unless this is the first load.
    const validSeasons = new Set(availableSeasonIds());
    const targetSeason = validSeasons.has(state.selectedSeasonId) ? state.selectedSeasonId : seasonId;
    if (targetSeason !== seasonId) await loadAndRateSeason(targetSeason);

    updateEligibilityNote();
    el.skeleton.hidden = true;
    render(true);
  } catch (err) {
    el.skeleton.hidden = true;
    showBanner(`Couldn't load NHL data (${err.message}). Make sure the local server is running, then retry.`);
  }
}

/** Season ids selectable in the season dropdown — current season down
 *  to MIN_SEASON_ID, newest first. NHL season ids follow a YYYYYYYY+1
 *  pattern, so stepping back one season is always -10001. */
function availableSeasonIds() {
  const ids = [];
  for (let id = state.seasonId; id >= MIN_SEASON_ID; id -= 10001) ids.push(id);
  return ids;
}

function populateSeasonSelect() {
  const ids = availableSeasonIds();
  el.seasonSelect.innerHTML = ids
    .map((id) => `<option value="${id}">${seasonLabel(id)}${id === state.seasonId ? ' (Current)' : ''}</option>`)
    .join('');
  el.seasonSelect.value = String(state.selectedSeasonId ?? state.seasonId);
}

/** Fetches (or reuses a cached copy of) `seasonId`'s stats, rates them,
 *  and stores the result in state.ratedSkaters/ratedGoalies — same
 *  eligibility rule as always (MIN_GAMES_PLAYED_SKATERS/GOALIES, flat
 *  counts, not scaled to the season length). Keeps everyone who played
 *  that season, retired or not — a past season's ratings reflect who
 *  was good THAT year. */
async function loadAndRateSeason(seasonId) {
  let raw = state.seasonDataCache.get(seasonId);
  if (!raw) {
    const data = await loadSeasonStatsFor(seasonId, state.teamMeta);
    raw = { skaters: data.skaters, goalies: data.goalies };
    state.seasonDataCache.set(seasonId, raw);
  }

  state.skaterMaxGP = seasonGameCount(raw.skaters);
  state.skaterMinGP = state.ratingConfig?.minGamesPlayedSkaters ?? MIN_GAMES_PLAYED_SKATERS;
  state.rawSkaters = raw.skaters.filter((p) => p.gamesPlayed >= state.skaterMinGP);

  state.goalieMaxGP = seasonGameCount(raw.goalies);
  state.goalieMinGP = state.ratingConfig?.minGamesPlayedGoalies ?? MIN_GAMES_PLAYED_GOALIES;
  state.rawGoalies = raw.goalies.filter((p) => p.gamesPlayed >= state.goalieMinGP);

  rateAllPlayers();
  state.selectedSeasonId = seasonId;

  // The Rating Trend chart's "Live" point means the CURRENT season
  // specifically, regardless of which season the grid itself is
  // displaying — cache that separately so picking a past season here
  // doesn't leak into (and mislabel) the trend chart's final point.
  if (seasonId === state.seasonId) {
    state.currentSeasonRatedSkaters = state.ratedSkaters;
    state.currentSeasonRatedGoalies = state.ratedGoalies;
  }

  // Keep the shared player-modal.js (player-modal.js) in sync — it owns
  // the detail modal + compare modal now, see that file's header
  // comment. seasonDataCache is passed BY REFERENCE (same Map, not a
  // copy) so its Historical rating-trend fetches share this page's
  // existing cache instead of duplicating it.
  initPlayerModal({
    teamMeta: state.teamMeta,
    seasonId: state.seasonId,
    ratingConfig: state.ratingConfig,
    seasonDataCache: state.seasonDataCache,
    currentSeasonRatedSkaters: state.currentSeasonRatedSkaters,
    currentSeasonRatedGoalies: state.currentSeasonRatedGoalies,
    historicalSeasonIds: availableSeasonIds(),
    searchPool: [...state.ratedSkaters, ...state.ratedGoalies],
  });
}

el.seasonSelect.addEventListener('change', async () => {
  const seasonId = Number(el.seasonSelect.value);
  el.seasonSelect.disabled = true;
  el.skeleton.hidden = false;
  try {
    await loadAndRateSeason(seasonId);
    updateEligibilityNote();
    render(true);
  } catch (err) {
    showBanner(`Couldn't load ${seasonLabel(seasonId)} stats (${err.message}).`);
  } finally {
    el.seasonSelect.disabled = false;
    el.skeleton.hidden = true;
  }
});

function updateEligibilityNote() {
  const isGoalie = state.mode === 'goalies';
  const pool = isGoalie ? state.rawGoalies : state.rawSkaters;
  const minGP = isGoalie ? state.goalieMinGP : state.skaterMinGP;
  el.eligibilityNote.textContent =
    `Showing the ${pool.length.toLocaleString()} ${state.mode} who've played at least ${minGP} games ` +
    `in ${seasonLabel(state.selectedSeasonId)}. ` +
    `Categories match your ⚙ Columns selection for ${state.mode} — change it there and these update too. ` +
    `Ratings (including overall) are percentile ranks scaled to ${RATING_FLOOR}` +
    `–${RATING_CEIL}; overall is a weighted average of the category percentiles.`;
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
  const pool = state.mode === 'goalies' ? state.ratedGoalies : state.ratedSkaters;
  return pool
    .filter((p) => {
      if (state.team !== 'ALL' && p.team !== state.team) return false;
      if (state.mode === 'skaters' && state.pos !== 'ALL' && positionGroup(p.pos) !== state.pos) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => b.overall - a.overall);
}

/** @param reset - true when a filter/mode/column-config changed; false for "load more". */
function render(reset) {
  if (reset) state.visibleCount = BATCH_SIZE;
  const filtered = getFiltered();
  const slice = filtered.slice(0, state.visibleCount);

  el.grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  slice.forEach((p) => frag.appendChild(buildCardWithCompare(p)));
  el.grid.appendChild(frag);

  el.resultCount.textContent = `Showing ${slice.length.toLocaleString()} of ${filtered.length.toLocaleString()} ${state.mode}`;
  el.loadMoreWrap.hidden = slice.length >= filtered.length;
}

/** buildCard() (ratings.js) wrapped for the smaller Player Ratings grid
 *  (.pr-card-scale crops+visually shrinks the card, which still renders
 *  at its normal fixed-pixel design size internally — see the .pr-grid
 *  comment in style.css) plus a "Compare" checkbox strip UNDER that
 *  scaled box, at normal size (not shrunk/cropped with the card, or
 *  it'd be nearly unclickable). Kept out of the shared buildCard()
 *  itself since Range Ratings/Team of the Week reuse that function and
 *  don't want any of this. */
function buildCardWithCompare(player) {
  const card = buildCard(player, state.teamMeta, openPlayerModal, state.ratingConfig);

  const scaleBox = document.createElement('div');
  scaleBox.className = 'pr-card-scale';
  scaleBox.appendChild(card);

  const bar = document.createElement('label');
  bar.className = 'pc-compare-bar';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = state.compareSelections.has(player.playerId);
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation(); // don't also trigger the card's own click-to-open-modal
    toggleCompare(player);
  });
  const text = document.createElement('span');
  text.textContent = 'Compare';
  bar.append(checkbox, text);

  const wrap = document.createElement('div');
  wrap.className = 'pr-card-wrap';
  wrap.append(scaleBox, bar);
  return wrap;
}

// ---------------------------------------------------------------------
// Compare two players
// ---------------------------------------------------------------------

function toggleCompare(player) {
  if (state.compareSelections.has(player.playerId)) {
    state.compareSelections.delete(player.playerId);
  } else {
    const existing = Array.from(state.compareSelections.values());
    const isGoalie = player.pos === 'G';
    // Comparing a skater against a goalie wouldn't mean anything (totally
    // different stat categories) — starting a new pick in the other mode
    // just replaces whatever was selected instead of erroring.
    if (existing.length && (existing[0].pos === 'G') !== isGoalie) {
      state.compareSelections.clear();
    } else if (state.compareSelections.size >= 2) {
      // Already have 2 — bump the oldest pick (Maps preserve insertion order).
      state.compareSelections.delete(state.compareSelections.keys().next().value);
    }
    state.compareSelections.set(player.playerId, player);
  }
  updateCompareBar();
  render(false);
}

function updateCompareBar() {
  const n = state.compareSelections.size;
  el.compareBar.hidden = n === 0;
  if (n === 0) return;
  const names = Array.from(state.compareSelections.values()).map((p) => p.name);
  el.compareBarText.textContent = n === 1
    ? `${names[0]} — pick one more player to compare`
    : `${names[0]} vs ${names[1]}`;
  el.compareBtn.disabled = n !== 2;
}

el.compareClearBtn.addEventListener('click', () => {
  state.compareSelections.clear();
  updateCompareBar();
  render(false);
});

el.compareBtn.addEventListener('click', () => {
  const [a, b] = Array.from(state.compareSelections.values());
  if (a && b) openCompareModal(a, b);
});

// closeCompareModal/statsWindowFor/openCompareModal/renderCompareTable
// and the rest of the "Stats windows" machinery all now live in the
// shared player-modal.js (loaded before this file) — its
// openCompareModal(a, b) is what el.compareBtn's click handler below
// calls, and it wires its own compareModalClose/compareModalOverlay/
// Escape listeners once at load time.

el.modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode;
    el.modeButtons.forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    // Position (C/W/D) filter is skater-only.
    el.posToggleGroup.hidden = state.mode === 'goalies';
    state.pos = 'ALL';
    el.posButtons.forEach((b) => b.classList.toggle('active', b.dataset.pos === 'ALL'));
    updateEligibilityNote();
    render(true);
  });
});

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
  updateEligibilityNote();
  render(true);
});

wireDataBar(init, (err) => showBanner(`Couldn't retrieve latest stats (${err.message}).`));

init();
