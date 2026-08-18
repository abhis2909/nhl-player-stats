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
  periodButtons: Array.from(document.querySelectorAll('.period-card[data-period]')),
  historicalCardDesc: document.getElementById('historicalCardDesc'),
  statsContent: document.getElementById('statsContent'),
  currentPlaceholder: document.getElementById('currentPlaceholder'),
  statsListArea: document.getElementById('statsListArea'),
  historicalSeasonGroup: document.getElementById('historicalSeasonGroup'),
  currentSeasonSubGroup: document.getElementById('currentSeasonSubGroup'),
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

const state = {
  mode: 'skaters',
  team: 'ALL',
  pos: 'ALL',
  search: '',
  seasonId: null,          // the CURRENT (live) season, as the NHL API sees it right now — treated as historical (the season has effectively been played)
  period: null,            // null (nothing picked yet, landing state) | 'historical' | 'current' — the whole toggle
  historicalSeasonId: null, // whichever of the 2 historical seasons is showing, when period === 'historical'
  currentSubView: null,    // null (not entered yet) | 'live' | 'projected' — which of Current Season's 2 sub-tabs is showing; defaulted once via defaultCurrentSubView() the first time period becomes 'current'
  currentIsLive: false,    // true once the upcoming season has any real recorded games — set by loadCurrentSeasonView()
  seasonDataCache: new Map(), // seasonId (or a synthetic string key for the current-season view) -> { skaters, goalies } raw totals — avoids refetching something already looked at
  statMode: 'total',       // 'total' | 'perGame' — see applyStatMode()
  qualifiedOnly: false,    // when true, hide players under MIN_GP_FRACTION (ratings.js) of the pool's max games played
  ratingConfig: null,      // admin-tuned RatingSettings override (public-config.js) for the Power Ranking column — null falls back to ratings.js's own defaults
  teamMeta: new Map(),   // abbrev -> { name, logo, conference, division }
  rawSkaters: [],  // selected season's totals, as fetched — untouched by statMode
  rawGoalies: [],
  skaters: [],     // DERIVED from raw* + statMode (applyStatMode()) — what render/sort/filter actually use
  goalies: [],
  columns: loadColumnConfig(), // { skaters: [...ids], goalies: [...ids] } — see columns.js
  sort: {
    skaters: { key: 'goals', dir: 'desc' },
    goalies: { key: 'wins', dir: 'desc' },
  },
};

// Historical is kept to exactly the 2 most recent completed seasons —
// state.seasonId itself (the last season the NHL API has a full
// complement of games for) and the one before it. NHL season ids follow
// a YYYYYYYY+1 pattern, so stepping back one season is always -10001.
function historicalSeasonIdsUI() {
  return [state.seasonId, state.seasonId - 10001]; // newest -> oldest
}

// The season one ahead of "current" — the Current Season view's target,
// shown as a preseason projection until it has real games (see
// loadCurrentSeasonView()), then as a live rest-of-season blend. Its
// historical inputs (the 4 seasons feeding either version) are computed
// by projections.js's historicalSeasonIds(), independently of this.
//
// CAVEAT worth knowing if this ever looks wrong right at a season
// rollover: this is always state.seasonId + 1, and state.seasonId is
// itself whatever /v1/standings/now currently calls "current" — if the
// NHL API ever flips state.seasonId over to the new season BEFORE (or
// well after) that season's stats actually start populating, there
// could be a short mismatched window. Not observable until an actual
// rollover happens; revisit if it ever looks off then.
function upcomingSeasonId() {
  return state.seasonId + 10001;
}

// Which Current Season sub-tab to land on the FIRST time it's opened
// this page-load — 'projected' (the preseason model) up through
// September 30th of the season's start year, since real games aren't
// underway yet and the projection is the only useful view; 'live'
// (the placeholder-or-blended view) from October 1st on. Purely an
// initial default — the user can freely switch tabs afterward, and that
// choice sticks (state.currentSubView) rather than re-defaulting.
function defaultCurrentSubView(seasonId) {
  const startYear = Number(String(seasonId).slice(0, 4));
  const cutoff = new Date(startYear, 8, 30, 23, 59, 59); // Sept 30, local time
  return new Date() <= cutoff ? 'projected' : 'live';
}

/* ---------------------------- helpers ---------------------------- */
/* getJSON / escapeHtml / lastTeam / seasonLabel / loadSeasonData all come
   from data.js (loaded before this file). */

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Active columns for a mode, in catalog order. */
function activeColumns(mode) {
  const selected = new Set(state.columns[mode] || []);
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
 *  (state.ratingConfig, fetched once in init()) — and merges the result
 *  onto `list` by playerId. Always computed from RAW totals (ratePool's
 *  documented convention), never the per-game-divided view — so this
 *  runs on state.raw* before toPerGame(), and the merge-on step after
 *  is keyed by playerId rather than array position so it's correct
 *  regardless of stat mode. Skipped entirely (cheap early-out) unless
 *  the "overall" column is actually enabled — no reason to pay for an
 *  extra O(n) ratePool() pass otherwise. */
function attachPowerRankings(rawList, displayList, mode) {
  if (!state.columns[mode]?.includes('overall')) return displayList;
  // Same eligibility pre-filter cards.js applies before rating — not
  // just to avoid a misleadingly extreme percentile for a 1-game
  // callup, but because a long tail of near-zero-total depth players
  // in the pool compresses the percentile range for everyone else.
  // Ineligible players just show "—" (formatStatValue's null check)
  // rather than a real-looking-but-meaningless number.
  const minGpFraction = state.ratingConfig?.minGpFraction ?? MIN_GP_FRACTION;
  const minGp = Math.ceil(seasonGameCount(rawList) * minGpFraction);
  const eligible = rawList.filter((p) => p.gamesPlayed >= minGp);
  const rated = ratePool(eligible, mode, state.ratingConfig); // ratings.js
  const overallById = new Map(rated.map((p) => [p.playerId, p.overall]));
  return displayList.map((p) => ({ ...p, overall: overallById.get(p.playerId) ?? null }));
}

function applyStatMode() {
  state.skaters = attachPowerRankings(state.rawSkaters, toPerGame(state.rawSkaters, SKATER_COLUMNS), 'skaters');
  state.goalies = attachPowerRankings(state.rawGoalies, toPerGame(state.rawGoalies, GOALIE_COLUMNS), 'goalies');
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

/** Rebuilds the Historical season picker (current-1 back to
 *  MIN_HISTORICAL_SEASON_ID) — dynamic, not static markup, since the
 *  actual years depend on what "current" resolves to. Re-run on every
 *  init() so a season rollover picks up automatically. Keeps whatever
 *  season was already selected if it's still in range, else defaults
 *  to the newest historical season. */
function populateHistoricalSeasonGroup() {
  const ids = historicalSeasonIdsUI();
  if (el.historicalCardDesc) {
    el.historicalCardDesc.textContent = `Full-season stats — ${ids.map(seasonLabel).reverse().join(' & ')}.`;
  }
  el.historicalSeasonGroup.innerHTML = '';
  for (const id of [...ids].reverse()) { // render oldest -> newest (left to right), chronological
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle-btn';
    btn.setAttribute('role', 'tab');
    btn.dataset.season = String(id);
    btn.textContent = seasonLabel(id);
    btn.addEventListener('click', () => selectHistoricalSeason(id));
    el.historicalSeasonGroup.appendChild(btn);
  }
  if (!ids.includes(state.historicalSeasonId)) state.historicalSeasonId = ids[0] ?? null;
}

/** Builds Current Season's 2 sub-tabs — the plain "2026–27" view
 *  (placeholder until the season has real games, then the live
 *  rest-of-season blend) and "2026–27 (Projections)" (the preseason
 *  age-curve model, always available regardless of whether the season
 *  has started). Mirrors populateHistoricalSeasonGroup()'s pattern. */
function populateCurrentSeasonSubGroup() {
  const seasonId = upcomingSeasonId();
  const label = seasonLabel(seasonId);
  el.currentSeasonSubGroup.innerHTML = '';
  const views = [
    { key: 'live', text: label },
    { key: 'projected', text: `${label} (Projections)` },
  ];
  for (const v of views) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle-btn';
    btn.setAttribute('role', 'tab');
    btn.dataset.currentView = v.key;
    btn.textContent = v.text;
    btn.addEventListener('click', () => selectCurrentSubView(v.key));
    el.currentSeasonSubGroup.appendChild(btn);
  }
}

async function selectCurrentSubView(view) {
  if (state.period === 'current' && state.currentSubView === view) return;
  state.currentSubView = view;
  await activateView('current');
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

/** Current Season's "2026–27" sub-tab: a placeholder until the season
 *  has any real recorded games (no projection fetch happens at all,
 *  only the one lightweight stats call needed to check), then
 *  AUTOMATICALLY a live rest-of-season blend (buildRestOfSeasonProjection(),
 *  projections.js — real results so far + a modeled rate for the rest,
 *  updating every time more games are played). Sets state.currentIsLive
 *  so updateSeasonLabel()/syncControlVisibility() know which applies. */
async function loadLiveCurrentSeasonView(seasonId) {
  const cacheKey = `current:${seasonId}:live`;
  let raw = state.seasonDataCache.get(cacheKey);
  if (!raw) {
    let currentRaw = state.seasonDataCache.get(seasonId);
    if (!currentRaw) {
      const data = await loadSeasonStatsFor(seasonId, state.teamMeta);
      currentRaw = { skaters: data.skaters, goalies: data.goalies };
      state.seasonDataCache.set(seasonId, currentRaw);
    }
    const isLive = currentRaw.skaters.length > 0; // has the season actually started yet?

    if (!isLive) {
      raw = { skaters: [], goalies: [], isLive: false };
    } else {
      const { historicalData, bioPool, deployment, settings } = await loadProjectionInputs(seasonId);
      const built = buildRestOfSeasonProjection({ // projections.js
        currentSeasonId: seasonId,
        currentRaw,
        historicalData,
        bioPool,
        teamMeta: state.teamMeta,
        deployment,
        settings,
      });
      raw = { skaters: built.skaters, goalies: built.goalies, isLive: true };
    }
    state.seasonDataCache.set(cacheKey, raw);
  }
  state.rawSkaters = raw.skaters;
  state.rawGoalies = raw.goalies;
  state.currentIsLive = raw.isLive;
  applyStatMode();
}

/** Current Season's "2026–27 (Projections)" sub-tab: the preseason
 *  age-curve model (buildProjectedSeason(), projections.js), always
 *  available regardless of whether the season has started — distinct
 *  from the live rest-of-season blend above. */
async function loadProjectedCurrentSeasonView(seasonId) {
  const cacheKey = `current:${seasonId}:projected`;
  let raw = state.seasonDataCache.get(cacheKey);
  if (!raw) {
    const { historicalData, bioPool, deployment, settings } = await loadProjectionInputs(seasonId);
    const built = buildProjectedSeason({ // projections.js
      projectedSeasonId: seasonId,
      historicalData,
      bioPool,
      teamMeta: state.teamMeta,
      deployment,
      settings,
    });
    raw = { skaters: built.skaters, goalies: built.goalies };
    state.seasonDataCache.set(cacheKey, raw);
  }
  state.rawSkaters = raw.skaters;
  state.rawGoalies = raw.goalies;
  state.currentIsLive = false; // the projection tab is never the "live blend" — always the modeled view
  // Projections are meant to be read power-ranking-first — default to
  // sorting by it every time this sub-tab loads (falls back gracefully
  // via ensureValidSort() in activateView() if 'overall' isn't one of
  // the user's active columns). A manual header click still overrides
  // this for the rest of that visit, same as any other sort.
  state.sort.skaters = { key: 'overall', dir: 'desc' };
  state.sort.goalies = { key: 'overall', dir: 'desc' };
  applyStatMode();
}

/** Dispatches to whichever of Current Season's 2 sub-tabs is active. */
async function loadCurrentSeasonView() {
  const seasonId = upcomingSeasonId();
  if (state.currentSubView === 'projected') {
    await loadProjectedCurrentSeasonView(seasonId);
  } else {
    await loadLiveCurrentSeasonView(seasonId);
  }
}

async function selectHistoricalSeason(seasonId) {
  if (state.period === 'historical' && state.historicalSeasonId === seasonId) return;
  state.historicalSeasonId = seasonId;
  await activateView('historical');
}

/** The one loader dispatch for whichever period is active — both the
 *  top-level toggle and the Historical season picker ultimately call
 *  activateView(), which calls this. */
async function loadForView(period) {
  if (period === 'historical') {
    const seasonId = state.historicalSeasonId ?? historicalSeasonIdsUI()[0];
    state.historicalSeasonId = seasonId;
    if (seasonId != null) await loadStatsForSeason(seasonId);
    return;
  }
  // First time Current Season is entered this page-load, pick a default
  // sub-tab (see defaultCurrentSubView()) — afterward whatever the user
  // picked sticks, even if they bounce over to Historical and back.
  if (state.currentSubView == null) state.currentSubView = defaultCurrentSubView(upcomingSeasonId());
  await loadCurrentSeasonView();
}

/** Central dispatch for the period control surface (top-level
 *  Historical/Current Season toggle + the Historical season picker) —
 *  sets state, loads the right data, and refreshes every dependent bit
 *  of UI (control visibility/active states, the header label, sort
 *  validity, the table itself). */
async function activateView(period) {
  el.statsContent.hidden = false; // reveal search/filters/table on the first pick — stays visible from here on
  toggleSkeleton(true);
  hideBanner();
  try {
    state.period = period;
    await loadForView(period);
    syncControlVisibility();
    updateActiveStates();
    updateSeasonLabel();
    ensureValidSort();
    render();
  } catch (err) {
    showBanner(`Couldn't load stats (${err.message}).`);
  } finally {
    toggleSkeleton(false);
  }
}

function syncControlVisibility() {
  el.historicalSeasonGroup.hidden = state.period !== 'historical';
  el.currentSeasonSubGroup.hidden = state.period !== 'current';
  // The "live" sub-tab, before the season has any real games, shows a
  // placeholder instead of the search/filters/table — nothing to look
  // through yet. The "projected" sub-tab always has data.
  const showPlaceholder = state.period === 'current' && state.currentSubView === 'live' && !state.currentIsLive;
  el.currentPlaceholder.hidden = !showPlaceholder;
  el.statsListArea.hidden = showPlaceholder;
}

function updateActiveStates() {
  el.periodButtons.forEach((b) => {
    const active = b.dataset.period === state.period;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
    const cta = b.querySelector('.period-card-cta');
    if (cta) cta.textContent = active ? '● Viewing' : 'View →';
  });
  el.historicalSeasonGroup.querySelectorAll('.toggle-btn').forEach((b) => {
    const active = state.period === 'historical' && Number(b.dataset.season) === state.historicalSeasonId;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  el.currentSeasonSubGroup.querySelectorAll('.toggle-btn').forEach((b) => {
    const active = state.period === 'current' && b.dataset.currentView === state.currentSubView;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function updateSeasonLabel() {
  const statModeLabel = state.statMode === 'perGame' ? 'Per Game' : 'Total';

  if (state.period === 'historical') {
    el.seasonLabel.textContent = `${seasonLabel(state.historicalSeasonId)} (Historical) · Regular Season stats · ${statModeLabel}`;
    return;
  }

  const seasonId = upcomingSeasonId();
  if (state.currentSubView === 'projected') {
    el.seasonLabel.textContent = `${seasonLabel(seasonId)} (Projections) · ${statModeLabel} — a preseason model built from recent-season history and age curves. Tune under Admin → Projections.`;
    return;
  }
  el.seasonLabel.textContent = state.currentIsLive
    ? `${seasonLabel(seasonId)} · Current Season · ${statModeLabel} — real results so far blended with a modeled rate for the rest of the season — updates as more games are played. Tune under Admin → Projections.`
    : `${seasonLabel(seasonId)} · Current Season — hasn't started yet. Stats will appear here automatically once real games are played.`;
}

/* ------------------------------ init ------------------------------ */

async function init() {
  hideBanner();
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
    populateHistoricalSeasonGroup();
    populateCurrentSeasonSubGroup();
    renderTableHeaders();

    // Landing state: just the Historical / Current Season cards, nothing
    // fetched or rendered for either view yet — picking one is what
    // triggers activateView() (see el.periodButtons' click handler) and
    // reveals el.statsContent (search/filters/table).
    el.seasonLabel.textContent = 'Pick Historical or Current Season below to see stats.';
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
  // Same eligibility rule Player Ratings uses (MIN_GP_FRACTION, from
  // ratings.js) — computed once per call, not per player, since
  // seasonGameCount() is an O(n) scan. gamesPlayed itself is untouched
  // by Per-Game mode (see toPerGame()), so this works in either stat mode.
  const minGP = state.qualifiedOnly ? Math.ceil(seasonGameCount(list) * MIN_GP_FRACTION) : 0;
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

  tr.addEventListener('click', () => openModal(p));
  tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(p); } });
  return tr;
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

/* ------------------------------ modal ------------------------------ */

function openModal(player) {
  el.modalRoot.hidden = false;
  document.body.style.overflow = 'hidden';
  el.modalContent.innerHTML = '<div class="modal-spinner">Loading player…</div>';

  getJSON(`${API_WEB}/v1/player/${player.playerId}/landing`)
    .then((landing) => {
      renderModalHero(landing, player);
      setupGameLog(landing, player);
    })
    .catch((err) => {
      el.modalContent.innerHTML = `<div class="modal-spinner">Couldn't load player details (${escapeHtml(err.message)}).</div>`;
    });
}

function closeModal() {
  el.modalRoot.hidden = true;
  document.body.style.overflow = '';
  el.modalContent.innerHTML = '';
}

function renderModalHero(landing, player) {
  const name = `${landing.firstName?.default ?? ''} ${landing.lastName?.default ?? ''}`.trim() || player.name;
  const headshot = landing.headshot || `https://assets.nhle.com/mugs/nhl/latest/${player.playerId}.png`;
  const teamLogo = landing.teamLogo;
  const teamName = landing.fullTeamName?.default;
  const statusLabel = landing.isActive === false ? 'Retired / Not on an NHL roster' : (teamName || 'Free Agent');
  const age = ageFromBirthDate(landing.birthDate);
  const height = formatHeight(landing.heightInInches);
  const weight = landing.weightInPounds ? `${landing.weightInPounds} lb` : '—';
  const birthplace = [landing.birthCity?.default, landing.birthStateProvince?.default, landing.birthCountry]
    .filter(Boolean).join(', ');
  const draft = landing.draftDetails
    ? `${landing.draftDetails.year} · Rd ${landing.draftDetails.round}, Pick ${landing.draftDetails.overallPick} (${landing.draftDetails.teamAbbrev})`
    : 'Undrafted';

  const chipCols = activeColumns(player.pos === 'G' ? 'goalies' : 'skaters');
  const statChips = chipCols.map((col) => [col.short, formatStatValue(col, player[col.id])]);

  el.modalContent.innerHTML = `
    <div class="ph-hero">
      <img class="ph-headshot" src="${headshot}" alt="" onerror="this.style.visibility='hidden'">
      <div>
        <h2 class="ph-name" id="modalPlayerName">${escapeHtml(name)}</h2>
        <div class="ph-meta">
          ${teamLogo ? `<img class="team-logo" src="${teamLogo}" alt="">` : ''}
          <span>${escapeHtml(statusLabel)}</span>
          ${landing.sweaterNumber ? `<span>· #${landing.sweaterNumber}</span>` : ''}
          <span>· ${escapeHtml(landing.position || player.pos)}</span>
        </div>
      </div>
    </div>
    <div class="ph-bio">
      <div class="ph-bio-item"><span class="label">Age</span><span class="value">${age ?? '—'}</span></div>
      <div class="ph-bio-item"><span class="label">Height</span><span class="value">${height}</span></div>
      <div class="ph-bio-item"><span class="label">Weight</span><span class="value">${weight}</span></div>
      <div class="ph-bio-item"><span class="label">Shoots/Catches</span><span class="value">${landing.shootsCatches ?? '—'}</span></div>
      <div class="ph-bio-item"><span class="label">Birthplace</span><span class="value">${escapeHtml(birthplace) || '—'}</span></div>
      <div class="ph-bio-item"><span class="label">Draft</span><span class="value">${escapeHtml(draft)}</span></div>
    </div>
    <div class="ph-stats">
      ${statChips.map(([lbl, num]) => `<div class="stat-chip"><span class="num">${num ?? 0}</span><span class="lbl">${lbl}</span></div>`).join('')}
    </div>
    <div class="gamelog-head">
      <h3>Game Log</h3>
      <div class="gamelog-controls">
        <select id="gameLogSeason" aria-label="Season"></select>
        <button type="button" id="gtRegular" class="active">Regular</button>
        <button type="button" id="gtPlayoffs">Playoffs</button>
      </div>
    </div>
    <div class="gamelog-table-wrap" id="gameLogWrap"><div class="gamelog-loading">Loading…</div></div>
  `;
}

function setupGameLog(landing, player) {
  const seasons = Array.from(new Set(
    (landing.seasonTotals || [])
      .filter((s) => s.leagueAbbrev === 'NHL')
      .map((s) => s.season),
  )).sort((a, b) => b - a);

  if (seasons.length === 0) seasons.push(state.seasonId);

  const seasonSelect = document.getElementById('gameLogSeason');
  seasonSelect.innerHTML = seasons.map((s) => `<option value="${s}">${seasonLabel(s)}</option>`).join('');

  const btnReg = document.getElementById('gtRegular');
  const btnPo = document.getElementById('gtPlayoffs');
  let gameType = 2;

  const loadLog = () => fetchGameLog(player.playerId, seasonSelect.value, gameType, player.pos);

  seasonSelect.addEventListener('change', loadLog);
  btnReg.addEventListener('click', () => {
    gameType = 2;
    btnReg.classList.add('active');
    btnPo.classList.remove('active');
    loadLog();
  });
  btnPo.addEventListener('click', () => {
    gameType = 3;
    btnPo.classList.add('active');
    btnReg.classList.remove('active');
    loadLog();
  });

  loadLog();
}

async function fetchGameLog(playerId, season, gameType, pos) {
  const wrap = document.getElementById('gameLogWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="gamelog-loading">Loading…</div>';
  try {
    const data = await getJSON(`${API_WEB}/v1/player/${playerId}/game-log/${season}/${gameType}`);
    const games = data.gameLog || [];
    if (games.length === 0) {
      wrap.innerHTML = `<div class="gamelog-empty">No ${gameType === 3 ? 'playoff' : 'regular season'} games found for ${seasonLabel(season)}.</div>`;
      return;
    }
    wrap.innerHTML = buildGameLogTable(games, pos);
  } catch (err) {
    wrap.innerHTML = `<div class="gamelog-empty">Couldn't load game log (${escapeHtml(err.message)}).</div>`;
  }
}

function buildGameLogTable(games, pos) {
  const isGoalie = pos === 'G';
  const head = isGoalie
    ? '<tr><th>Date</th><th>Opp</th><th>Dec</th><th>GA</th><th>SA</th><th>SV%</th><th>SO</th><th>TOI</th></tr>'
    : '<tr><th>Date</th><th>Opp</th><th>G</th><th>A</th><th>P</th><th>+/-</th><th>SOG</th><th>PIM</th><th>TOI</th></tr>';

  const rows = games.map((g) => {
    const opp = (g.homeRoadFlag === 'H' ? 'vs ' : '@ ') + (g.opponentAbbrev ?? '');
    if (isGoalie) {
      const dec = g.decision || '—';
      const decClass = dec === 'W' ? 'result-w' : dec === 'L' ? 'result-l' : dec === 'O' ? 'result-o' : '';
      const svPct = typeof g.savePctg === 'number' ? g.savePctg.toFixed(3).replace(/^0/, '') : '—';
      return `<tr>
        <td>${formatDate(g.gameDate)}</td><td>${escapeHtml(opp)}</td>
        <td class="${decClass}">${dec}</td>
        <td>${g.goalsAgainst ?? 0}</td><td>${g.shotsAgainst ?? 0}</td>
        <td>${svPct}</td><td>${g.shutouts ?? 0}</td><td>${g.toi ?? '—'}</td>
      </tr>`;
    }
    return `<tr>
      <td>${formatDate(g.gameDate)}</td><td>${escapeHtml(opp)}</td>
      <td>${g.goals ?? 0}</td><td>${g.assists ?? 0}</td><td>${g.points ?? 0}</td>
      <td>${g.plusMinus ?? 0}</td><td>${g.shots ?? 0}</td><td>${g.pim ?? 0}</td><td>${g.toi ?? '—'}</td>
    </tr>`;
  }).join('');

  return `<table class="gamelog-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
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

el.periodButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const period = btn.dataset.period;
    if (state.period === period) return;
    activateView(period);
  });
});

el.teamSelect.addEventListener('change', () => {
  state.team = el.teamSelect.value;
  render();
});

el.searchInput.addEventListener('input', debounce(() => {
  state.search = el.searchInput.value;
  render();
}, 150));

el.modalClose.addEventListener('click', closeModal);
el.modalOverlay.addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.modalRoot.hidden) closeModal();
});

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
