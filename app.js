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
  seasonToggleGroup: document.getElementById('seasonToggleGroup'),
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
  seasonId: null,          // the CURRENT (live/active-snapshot) season — always fetched, regardless of which season is selected below
  selectedSeasonId: null,  // whichever season the table is actually showing
  seasonDataCache: new Map(), // seasonId -> { skaters, goalies } raw totals — avoids refetching a season already looked at
  statMode: 'total',       // 'total' | 'perGame' — see applyStatMode()
  qualifiedOnly: false,    // when true, hide players under MIN_GP_FRACTION (ratings.js) of the pool's max games played
  snapshotLabel: null,     // set in init() when the CURRENT season is showing a saved snapshot rather than live data
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

// How far back the season toggle goes: current, and the 2 seasons before
// it. NHL season ids follow a YYYYYYYY+1 pattern, so stepping back one
// season is always -10001 (see cards.js's identical convention).
function seasonOffsets() {
  return [state.seasonId - 20002, state.seasonId - 10001, state.seasonId];
}

// The 4th, projected season — one season ahead of "current". Its
// historical inputs (the 4 seasons feeding the projection) are computed
// by projections.js's historicalSeasonIds(), independently of this.
function projectedSeasonId() {
  return state.seasonId + 10001;
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
 *  by getSeasonData() in init()"). */
async function loadStatsForSeason(seasonId) {
  let raw = state.seasonDataCache.get(seasonId);
  if (!raw) {
    const data = await loadSeasonStatsFor(seasonId, state.teamMeta);
    raw = { skaters: data.skaters, goalies: data.goalies };
    state.seasonDataCache.set(seasonId, raw);
  }
  state.rawSkaters = raw.skaters;
  state.rawGoalies = raw.goalies;
  state.selectedSeasonId = seasonId;
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
      if (col.fmt || col.id === 'gamesPlayed') continue;
      out[col.id] = gp > 0 ? p[col.id] / gp : 0;
    }
    return out;
  });
}

function applyStatMode() {
  state.skaters = toPerGame(state.rawSkaters, SKATER_COLUMNS);
  state.goalies = toPerGame(state.rawGoalies, GOALIE_COLUMNS);
}

/** Same as columns.js's formatColumnValue(), except a per-game counting
 *  stat gets a fixed 2-decimal display (formatColumnValue's default
 *  String(n) would otherwise show a long division result like
 *  0.8181818181818182). Rate columns and Games Played are unaffected —
 *  same values in both stat modes, so they format the same way too. */
function formatStatValue(col, value) {
  if (state.statMode === 'perGame' && !col.fmt && col.id !== 'gamesPlayed') {
    return (typeof value === 'number' ? value : Number(value) || 0).toFixed(2);
  }
  return formatColumnValue(col, value);
}

/** Rebuilds the 4-button Season toggle (the 2 seasons before current,
 *  current, and the projected season ahead of it) — dynamic, not static
 *  markup, since the actual years depend on what "current" resolves to.
 *  Re-run on every init() so a season rollover picks up automatically. */
function populateSeasonToggle() {
  const projId = projectedSeasonId();
  const ids = [...seasonOffsets(), projId]; // oldest -> newest -> projected, left to right
  el.seasonToggleGroup.innerHTML = '';
  for (const id of ids) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle-btn';
    btn.setAttribute('role', 'tab');
    btn.dataset.season = String(id);
    const suffix = id === state.seasonId ? ' (Current)' : id === projId ? ' (Projected)' : '';
    btn.textContent = seasonLabel(id) + suffix;
    btn.setAttribute('aria-selected', id === state.selectedSeasonId ? 'true' : 'false');
    btn.classList.toggle('active', id === state.selectedSeasonId);
    btn.addEventListener('click', () => onSeasonToggleClick(id));
    el.seasonToggleGroup.appendChild(btn);
  }
}

/** Dispatches to the right loader for whichever season was picked —
 *  the projected season needs a much heavier build (loadProjectedSeason),
 *  every other season is a plain historical fetch (loadStatsForSeason). */
async function loadSelectedSeason(seasonId) {
  if (seasonId === projectedSeasonId()) return loadProjectedSeason(seasonId);
  return loadStatsForSeason(seasonId);
}

/** Builds (or reuses a cached copy of) the projected season — fetches
 *  the 4 historical seasons feeding it (data.js's loadSeasonStatsFor +
 *  loadSkaterTimeOnIce, cache-aware so a season already viewed via the
 *  plain Season toggle isn't re-fetched), the current-roster bio pool
 *  (for age — data.js's loadPlayerBioPool), and the admin's deployment
 *  overrides + methodology settings (GET /api/fantasy/projection-config),
 *  then hands it all to projections.js's buildProjectedSeason(). Heavy
 *  on first call in a session; every call after is instant from
 *  state.seasonDataCache, same caching pattern as loadStatsForSeason(). */
async function loadProjectedSeason(seasonId) {
  let raw = state.seasonDataCache.get(seasonId);
  if (!raw) {
    const histIds = historicalSeasonIds(seasonId); // projections.js
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
      fetch(`/api/fantasy/projection-config?season=${encodeURIComponent(seasonLabel(seasonId))}`).then((r) => r.json()),
    ]);
    if (!configRes.ok) throw new Error(configRes.message || 'could not load projection settings');

    const built = buildProjectedSeason({ // projections.js
      projectedSeasonId: seasonId,
      historicalData,
      bioPool,
      teamMeta: state.teamMeta,
      deployment: configRes.deployment,
      settings: configRes.settings,
    });
    raw = { skaters: built.skaters, goalies: built.goalies };
    state.seasonDataCache.set(seasonId, raw);
  }
  state.rawSkaters = raw.skaters;
  state.rawGoalies = raw.goalies;
  state.selectedSeasonId = seasonId;
  applyStatMode();
}

function markActiveSeasonButton() {
  el.seasonToggleGroup.querySelectorAll('.toggle-btn').forEach((btn) => {
    const active = Number(btn.dataset.season) === state.selectedSeasonId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

async function onSeasonToggleClick(seasonId) {
  if (seasonId === state.selectedSeasonId) return;
  toggleSkeleton(true);
  hideBanner();
  try {
    await loadSelectedSeason(seasonId);
    markActiveSeasonButton();
    updateSeasonLabel();
    ensureValidSort();
    render();
  } catch (err) {
    showBanner(`Couldn't load ${seasonLabel(seasonId)} stats (${err.message}).`);
  } finally {
    toggleSkeleton(false);
  }
}

function updateSeasonLabel() {
  const current = state.selectedSeasonId === state.seasonId;
  const projected = state.selectedSeasonId === projectedSeasonId();
  const statModeLabel = state.statMode === 'perGame' ? 'Per Game' : 'Total';
  let text = `${seasonLabel(state.selectedSeasonId)}${current ? ' (Current)' : projected ? ' (Projected)' : ''} · Regular Season stats · ${statModeLabel}`;
  if (current && state.snapshotLabel) text += ` · ${state.snapshotLabel}`;
  if (projected) {
    text += ' · Projection: weighted recent seasons + age curve + deployment input — not real stats, tune the methodology under Admin → Projection Methodology.';
  }
  el.seasonLabel.textContent = text;
}

/* ------------------------------ init ------------------------------ */

async function init() {
  toggleSkeleton(true);
  hideBanner();
  try {
    // Always fetch the CURRENT season (live, or the active local
    // snapshot) — it's the default season shown, and the other 2 Season
    // toggle options are counted back from it (see seasonOffsets()).
    const { seasonId, teamMeta, skaters, goalies, source, snapshotLabel } = await getSeasonData();
    state.seasonId = seasonId;
    state.teamMeta = teamMeta;
    state.seasonDataCache.set(seasonId, { skaters, goalies });

    populateTeamSelect();
    populateSeasonToggle();

    // A data-bar action (switching snapshots, Retrieve Latest Stats)
    // re-runs init() — keep whatever season the user had selected
    // rather than silently jumping back to current, unless this is the
    // first load (selectedSeasonId still null) or it's no longer one of
    // the 4 options (a season rolled over since).
    const validSeasons = new Set([...seasonOffsets(), projectedSeasonId()]);
    const targetSeason = validSeasons.has(state.selectedSeasonId) ? state.selectedSeasonId : seasonId;
    await loadSelectedSeason(targetSeason); // no-op network-wise when targetSeason === seasonId (just cached above), or cached if Projected was already built this session
    markActiveSeasonButton();

    state.snapshotLabel = source === 'snapshot' ? snapshotLabel : null;
    updateSeasonLabel();
    ensureValidSort();
    renderTableHeaders();
    toggleSkeleton(false);
    render();
  } catch (err) {
    toggleSkeleton(false);
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
      const perGame = state.statMode === 'perGame' && !col.fmt && col.id !== 'gamesPlayed';
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
  ensureValidSort();
  renderTableHeaders();
  render();
});

wireDataBar(init, (err) => showBanner(`Couldn't retrieve latest stats (${err.message}).`));

init();
