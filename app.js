'use strict';

/* ======================================================================
   NHL Player Stats — vanilla JS app.
   Data comes from the unofficial NHL APIs (api-web.nhle.com and
   api.nhle.com/stats/rest), proxied because the NHL API does not send
   CORS headers for direct browser fetches. Reference:
   https://github.com/Zmalski/NHL-API-Reference

   Which stat columns are shown is user-configurable on admin.html and
   read here via columns.js (loadColumnConfig / SKATER_COLUMNS / etc).
   Fetching/normalizing the underlying NHL data lives in data.js, shared
   with cards.js so both pages agree on what a "skater" looks like.
   ====================================================================== */

const el = {
  seasonLabel: document.getElementById('seasonLabel'),
  modeButtons: Array.from(document.querySelectorAll('.toggle-btn[data-mode]')),
  posToggleGroup: document.getElementById('posToggleGroup'),
  posButtons: Array.from(document.querySelectorAll('.toggle-btn[data-pos]')),
  seasonTabGroup: document.getElementById('seasonTabGroup'),
  statsContent: document.getElementById('statsContent'),
  currentPlaceholder: document.getElementById('currentPlaceholder'),
  statsListArea: document.getElementById('statsListArea'),
  statModeButtons: Array.from(document.querySelectorAll('.toggle-btn[data-statmode]')),
  qualifiedToggleBtn: document.getElementById('qualifiedToggleBtn'),
  teamSelect: document.getElementById('teamSelect'),
  searchInput: document.getElementById('searchInput'),
  statusBanner: document.getElementById('statusBanner'),
  skeleton: document.getElementById('skeleton'),
  skatersTable: document.getElementById('skatersTable'),
  skatersHeadRow: document.getElementById('skatersHeadRow'),
  skatersBody: document.getElementById('skatersBody'),
  goaliesTable: document.getElementById('goaliesTable'),
  goaliesHeadRow: document.getElementById('goaliesHeadRow'),
  goaliesBody: document.getElementById('goaliesBody'),
  emptyState: document.getElementById('emptyState'),
  resultCount: document.getElementById('resultCount'),
  modalRoot: document.getElementById('modalRoot'),
  modalOverlay: document.getElementById('modalOverlay'),
  modalClose: document.getElementById('modalClose'),
  modalContent: document.getElementById('modalContent'),
};

// Fixed season tabs — hardcoded rather than derived from whatever
// /v1/standings/now currently calls "current" (state.seasonId below),
// which is what caused the old Historical/Current toggle's rollover
// bug: the NHL API can flip state.seasonId over to the new season
// before (or well after) that season actually has any games, and the
// old code used state.seasonId itself to decide what counted as
// "historical" vs "current." Update these 3 ids once a year.
const STATS_SEASON_TABS = [
  { key: 'hist2024', seasonId: 20242025, label: '2024–25' },
  { key: 'hist2025', seasonId: 20252026, label: '2025–26' },
  { key: 'current', seasonId: 20262027, label: 'Current 2026–27' },
  { key: 'projected', seasonId: 20262027, label: 'Projected 2026–27' },
];

const state = {
  mode: 'skaters',
  team: 'ALL',
  pos: 'ALL',
  search: '',
  seasonId: null,          // the CURRENT (live) season, as the NHL API sees it right now — only used for things that genuinely need "whatever's live" (the Rating Trend chart, the Compare search pool); the Stats page's own tabs use STATS_SEASON_TABS's fixed ids instead, not this
  tabKey: null,            // null (nothing loaded yet) | one of STATS_SEASON_TABS's keys
  currentIsLive: false,    // true once the Current tab's season has any real recorded games — set by loadCurrentTab()
  seasonDataCache: new Map(), // seasonId (or a synthetic string key for the current-season view) -> { skaters, goalies } raw totals — avoids refetching something already looked at
  statMode: 'total',       // 'total' | 'perGame' — see applyStatMode()
  qualifiedOnly: false,    // when true, hide players under MIN_GAMES_PLAYED (ratings.js) games played
  ratingConfig: null,      // admin-tuned RatingSettings override (public-config.js) for the Power Ranking column — null falls back to ratings.js's own defaults
  teamMeta: new Map(),   // abbrev -> { name, logo, conference, division }
  rawSkaters: [],  // selected season's totals, as fetched — untouched by statMode
  rawGoalies: [],
  skaters: [],     // DERIVED from raw* + statMode (applyStatMode()) — what render/sort/filter actually use
  goalies: [],
  ratedSkatersById: new Map(), // playerId -> raw-totals rated player (ratedPoolFor()) — what row clicks hand to the shared player-modal.js, never the possibly-per-game-divided state.skaters row itself
  ratedGoaliesById: new Map(),
  currentSeasonRatedSkaters: [], // state.seasonId's own rated pool, fixed regardless of which season tab is showing — feeds player-modal.js's Rating Trend "Live" point
  currentSeasonRatedGoalies: [],
  columns: loadColumnConfig(), // { skaters: [...ids], goalies: [...ids] } — see columns.js
  sort: {
    skaters: { key: 'goals', dir: 'desc' },
    goalies: { key: 'wins', dir: 'desc' },
  },
};

// The shared player-modal.js's Rating Trend chart's "Historical" tab
// walks exactly 3 seasons — 2023-24 through 2025-26 as of the 2025-26
// season, and shifts forward one season each year after, since it's
// computed off state.seasonId (whatever's actually live right now)
// rather than hardcoded — independent of the Stats page's own fixed
// STATS_SEASON_TABS above. Newest -> oldest.
function trendHistoricalSeasonIds() {
  return [state.seasonId, state.seasonId - 10001, state.seasonId - 20002];
}

/* ---------------------------- helpers ---------------------------- */
/* getJSON / escapeHtml / lastTeam / seasonLabel / loadSeasonData all come
   from data.js (loaded before this file). */

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Active columns for a mode, in catalog order. Power Ranking ("overall")
 *  is forced on for the Current/Projected tabs regardless of the
 *  admin's column picker — the whole point of those 2 tabs is to read
 *  power-ranking-first — while the historical tabs keep respecting
 *  whatever's configured. */
function activeColumns(mode) {
  const selected = new Set(state.columns[mode] || []);
  if (state.tabKey === 'current' || state.tabKey === 'projected') selected.add('overall');
  return columnCatalog(mode).filter((c) => selected.has(c.id));
}

/** Maps a raw position code (C/L/R/D) to the C/W/D filter groups above
 *  the table (L and R share "W") — small local copy of ratings.js's
 *  positionGroup(), since ratings.js isn't loaded on this page. */
function positionGroup(pos) {
  if (pos === 'D') return 'D';
  if (pos === 'C') return 'C';
  return 'W'; // L, R
}

/* ------------------------ season + stat mode ------------------------ */

/** Fetches (or reuses a cached copy of) `seasonId`'s totals and makes it
 *  the selected season — mirrors cards.js's loadAndRateSeason() minus
 *  the rating pass (this page shows raw/derived stats, not percentiles).
 *  No network call if already cached (covers both "switch back to a
 *  season you already viewed" and "the current season, already fetched
 *  by loadSeasonData() in init()"). */
async function loadStatsForSeason(seasonId) {
  let raw = state.seasonDataCache.get(seasonId);
  if (!raw) {
    const data = await loadSeasonStatsFor(seasonId, state.teamMeta);
    raw = { skaters: data.skaters, goalies: data.goalies };
    state.seasonDataCache.set(seasonId, raw);
  }
  state.rawSkaters = raw.skaters;
  state.rawGoalies = raw.goalies;
  applyStatMode();
}

/** Divides every plain counting stat (no `fmt` on its column def, i.e.
 *  not already a rate like SH%/GAA/SV%) by games played. Columns that
 *  are already a rate, and Games Played itself (which would trivially
 *  become 1 for everyone), are left untouched. Recomputed from the
 *  untouched raw* arrays each time — never divides an already-divided
 *  value. */
function toPerGame(list, catalog) {
  if (state.statMode !== 'perGame') return list;
  return list.map((p) => {
    const gp = p.gamesPlayed || 0;
    const out = { ...p };
    for (const col of catalog) {
      if (col.fmt || col.id === 'gamesPlayed' || col.synthetic) continue;
      out[col.id] = gp > 0 ? p[col.id] / gp : 0;
    }
    return out;
  });
}

/** Computes the Power Ranking ("overall") column via ratings.js's
 *  ratePool() — the exact same percentile-blend engine Player Ratings
 *  cards use, admin-tunable under Admin -> Rating Methodology
 *  (state.ratingConfig, fetched once in init()). Always computed from
 *  RAW totals (ratePool's documented convention), never the
 *  per-game-divided view — this is also exactly why the returned Map
 *  (not the possibly-per-game-divided table row) is what gets passed to
 *  the shared player-modal.js on row click (see openModalForPlayer()):
 *  passing a per-game-divided row straight into the modal would feed
 *  its own "current season" stats window fractional per-game numbers as
 *  if they were season totals. Always computed now, not just when the
 *  PWR column happens to be displayed — the modal needs .overall/
 *  .ratings for every clickable row regardless of whether that column
 *  is currently visible. Confirmed cheap enough for the whole
 *  ~700-player pool elsewhere in this codebase. */
function ratedPoolFor(rawList, mode) {
  // Same eligibility pre-filter cards.js applies before rating — not
  // just to avoid a misleadingly extreme percentile for a 1-game
  // callup, but because a long tail of near-zero-total depth players
  // in the pool compresses the percentile range for everyone else.
  // Ineligible players just show "—" (formatStatValue's null check,
  // and buildCard()'s own null-safe OVR badge) rather than a
  // real-looking-but-meaningless number.
  const minGp = mode === 'goalies'
    ? (state.ratingConfig?.minGamesPlayedGoalies ?? MIN_GAMES_PLAYED_GOALIES)
    : (state.ratingConfig?.minGamesPlayedSkaters ?? MIN_GAMES_PLAYED_SKATERS);
  const eligible = rawList.filter((p) => p.gamesPlayed >= minGp);
  const rated = ratePool(eligible, mode, state.ratingConfig); // ratings.js
  return new Map(rated.map((p) => [p.playerId, p]));
}

/** Merges .overall/.ratings from `ratedById` (see ratedPoolFor() above)
 *  onto `displayList` by playerId — safe regardless of whether
 *  `displayList` is the raw or per-game-divided view, since only the
 *  identity-keyed lookup values (never displayList's own fields) feed
 *  the merged rating data. */
function attachPowerRankings(displayList, ratedById) {
  return displayList.map((p) => {
    const r = ratedById.get(p.playerId);
    return { ...p, overall: r?.overall ?? null, ratings: r?.ratings ?? [] };
  });
}

function applyStatMode() {
  // Kept separately (raw-totals, never per-game-divided) so row clicks
  // can hand the shared player-modal.js a player object it can safely
  // treat as season totals — see ratedPoolFor()'s doc comment.
  state.ratedSkatersById = ratedPoolFor(state.rawSkaters, 'skaters');
  state.ratedGoaliesById = ratedPoolFor(state.rawGoalies, 'goalies');
  state.skaters = attachPowerRankings(toPerGame(state.rawSkaters, SKATER_COLUMNS), state.ratedSkatersById);
  state.goalies = attachPowerRankings(toPerGame(state.rawGoalies, GOALIE_COLUMNS), state.ratedGoaliesById);
}

/** Same as columns.js's formatColumnValue(), except a per-game counting
 *  stat gets a fixed 2-decimal display (formatColumnValue's default
 *  String(n) would otherwise show a long division result like
 *  0.8181818181818182). Rate columns and Games Played are unaffected —
 *  same values in both stat modes, so they format the same way too. */
function formatStatValue(col, value) {
  if (value == null) return '—'; // Power Ranking before it's computed, or a player ratePool() didn't rate (shouldn't normally happen, but don't show "0")
  if (state.statMode === 'perGame' && !col.fmt && col.id !== 'gamesPlayed' && !col.synthetic) {
    return (typeof value === 'number' ? value : Number(value) || 0).toFixed(2);
  }
  return formatColumnValue(col, value);
}

/** Builds the 4 fixed season tabs (STATS_SEASON_TABS) — static in
 *  content (unlike the old dynamic Historical/Current picker), but
 *  still built here rather than in markup so the click handlers have
 *  somewhere to attach. */
function populateSeasonTabGroup() {
  el.seasonTabGroup.innerHTML = '';
  for (const tab of STATS_SEASON_TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle-btn';
    btn.setAttribute('role', 'tab');
    btn.dataset.tabKey = tab.key;
    btn.textContent = tab.label;
    btn.addEventListener('click', () => selectTab(tab.key));
    el.seasonTabGroup.appendChild(btn);
  }
}

function selectTab(tabKey) {
  if (state.tabKey === tabKey) return;
  activateView(tabKey);
}

/** Fetches the 4 historical seasons + bio pool + admin settings that
 *  both projection modes below need — the shared setup step, not a
 *  projection itself. */
async function loadProjectionInputs(seasonId) {
  const histIds = historicalSeasonIds(seasonId); // projections.js — 4 seasons immediately before `seasonId`
  const historicalData = await Promise.all(histIds.map(async (histId) => {
    let cached = state.seasonDataCache.get(histId);
    if (!cached) {
      const data = await loadSeasonStatsFor(histId, state.teamMeta);
      cached = { skaters: data.skaters, goalies: data.goalies };
      state.seasonDataCache.set(histId, cached);
    }
    const toiByPlayer = await loadSkaterTimeOnIce(histId);
    return { seasonId: histId, skaters: cached.skaters, goalies: cached.goalies, toiByPlayer };
  }));
  const [bioPool, configRes] = await Promise.all([
    loadPlayerBioPool(state.teamMeta),
    fetch(`/api/fantasy/public-config?season=${encodeURIComponent(seasonLabel(seasonId))}`).then((r) => r.json()),
  ]);
  if (!configRes.ok) throw new Error(configRes.message || 'could not load projection settings');
  return { historicalData, bioPool, deployment: configRes.deployment, settings: configRes.settings };
}

/** The "Current 2026–27" tab: plain real totals for the season, no
 *  projection at all — a placeholder until it has any recorded games.
 *  Sets state.currentIsLive so updateSeasonLabel()/
 *  syncControlVisibility() know whether to show that placeholder. */
async function loadCurrentTab(seasonId) {
  let raw = state.seasonDataCache.get(seasonId);
  if (!raw) {
    const data = await loadSeasonStatsFor(seasonId, state.teamMeta);
    raw = { skaters: data.skaters, goalies: data.goalies };
    state.seasonDataCache.set(seasonId, raw);
  }
  state.currentIsLive = raw.skaters.length > 0;
  state.rawSkaters = raw.skaters;
  state.rawGoalies = raw.goalies;
  applyStatMode();
}

/** The "Projected 2026–27" tab: once the season has any real recorded
 *  games, a live rest-of-season blend (buildRestOfSeasonProjection(),
 *  projections.js — real results so far + a modeled rate, including
 *  the 3-season-%-games-played-extrapolated-to-84 remaining-games
 *  figure, for the rest — updates as more games are played); before
 *  that, the preseason age-curve model (buildProjectedSeason()) so
 *  there's still something useful to show. */
async function loadProjectedTab(seasonId) {
  const cacheKey = `projected:${seasonId}`;
  let raw = state.seasonDataCache.get(cacheKey);
  if (!raw) {
    let currentRaw = state.seasonDataCache.get(seasonId);
    if (!currentRaw) {
      const data = await loadSeasonStatsFor(seasonId, state.teamMeta);
      currentRaw = { skaters: data.skaters, goalies: data.goalies };
      state.seasonDataCache.set(seasonId, currentRaw);
    }
    const isLive = currentRaw.skaters.length > 0; // has the season actually started yet?
    const { historicalData, bioPool, deployment, settings } = await loadProjectionInputs(seasonId);
    const built = isLive
      ? buildRestOfSeasonProjection({ // projections.js
        currentSeasonId: seasonId, currentRaw, historicalData, bioPool, teamMeta: state.teamMeta, deployment, settings,
      })
      : buildProjectedSeason({ // projections.js
        projectedSeasonId: seasonId, historicalData, bioPool, teamMeta: state.teamMeta, deployment, settings,
      });
    raw = { skaters: built.skaters, goalies: built.goalies };
    state.seasonDataCache.set(cacheKey, raw);
  }
  state.rawSkaters = raw.skaters;
  state.rawGoalies = raw.goalies;
  // Projections are meant to be read power-ranking-first — default to
  // sorting by it every time this tab loads (falls back gracefully via
  // ensureValidSort() in activateView() if 'overall' somehow isn't an
  // active column). A manual header click still overrides this for the
  // rest of that visit, same as any other sort.
  state.sort.skaters = { key: 'overall', dir: 'desc' };
  state.sort.goalies = { key: 'overall', dir: 'desc' };
  applyStatMode();
}

/** The one loader dispatch for whichever tab is active. */
async function loadForTab(tabKey) {
  const tab = STATS_SEASON_TABS.find((t) => t.key === tabKey);
  if (tabKey === 'projected') await loadProjectedTab(tab.seasonId);
  else if (tabKey === 'current') await loadCurrentTab(tab.seasonId);
  else await loadStatsForSeason(tab.seasonId);
}

/** Central dispatch for the season tab bar — sets state, loads the
 *  right data, and refreshes every dependent bit of UI (control
 *  visibility/active states, the header label, sort validity, the
 *  table itself). */
async function activateView(tabKey) {
  el.statsContent.hidden = false; // reveal search/filters/table on the first pick — stays visible from here on
  toggleSkeleton(true);
  hideBanner();
  try {
    state.tabKey = tabKey;
    await loadForTab(tabKey);
    syncControlVisibility();
    updateActiveStates();
    updateSeasonLabel();
    ensureValidSort();
    renderTableHeaders(); // active columns depend on state.tabKey (PWR forced on Current/Projected) — rebuild every switch, not just at init
    render();
  } catch (err) {
    showBanner(`Couldn't load stats (${err.message}).`);
  } finally {
    toggleSkeleton(false);
  }
}

function syncControlVisibility() {
  // The Current tab, before the season has any real games, shows a
  // placeholder instead of the search/filters/table — nothing to look
  // through yet. The historical tabs and the Projected tab (which
  // falls back to the preseason model) always have data.
  const showPlaceholder = state.tabKey === 'current' && !state.currentIsLive;
  el.currentPlaceholder.hidden = !showPlaceholder;
  el.statsListArea.hidden = showPlaceholder;
}

function updateActiveStates() {
  el.seasonTabGroup.querySelectorAll('.toggle-btn').forEach((b) => {
    const active = b.dataset.tabKey === state.tabKey;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function updateSeasonLabel() {
  const statModeLabel = state.statMode === 'perGame' ? 'Per Game' : 'Total';
  const tab = STATS_SEASON_TABS.find((t) => t.key === state.tabKey);

  if (state.tabKey === 'projected') {
    el.seasonLabel.textContent = `${tab.label} · ${statModeLabel} — real results so far blended with a modeled rate for the rest of the season; each player's remaining games are their own 3-season average of % of games played, extrapolated to an ${SEASON_GAME_COUNT}-game season. Updates as more games are played. Tune under Admin → Projections.`;
    return;
  }
  if (state.tabKey === 'current') {
    el.seasonLabel.textContent = state.currentIsLive
      ? `${tab.label} · Regular Season stats · ${statModeLabel}`
      : `${tab.label} — hasn't started yet. Stats will appear here automatically once real games are played.`;
    return;
  }
  el.seasonLabel.textContent = `${tab.label} (Historical) · Regular Season stats · ${statModeLabel}`;
}

/* ------------------------------ init ------------------------------ */

async function init() {
  hideBanner();
  await snapshotsReady; // snapshots.js — the shared player-modal.js's Rating Trend chart reads snapshot history
  // Admin-tuned rating weights for the Power Ranking column (Admin ->
  // Rating Methodology) — null (fetch failure, or nothing saved yet)
  // falls back to ratings.js's own hardcoded defaults. Fetched once
  // here rather than per-view since it applies identically everywhere.
  state.ratingConfig = await fetch('/api/fantasy/public-config')
    .then((r) => r.json()).then((d) => (d.ok ? d.ratingSettings : null)).catch(() => null);
  try {
    const { seasonId, teamMeta, skaters, goalies } = await loadSeasonData(); // data.js
    state.seasonId = seasonId;
    state.teamMeta = teamMeta;
    state.seasonDataCache.set(seasonId, { skaters, goalies });

    populateTeamSelect();
    populateSeasonTabGroup();
    renderTableHeaders();

    // state.seasonId's own rated pool, fixed regardless of which
    // season tab ends up displayed below — feeds the shared
    // player-modal.js's Rating Trend "Live" point and its in-modal
    // Compare search pool. Computed once here, not per-tab.
    const skRatedById = ratedPoolFor(skaters, 'skaters');
    const goRatedById = ratedPoolFor(goalies, 'goalies');
    state.currentSeasonRatedSkaters = Array.from(skRatedById.values());
    state.currentSeasonRatedGoalies = Array.from(goRatedById.values());
    initPlayerModal({ // player-modal.js
      teamMeta: state.teamMeta,
      seasonId: state.seasonId,
      ratingConfig: state.ratingConfig,
      seasonDataCache: state.seasonDataCache,
      currentSeasonRatedSkaters: state.currentSeasonRatedSkaters,
      currentSeasonRatedGoalies: state.currentSeasonRatedGoalies,
      historicalSeasonIds: trendHistoricalSeasonIds(),
      searchPool: [...state.currentSeasonRatedSkaters, ...state.currentSeasonRatedGoalies],
    });

    await activateView('current'); // land straight on the Current tab — no more pick-a-card landing step
  } catch (err) {
    showBanner(`Couldn't load NHL data (${err.message}). Make sure the local server is running, then retry.`);
  }
}

function populateTeamSelect() {
  const teams = Array.from(state.teamMeta.entries())
    .sort((a, b) => a[1].name.localeCompare(b[1].name));
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

/* ---------------------------- rendering ---------------------------- */

function toggleSkeleton(show) {
  el.skeleton.hidden = !show;
  el.skatersTable.hidden = show || state.mode !== 'skaters';
  el.goaliesTable.hidden = show || state.mode !== 'goalies';
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

function hideBanner() {
  el.statusBanner.hidden = true;
  el.statusBanner.innerHTML = '';
}

/** If the active sort key isn't a displayed column anymore, fall back to the first active one. */
function ensureValidSort() {
  for (const mode of ['skaters', 'goalies']) {
    const cur = state.sort[mode];
    const validKeys = new Set(['name', 'team', ...activeColumns(mode).map((c) => c.id)]);
    if (!validKeys.has(cur.key)) {
      const first = activeColumns(mode)[0];
      state.sort[mode] = first ? { key: first.id, dir: 'desc' } : { key: 'name', dir: 'asc' };
    }
  }
}

/** (Re)builds the <thead> stat columns for both tables from the active config. */
function renderTableHeaders() {
  for (const mode of ['skaters', 'goalies']) {
    const row = mode === 'skaters' ? el.skatersHeadRow : el.goaliesHeadRow;
    // Remove any previously-generated stat <th> (keep the first 3 fixed columns: #, Player, Team).
    while (row.children.length > 3) row.removeChild(row.lastChild);
    for (const col of activeColumns(mode)) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.className = 'sortable is-numeric';
      th.dataset.key = col.id;
      th.dataset.type = 'number';
      const perGame = state.statMode === 'perGame' && !col.fmt && col.id !== 'gamesPlayed' && !col.synthetic;
      th.title = perGame ? `${col.label} per game` : col.label;
      th.textContent = col.short;
      th.addEventListener('click', () => onSortClick(mode, col.id, 'number'));
      row.appendChild(th);
    }
  }
  wireFixedSortHeaders();
  updateSortHeaders();
}

function wireFixedSortHeaders() {
  document.querySelectorAll('th.sortable[data-key="name"], th.sortable[data-key="team"]').forEach((th) => {
    if (th.dataset.wired) return;
    th.dataset.wired = '1';
    const table = th.closest('table');
    const mode = table === el.skatersTable ? 'skaters' : 'goalies';
    th.addEventListener('click', () => onSortClick(mode, th.dataset.key, th.dataset.type));
  });
}

function onSortClick(mode, key, type) {
  const cur = state.sort[mode];
  if (cur.key === key) {
    cur.dir = cur.dir === 'asc' ? 'desc' : 'asc';
  } else {
    cur.key = key;
    cur.dir = type === 'number' ? 'desc' : 'asc';
  }
  if (mode === state.mode) render();
}

function getFiltered() {
  const list = state.mode === 'skaters' ? state.skaters : state.goalies;
  const q = state.search.trim().toLowerCase();
  // Same eligibility rule Player Ratings uses (MIN_GAMES_PLAYED_SKATERS/
  // GOALIES, from ratings.js) — a flat count, not scaled to the season
  // length. gamesPlayed itself is untouched by Per-Game mode (see
  // toPerGame()), so this works in either stat mode.
  const minGP = state.qualifiedOnly
    ? (state.mode === 'goalies'
      ? (state.ratingConfig?.minGamesPlayedGoalies ?? MIN_GAMES_PLAYED_GOALIES)
      : (state.ratingConfig?.minGamesPlayedSkaters ?? MIN_GAMES_PLAYED_SKATERS))
    : 0;
  return list.filter((p) => {
    // Compare against the player's current team only (same value shown in the
    // Team column), so the filter never shows someone under a team other than
    // the one displayed — even if they were traded mid-season.
    if (state.team !== 'ALL' && p.team !== state.team) return false;
    if (state.mode === 'skaters' && state.pos !== 'ALL' && positionGroup(p.pos) !== state.pos) return false;
    if (q && !p.name.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q)) return false;
    if (p.gamesPlayed < minGP) return false;
    return true;
  });
}

function sortList(list) {
  const { key, dir } = state.sort[state.mode];
  const mul = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'string') return av.localeCompare(bv) * mul;
    return ((av ?? 0) - (bv ?? 0)) * mul;
  });
}

function teamCell(abbrev) {
  const wrap = document.createElement('div');
  wrap.className = 'team-cell';
  const meta = state.teamMeta.get(abbrev);
  if (meta?.logo) {
    const img = document.createElement('img');
    img.className = 'team-logo';
    img.src = meta.logo;
    img.alt = '';
    img.loading = 'lazy';
    wrap.appendChild(img);
  }
  const span = document.createElement('span');
  span.textContent = abbrev || '—';
  wrap.appendChild(span);
  return wrap;
}

function playerCell(p) {
  const wrap = document.createElement('div');
  wrap.className = 'player-cell';
  const img = document.createElement('img');
  img.className = 'headshot';
  img.src = `https://assets.nhle.com/mugs/nhl/latest/${p.playerId}.png`;
  img.alt = '';
  img.loading = 'lazy';
  img.onerror = () => { img.removeAttribute('src'); };
  const nameWrap = document.createElement('div');
  nameWrap.className = 'player-name-wrap';
  const name = document.createElement('span');
  name.className = 'player-name';
  name.textContent = p.name;
  nameWrap.appendChild(name);
  if (p.pos && p.pos !== 'G') {
    const badge = document.createElement('span');
    badge.className = 'pos-badge';
    badge.dataset.pos = p.pos === 'D' ? 'D' : 'F';
    badge.textContent = p.pos;
    nameWrap.appendChild(badge);
  }
  wrap.append(img, nameWrap);
  return wrap;
}

function statCell(p, col) {
  const td = document.createElement('td');
  td.className = 'is-numeric stat-num';
  td.textContent = formatStatValue(col, p[col.id]);
  return td;
}

function buildRow(p, rank, cols) {
  const tr = document.createElement('tr');
  tr.tabIndex = 0;
  tr.setAttribute('role', 'button');

  const rankTd = document.createElement('td');
  rankTd.className = 'col-rank';
  rankTd.textContent = rank;

  const playerTd = document.createElement('td');
  playerTd.appendChild(playerCell(p));

  const teamTd = document.createElement('td');
  teamTd.appendChild(teamCell(p.team));

  tr.append(rankTd, playerTd, teamTd);
  for (const col of cols) tr.appendChild(statCell(p, col));

  tr.addEventListener('click', () => openModalForPlayer(p));
  tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModalForPlayer(p); } });
  return tr;
}

/** Looks up `p`'s raw-totals rated counterpart (ratedPoolFor(), never
 *  the row's own possibly-per-game-divided fields) and hands THAT to
 *  the shared player-modal.js — see attachPowerRankings()'s doc
 *  comment for why this indirection matters. Falls back to `p` itself
 *  in the (should-never-happen) case the lookup misses. */
function openModalForPlayer(p) {
  const ratedById = state.mode === 'goalies' ? state.ratedGoaliesById : state.ratedSkatersById;
  openPlayerModal(ratedById.get(p.playerId) || p); // openPlayerModal() — player-modal.js
}

function render() {
  const filtered = sortList(getFiltered());
  const cols = activeColumns(state.mode);
  const tbody = state.mode === 'skaters' ? el.skatersBody : el.goaliesBody;
  const frag = document.createDocumentFragment();
  filtered.forEach((p, i) => frag.appendChild(buildRow(p, i + 1, cols)));
  tbody.innerHTML = '';
  tbody.appendChild(frag);

  el.skatersTable.hidden = state.mode !== 'skaters';
  el.goaliesTable.hidden = state.mode !== 'goalies';
  el.emptyState.hidden = filtered.length !== 0;

  const teamSuffix = state.team !== 'ALL' ? ` · ${state.team}` : '';
  el.resultCount.textContent = `${filtered.length.toLocaleString()} ${state.mode}${teamSuffix}`;
  updateSortHeaders();
}

function updateSortHeaders() {
  const table = state.mode === 'skaters' ? el.skatersTable : el.goaliesTable;
  const { key, dir } = state.sort[state.mode];
  table.querySelectorAll('th.sortable').forEach((th) => {
    if (th.dataset.key === key) th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  });
}

/* ---------------------------- event wiring ---------------------------- */

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
    render();
  });
});

el.posButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.pos = btn.dataset.pos;
    el.posButtons.forEach((b) => b.classList.toggle('active', b === btn));
    render();
  });
});

el.statModeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.statMode = btn.dataset.statmode;
    el.statModeButtons.forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    applyStatMode();
    updateSeasonLabel();
    renderTableHeaders(); // header tooltips ("X per game") depend on stat mode
    render();
  });
});

el.qualifiedToggleBtn.addEventListener('click', () => {
  state.qualifiedOnly = !state.qualifiedOnly;
  el.qualifiedToggleBtn.classList.toggle('active', state.qualifiedOnly);
  el.qualifiedToggleBtn.setAttribute('aria-selected', state.qualifiedOnly ? 'true' : 'false');
  render();
});

el.teamSelect.addEventListener('change', () => {
  state.team = el.teamSelect.value;
  render();
});

el.searchInput.addEventListener('input', debounce(() => {
  state.search = el.searchInput.value;
  render();
}, 150));

// modalClose/modalOverlay/Escape are wired by the shared player-modal.js
// (loaded before this file) — it owns the modal now, see openModalForPlayer().

// Pick up column-selection changes saved from admin.html in another tab.
window.addEventListener('storage', (e) => {
  if (e.key !== COLUMN_STORAGE_KEY) return;
  state.columns = loadColumnConfig();
  applyStatMode(); // re-derive — Power Ranking may have just been turned on/off
  ensureValidSort();
  renderTableHeaders();
  render();
});

init();
