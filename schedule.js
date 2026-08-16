'use strict';

/* ======================================================================
   Weekly Schedule: a team x day grid, similar to Daily Faceoff's
   schedule grid — who each team plays, home or away, each day in a
   chosen date range, plus a games-in-range count (handy for streaming
   decisions in weekly fantasy leagues), a back-to-back flag, and a
   matchup-strength color per cell (see computeTeamStrength() below).

   Data comes from /v1/schedule/{date} — one call per 7-day window,
   already grouped by day and covering every team, so a multi-week range
   just means a few chained calls (fetchRange()) rather than one call per
   team. Team metadata (name, logo, standings) is a separate, rarely-
   changing fetch shared with data.js's buildTeamMeta().

   Everything here operates on an explicit [fromDate, toDate] range
   rather than "the current week" — Prev/This Week/Next are just
   shortcuts that set a plain Monday-Sunday range; the date inputs allow
   any custom span up to MAX_RANGE_DAYS, and the team-filter checkboxes
   narrow which rows show. NHL's own /v1/schedule/{date} redirect isn't
   used for navigation math (only for finding "now" once at init) — Prev/
   Next/custom ranges are computed with plain date arithmetic instead, so
   there's no dependency on the API's own week boundaries once loaded.
   ====================================================================== */

const MAX_RANGE_DAYS = 31; // caps both the grid width and the number of chained week-fetches

const el = {
  weekLabel: document.getElementById('weekLabel'),
  statusBanner: document.getElementById('statusBanner'),
  skeleton: document.getElementById('skeleton'),
  table: document.getElementById('scheduleTable'),
  headRow: document.getElementById('scheduleHeadRow'),
  body: document.getElementById('scheduleBody'),
  emptyState: document.getElementById('emptyState'),
  resultCount: document.getElementById('resultCount'),
  scheduleNote: document.getElementById('scheduleNote'),
  searchInput: document.getElementById('searchInput'),
  prevWeekBtn: document.getElementById('prevWeekBtn'),
  nextWeekBtn: document.getElementById('nextWeekBtn'),
  thisWeekBtn: document.getElementById('thisWeekBtn'),
  fromDateInput: document.getElementById('fromDate'),
  toDateInput: document.getElementById('toDate'),
  teamFilterBtn: document.getElementById('teamFilterBtn'),
  teamFilterPanel: document.getElementById('teamFilterPanel'),
  teamFilterGrid: document.getElementById('teamFilterGrid'),
  teamFilterAll: document.getElementById('teamFilterAll'),
  teamFilterNone: document.getElementById('teamFilterNone'),
};

const state = {
  teamMeta: new Map(),
  teamStrength: new Map(), // abbrev -> { score, rank, gfPerGame, gaPerGame } | null
  selectedTeams: null, // Set of abbrevs, or null until populated (= all)
  days: [], // [{ date, dayAbbrev, games: [...] }] across the selected range
  fromDate: null,
  toDate: null,
  grid: new Map(), // teamAbbrev -> Map(date -> cellInfo)
  search: '',
  sort: { key: 'name', dir: 'asc' },
  currentWeekMonday: null, // the Monday "This Week" should land on
};

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// todayISO() / addDays() / mondayOf() / formatDateRange() all come from
// data.js (loaded before this file) — shared with snapshots.js so a
// weekly "retrieve latest stats" snapshot is labeled with the exact same
// Monday-Sunday week text this page shows.

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

// ---------------------------------------------------------------------
// Fetching a date range (possibly several chained week-fetches)
// ---------------------------------------------------------------------

/** All game-days between fromDate and toDate (inclusive), fetched as
 *  however many 7-day /v1/schedule/{monday} pages that spans. Days are
 *  pushed in chronological order with no gaps, so consecutive entries in
 *  the result are always consecutive calendar days (buildRow's
 *  back-to-back check relies on that). */
async function fetchRange(fromDate, toDate) {
  const days = [];
  let cursor = mondayOf(fromDate);
  let guard = 0;
  while (guard < 12) { // defensive cap regardless of MAX_RANGE_DAYS, in case of an odd API response
    const data = await getJSON(`${API_WEB}/v1/schedule/${cursor}`);
    const week = data.gameWeek || [];
    for (const day of week) {
      if (day.date >= fromDate && day.date <= toDate) days.push(day);
    }
    const lastDate = week[week.length - 1]?.date;
    if (!lastDate || lastDate >= toDate || !data.nextStartDate) break;
    cursor = data.nextStartDate;
    guard += 1;
  }
  return days;
}

/** Turns the flat days array into a per-team lookup: abbrev -> Map(date -> cellInfo). */
function buildGrid(days) {
  const grid = new Map();
  const setCell = (abbrev, date, info) => {
    if (!grid.has(abbrev)) grid.set(abbrev, new Map());
    grid.get(abbrev).set(date, info);
  };
  for (const day of days) {
    for (const g of day.games) {
      const home = g.homeTeam;
      const away = g.awayTeam;
      setCell(home.abbrev, day.date, {
        opp: away.abbrev, isHome: true, gameState: g.gameState,
        startTimeUTC: g.startTimeUTC, ownScore: home.score, oppScore: away.score,
      });
      setCell(away.abbrev, day.date, {
        opp: home.abbrev, isHome: false, gameState: g.gameState,
        startTimeUTC: g.startTimeUTC, ownScore: away.score, oppScore: home.score,
      });
    }
  }
  return grid;
}

// ---------------------------------------------------------------------
// Matchup strength — standing position + offense + defense, blended
// ---------------------------------------------------------------------

function percentileRank(value, pool) {
  const n = pool.length;
  if (n <= 1) return 100;
  let below = 0;
  for (const v of pool) if (v < value) below += 1;
  return (below / (n - 1)) * 100;
}

/** abbrev -> { score(0-100), rank, gfPerGame, gaPerGame } | null. Blends
 *  three percentile-ranked signals, each relative to the other teams
 *  with standings data: standing position (leagueSequence, inverted so
 *  rank #1 scores highest), offense (goalFor/gamesPlayed), and defense
 *  (goalAgainst/gamesPlayed, inverted so fewer goals allowed scores
 *  highest). Equal weight, simple average — higher score = tougher
 *  opponent. A team with no games-played data yet (shouldn't normally
 *  happen — /v1/standings/now falls back to last season's final table
 *  before a new season starts) gets null: "no rating", not a 0. */
function computeTeamStrength(teamMeta) {
  const withData = Array.from(teamMeta.values()).filter((m) => m.gamesPlayed > 0 && typeof m.leagueSequence === 'number');
  const rankPool = withData.map((m) => m.leagueSequence);
  const offPool = withData.map((m) => m.goalFor / m.gamesPlayed);
  const defPool = withData.map((m) => m.goalAgainst / m.gamesPlayed);

  const strength = new Map();
  for (const [abbrev, m] of teamMeta.entries()) {
    if (!m.gamesPlayed || typeof m.leagueSequence !== 'number') { strength.set(abbrev, null); continue; }
    const gfPerGame = m.goalFor / m.gamesPlayed;
    const gaPerGame = m.goalAgainst / m.gamesPlayed;
    const rankPct = 100 - percentileRank(m.leagueSequence, rankPool);
    const offPct = percentileRank(gfPerGame, offPool);
    const defPct = 100 - percentileRank(gaPerGame, defPool);
    strength.set(abbrev, {
      score: Math.round((rankPct + offPct + defPct) / 3),
      rank: m.leagueSequence,
      gfPerGame,
      gaPerGame,
    });
  }
  return strength;
}

function strengthTier(score) {
  if (score == null) return null;
  if (score >= 80) return 'brutal';
  if (score >= 60) return 'tough';
  if (score >= 40) return 'even';
  if (score >= 20) return 'favorable';
  return 'easy';
}

const TIER_LABEL = { brutal: 'Brutal', tough: 'Tough', even: 'Even', favorable: 'Favorable', easy: 'Easy' };

// ---------------------------------------------------------------------
// Team filter panel
// ---------------------------------------------------------------------

function populateTeamFilter() {
  const teams = Array.from(state.teamMeta.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name));
  el.teamFilterGrid.innerHTML = teams.map(([abbrev, meta]) => `
    <label class="check-item">
      <input type="checkbox" value="${escapeHtml(abbrev)}" checked>
      <span>${escapeHtml(meta.name)}</span>
    </label>
  `).join('');
  el.teamFilterGrid.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', onTeamFilterChange);
  });
}

function onTeamFilterChange() {
  const checked = Array.from(el.teamFilterGrid.querySelectorAll('input:checked')).map((cb) => cb.value);
  state.selectedTeams = new Set(checked);
  updateTeamFilterLabel();
  render();
}

function updateTeamFilterLabel() {
  const total = state.teamMeta.size;
  const n = state.selectedTeams.size;
  const label = n === total ? 'Teams: All' : n === 0 ? 'Teams: None' : `Teams: ${n}`;
  el.teamFilterBtn.innerHTML = `${escapeHtml(label)} <span class="caret">▾</span>`;
}

el.teamFilterAll.addEventListener('click', () => {
  el.teamFilterGrid.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
  onTeamFilterChange();
});
el.teamFilterNone.addEventListener('click', () => {
  el.teamFilterGrid.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
  onTeamFilterChange();
});
el.teamFilterBtn.addEventListener('click', () => {
  const willOpen = el.teamFilterPanel.hidden;
  el.teamFilterPanel.hidden = !willOpen;
  el.teamFilterBtn.setAttribute('aria-expanded', String(willOpen));
});
document.addEventListener('click', (e) => {
  if (!el.teamFilterPanel.hidden && !e.target.closest('.team-filter')) {
    el.teamFilterPanel.hidden = true;
    el.teamFilterBtn.setAttribute('aria-expanded', 'false');
  }
});

// ---------------------------------------------------------------------
// Rows / rendering
// ---------------------------------------------------------------------

function teamRows() {
  const q = state.search.trim().toLowerCase();
  const rows = [];
  for (const [abbrev, meta] of state.teamMeta.entries()) {
    if (state.selectedTeams && !state.selectedTeams.has(abbrev)) continue;
    if (q && !meta.name.toLowerCase().includes(q) && !abbrev.toLowerCase().includes(q)) continue;
    const teamGrid = state.grid.get(abbrev);
    const days = state.days.map((day) => teamGrid?.get(day.date) || null);
    const gp = days.filter(Boolean).length;
    rows.push({ abbrev, name: meta.name, logo: meta.logo, days, gp });
  }
  const { key, dir } = state.sort;
  const mul = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    if (key === 'gp') return (a.gp - b.gp) * mul;
    return a.name.localeCompare(b.name) * mul;
  });
  return rows;
}

function formatDayHead(day) {
  const d = new Date(day.date + 'T00:00:00Z');
  const md = d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', timeZone: 'UTC' });
  return `<span class="sched-day-abbr">${escapeHtml(day.dayAbbrev)}</span><span class="sched-day-date">${md}</span>`;
}

function renderHead() {
  el.headRow.innerHTML = '';

  const teamTh = document.createElement('th');
  teamTh.scope = 'col';
  teamTh.className = 'sortable';
  teamTh.dataset.key = 'name';
  teamTh.dataset.type = 'string';
  teamTh.textContent = 'Team';
  teamTh.addEventListener('click', () => onSortClick('name', 'string'));
  el.headRow.appendChild(teamTh);

  for (const day of state.days) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.className = 'sched-day-head';
    th.innerHTML = formatDayHead(day);
    el.headRow.appendChild(th);
  }

  const gpTh = document.createElement('th');
  gpTh.scope = 'col';
  gpTh.className = 'sortable is-numeric';
  gpTh.dataset.key = 'gp';
  gpTh.dataset.type = 'number';
  gpTh.title = 'Games in the selected range';
  gpTh.textContent = 'GP';
  gpTh.addEventListener('click', () => onSortClick('gp', 'number'));
  el.headRow.appendChild(gpTh);

  updateSortHeaders();
}

function onSortClick(key, type) {
  if (state.sort.key === key) {
    state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sort.key = key;
    state.sort.dir = type === 'number' ? 'desc' : 'asc';
  }
  render();
}

function updateSortHeaders() {
  el.table.querySelectorAll('th.sortable').forEach((th) => {
    if (th.dataset.key === state.sort.key) th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  });
}

/** One day's cell for a team — opponent + home/away, tinted by the
 *  opponent's matchup-strength tier, plus either a final score
 *  (color-coded win/loss, once the game's official), a scheduled start
 *  time, or "LIVE" — falls back to a plain "–" for a bye day. A B2B tag
 *  shows when this game and the previous displayed day's game are both
 *  present (only within the selected range — see footer note). */
function cellHtml(info, isB2B) {
  if (!info) return '<span class="sched-bye">–</span>';

  const prefix = info.isHome ? 'vs' : '@';
  const strength = state.teamStrength.get(info.opp);
  const tier = strengthTier(strength?.score);
  const tierClass = tier ? `opp-${tier}` : '';

  let extra = '';
  if (info.gameState === 'OFF' && typeof info.ownScore === 'number' && typeof info.oppScore === 'number') {
    const outcome = info.ownScore > info.oppScore ? 'win' : 'loss';
    extra = `<span class="sched-score ${outcome}">${info.ownScore}–${info.oppScore}</span>`;
  } else if (info.gameState === 'LIVE' || info.gameState === 'CRIT') {
    extra = '<span class="sched-live">LIVE</span>';
  } else if (info.startTimeUTC) {
    const t = new Date(info.startTimeUTC).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    extra = `<span class="sched-time">${escapeHtml(t)}</span>`;
  }

  const b2bTag = isB2B ? '<span class="sched-b2b" title="Back-to-back">B2B</span>' : '';
  const title = strength
    ? `${info.opp} — rank #${strength.rank}, ${strength.gfPerGame.toFixed(2)} GF/G, ${strength.gaPerGame.toFixed(2)} GA/G — ${TIER_LABEL[tier]} matchup (${strength.score}/100)`
    : `${info.opp} — no rating available`;

  return `<span class="sched-cell ${tierClass}" title="${escapeHtml(title)}">${b2bTag}<span class="sched-opp">${prefix} ${escapeHtml(info.opp)}</span>${extra}</span>`;
}

function buildRow(row) {
  const tr = document.createElement('tr');

  const teamTd = document.createElement('td');
  const teamWrap = document.createElement('div');
  teamWrap.className = 'team-cell';
  if (row.logo) {
    const img = document.createElement('img');
    img.className = 'team-logo';
    img.src = row.logo;
    img.alt = '';
    img.loading = 'lazy';
    teamWrap.appendChild(img);
  }
  const span = document.createElement('span');
  span.textContent = row.name;
  teamWrap.appendChild(span);
  teamTd.appendChild(teamWrap);
  tr.appendChild(teamTd);

  row.days.forEach((info, i) => {
    const td = document.createElement('td');
    td.className = 'sched-day-cell';
    const prev = row.days[i - 1];
    const isB2B = Boolean(info && prev);
    td.innerHTML = cellHtml(info, isB2B);
    tr.appendChild(td);
  });

  const gpTd = document.createElement('td');
  gpTd.className = 'is-numeric stat-num';
  gpTd.textContent = row.gp;
  tr.appendChild(gpTd);

  return tr;
}

function render() {
  const rows = teamRows();
  const frag = document.createDocumentFragment();
  rows.forEach((row) => frag.appendChild(buildRow(row)));
  el.body.innerHTML = '';
  el.body.appendChild(frag);

  el.emptyState.hidden = rows.length !== 0;
  el.resultCount.textContent = `${rows.length.toLocaleString()} teams`;
  updateSortHeaders();
}

// ---------------------------------------------------------------------
// Loading a range
// ---------------------------------------------------------------------

async function loadRange(fromDate, toDate, clamped = false) {
  el.statusBanner.hidden = true;
  el.skeleton.hidden = false;
  el.body.innerHTML = '';
  state.fromDate = fromDate;
  state.toDate = toDate;

  try {
    state.days = await fetchRange(fromDate, toDate);
    state.grid = buildGrid(state.days);

    const isCurrentWeek = Boolean(state.currentWeekMonday) &&
      fromDate === state.currentWeekMonday && toDate === addDays(state.currentWeekMonday, 6);
    el.weekLabel.innerHTML = escapeHtml(formatDateRange(fromDate, toDate)) +
      (isCurrentWeek ? ' <span class="current-week-badge">Current Week</span>' : '');

    el.scheduleNote.textContent = clamped
      ? `Showing the first ${MAX_RANGE_DAYS} days of your selection — pick a shorter range to see the rest.`
      : '';

    renderHead();
    render();
  } catch (err) {
    showBanner(`Couldn't load the schedule (${err.message}). Make sure the local server is running, then retry.`);
  } finally {
    el.skeleton.hidden = true;
  }
}

function setDateInputs(from, to) {
  el.fromDateInput.value = from;
  el.toDateInput.value = to;
}

function onDateInputChange() {
  let from = el.fromDateInput.value;
  let to = el.toDateInput.value;
  if (!from || !to) return; // wait until both are filled in

  if (from > to) { const tmp = from; from = to; to = tmp; }
  let clamped = false;
  const maxTo = addDays(from, MAX_RANGE_DAYS - 1);
  if (to > maxTo) { to = maxTo; clamped = true; }

  setDateInputs(from, to);
  loadRange(from, to, clamped);
}

// Debounced so two near-simultaneous 'change' events (e.g. a script or
// browser firing both inputs' events back to back) collapse into one
// call that reads both inputs' FINAL values, instead of the second call
// silently clobbering a clamp note the first call just set.
const onDateInputChangeDebounced = debounce(onDateInputChange, 50);
el.fromDateInput.addEventListener('change', onDateInputChangeDebounced);
el.toDateInput.addEventListener('change', onDateInputChangeDebounced);

el.prevWeekBtn.addEventListener('click', () => {
  const from = addDays(mondayOf(state.fromDate || todayISO()), -7);
  const to = addDays(from, 6);
  setDateInputs(from, to);
  loadRange(from, to);
});
el.nextWeekBtn.addEventListener('click', () => {
  const from = addDays(mondayOf(state.fromDate || todayISO()), 7);
  const to = addDays(from, 6);
  setDateInputs(from, to);
  loadRange(from, to);
});
el.thisWeekBtn.addEventListener('click', () => {
  const from = state.currentWeekMonday || mondayOf(todayISO());
  const to = addDays(from, 6);
  setDateInputs(from, to);
  loadRange(from, to);
});

el.searchInput.addEventListener('input', debounce(() => {
  state.search = el.searchInput.value;
  render();
}, 150));

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

async function init() {
  try {
    const standings = await getJSON(`${API_WEB}/v1/standings/now`);
    state.teamMeta = buildTeamMeta(standings);
    state.teamStrength = computeTeamStrength(state.teamMeta);
    state.selectedTeams = new Set(state.teamMeta.keys());
  } catch (err) {
    showBanner(`Couldn't load team info (${err.message}). Make sure the local server is running, then retry.`);
    return;
  }
  populateTeamFilter();
  updateTeamFilterLabel();

  // "now" is the NHL API's own idea of "the relevant week" — during the
  // season that's just today's week; off-season it jumps forward to the
  // next week with real games (e.g. the season opener) instead of an
  // empty current calendar week. Anchor it to a Monday and remember that
  // as "current" for the badge, decoupled from whatever range the user
  // navigates to afterward.
  try {
    const nowData = await getJSON(`${API_WEB}/v1/schedule/now`);
    const anchorDate = nowData.gameWeek?.[0]?.date || todayISO();
    state.currentWeekMonday = mondayOf(anchorDate);
  } catch {
    state.currentWeekMonday = mondayOf(todayISO());
  }

  const from = state.currentWeekMonday;
  const to = addDays(from, 6);
  setDateInputs(from, to);
  await loadRange(from, to);
}

init();
