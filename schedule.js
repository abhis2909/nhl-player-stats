'use strict';

/* ======================================================================
   Weekly Schedule: a team x day grid for one week at a time, similar to
   Daily Faceoff's schedule grid — who each team plays, home or away,
   each day, plus a games-this-week count (handy for streaming decisions
   in weekly fantasy leagues) and a back-to-back flag.

   One API call per week: /v1/schedule/{date} (or /v1/schedule/now for
   the current one) returns a full league-wide week already grouped by
   day — { nextStartDate, previousStartDate, gameWeek: [{ date,
   dayAbbrev, games: [...] }] } — so there's no need to fetch anything
   per-team; the response already carries every game for every team that
   week, and nextStartDate/previousStartDate make Prev/Next navigation
   trivial. Team metadata (name, logo) is a separate, rarely-changing
   fetch shared with data.js's buildTeamMeta().
   ====================================================================== */

const el = {
  weekLabel: document.getElementById('weekLabel'),
  statusBanner: document.getElementById('statusBanner'),
  skeleton: document.getElementById('skeleton'),
  table: document.getElementById('scheduleTable'),
  headRow: document.getElementById('scheduleHeadRow'),
  body: document.getElementById('scheduleBody'),
  emptyState: document.getElementById('emptyState'),
  resultCount: document.getElementById('resultCount'),
  searchInput: document.getElementById('searchInput'),
  prevWeekBtn: document.getElementById('prevWeekBtn'),
  nextWeekBtn: document.getElementById('nextWeekBtn'),
  thisWeekBtn: document.getElementById('thisWeekBtn'),
};

const state = {
  teamMeta: new Map(),
  gameWeek: [], // [{ date, dayAbbrev, games: [...] }]
  nextStartDate: null,
  previousStartDate: null,
  grid: new Map(), // teamAbbrev -> Map(date -> cellInfo)
  search: '',
  sort: { key: 'name', dir: 'asc' },
  currentWeekMonday: null, // the Monday that "This Week" / the initial load should land on
};

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The Monday (ISO date string) of the week containing `dateStr`. NHL's
 *  /v1/schedule/{date} returns whatever 7-day window starts at the date
 *  you give it — not necessarily Monday-aligned — so every fetch in this
 *  file anchors to a Monday first. Confirmed by testing: once you DO
 *  anchor to a Monday, the API's own nextStartDate/previousStartDate
 *  stay Monday-aligned on every subsequent page too. */
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun .. 6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
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

/** Turns the flat gameWeek array into a per-team lookup: abbrev -> Map(date -> cellInfo). */
function buildGrid(gameWeek) {
  const grid = new Map();
  const setCell = (abbrev, date, info) => {
    if (!grid.has(abbrev)) grid.set(abbrev, new Map());
    grid.get(abbrev).set(date, info);
  };
  for (const day of gameWeek) {
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

function teamRows() {
  const q = state.search.trim().toLowerCase();
  const rows = [];
  for (const [abbrev, meta] of state.teamMeta.entries()) {
    if (q && !meta.name.toLowerCase().includes(q) && !abbrev.toLowerCase().includes(q)) continue;
    const teamGrid = state.grid.get(abbrev);
    const days = state.gameWeek.map((day) => teamGrid?.get(day.date) || null);
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

  for (const day of state.gameWeek) {
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
  gpTh.title = 'Games this week';
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

/** One day's cell for a team — opponent + home/away, plus a final score
 *  (once the game's official) or a scheduled start time, plus a small
 *  B2B tag if this game and the previous displayed day's game are both
 *  present (back-to-back only within the visible week — see footer note). */
function cellHtml(info, isB2B) {
  if (!info) return '<span class="sched-bye">–</span>';

  const prefix = info.isHome ? 'vs' : '@';
  const sideClass = info.isHome ? 'sched-home' : 'sched-away';
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
  return `<span class="sched-cell ${sideClass}">${b2bTag}<span class="sched-opp">${prefix} ${escapeHtml(info.opp)}</span>${extra}</span>`;
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

function formatWeekLabel(gameWeek) {
  if (gameWeek.length === 0) return '';
  const first = new Date(gameWeek[0].date + 'T00:00:00Z');
  const last = new Date(gameWeek[gameWeek.length - 1].date + 'T00:00:00Z');
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  const yearOpts = { ...opts, year: 'numeric' };
  return `${first.toLocaleDateString(undefined, opts)} – ${last.toLocaleDateString(undefined, yearOpts)}`;
}

async function loadWeek(date) {
  el.statusBanner.hidden = true;
  el.skeleton.hidden = false;
  el.body.innerHTML = '';

  try {
    // Always anchor to that date's Monday — see mondayOf()'s comment.
    const anchored = mondayOf(date);
    const data = await getJSON(`${API_WEB}/v1/schedule/${anchored}`);
    state.gameWeek = data.gameWeek || [];
    state.nextStartDate = data.nextStartDate || null;
    state.previousStartDate = data.previousStartDate || null;
    state.grid = buildGrid(state.gameWeek);

    const isCurrent = state.gameWeek[0]?.date === state.currentWeekMonday;
    el.weekLabel.innerHTML = escapeHtml(formatWeekLabel(state.gameWeek)) +
      (isCurrent ? ' <span class="current-week-badge">Current Week</span>' : '');
    el.nextWeekBtn.disabled = !state.nextStartDate;
    el.prevWeekBtn.disabled = !state.previousStartDate;

    renderHead();
    render();
  } catch (err) {
    showBanner(`Couldn't load the schedule (${err.message}). Make sure the local server is running, then retry.`);
  } finally {
    el.skeleton.hidden = true;
  }
}

async function init() {
  try {
    const standings = await getJSON(`${API_WEB}/v1/standings/now`);
    state.teamMeta = buildTeamMeta(standings);
  } catch (err) {
    showBanner(`Couldn't load team info (${err.message}). Make sure the local server is running, then retry.`);
    return;
  }

  // "now" is the NHL API's own idea of "the relevant week" — during the
  // season that's just today's week; off-season it jumps forward to the
  // next week with real games (e.g. the season opener) instead of
  // showing an empty current calendar week. Either way, anchor it to a
  // Monday and remember that Monday as "current" for the badge above,
  // decoupled from whatever week gets navigated to afterward.
  try {
    const nowData = await getJSON(`${API_WEB}/v1/schedule/now`);
    const anchorDate = nowData.gameWeek?.[0]?.date || todayISO();
    state.currentWeekMonday = mondayOf(anchorDate);
  } catch {
    state.currentWeekMonday = mondayOf(todayISO());
  }

  await loadWeek(state.currentWeekMonday);
}

el.searchInput.addEventListener('input', debounce(() => {
  state.search = el.searchInput.value;
  render();
}, 150));

el.prevWeekBtn.addEventListener('click', () => {
  if (state.previousStartDate) loadWeek(state.previousStartDate);
});
el.nextWeekBtn.addEventListener('click', () => {
  if (state.nextStartDate) loadWeek(state.nextStartDate);
});
el.thisWeekBtn.addEventListener('click', () => loadWeek(state.currentWeekMonday || todayISO()));

init();
