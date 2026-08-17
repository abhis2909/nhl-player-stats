'use strict';

/* ======================================================================
   Team of the Week: for a chosen calendar week (Monday-Sunday, same
   boundary the Schedule page and weekly snapshots use), pick the single
   highest-rated player at each of 6 slots — Goalie, two Defensemen,
   Center, Left Wing, Right Wing — using that week's stat DELTA only
   (buildDeltaPool/ratePool from ratings.js, same engine Range Ratings
   uses), then reveal them one at a time with a theater-style animation:
   an announcer line, the card frame, then its four pieces in order
   (position -> overall -> team -> name+photo+statline).

   A week is "computable" if a snapshot exists at its Monday (the
   week-start baseline) AND either a snapshot exists at the FOLLOWING
   Monday (the week is finished — that combination gets rated once and
   stored PERMANENTLY in nhlStats.totw.v1, surviving snapshot pruning) or
   it's the current in-progress week (rated live against Live data every
   time, since it should keep updating as more games happen this week).
   ====================================================================== */

const TOTW_STORAGE_KEY = 'nhlStats.totw.v1';

// Selected in the week dropdown whenever no real weekly delta is
// computable yet (see computeSeasonRoster()) — a stand-in until enough
// weekly snapshots exist, so the page always has something to reveal.
const SEASON_PLACEHOLDER_KEY = 'season-placeholder';

// Reveal order: goalie first, then defense, then forwards — mirrors how
// a broadcast might announce a starting lineup.
const ROSTER_SLOTS = [
  { slot: 'G', label: 'Goalie', announce: 'In Goal', mode: 'goalies', posFilter: () => true },
  { slot: 'D1', label: 'Defense', announce: 'On Defense', mode: 'skaters', posFilter: (p) => p.pos === 'D' },
  { slot: 'D2', label: 'Defense', announce: 'On Defense', mode: 'skaters', posFilter: (p) => p.pos === 'D' },
  { slot: 'C', label: 'Center', announce: 'At Center', mode: 'skaters', posFilter: (p) => p.pos === 'C' },
  { slot: 'LW', label: 'Left Wing', announce: 'On the Left Wing', mode: 'skaters', posFilter: (p) => p.pos === 'L' },
  { slot: 'RW', label: 'Right Wing', announce: 'On the Right Wing', mode: 'skaters', posFilter: (p) => p.pos === 'R' },
];

const el = {
  statusBanner: document.getElementById('statusBanner'),
  weekSelect: document.getElementById('weekSelect'),
  newBadge: document.getElementById('newBadge'),
  revealBtn: document.getElementById('revealBtn'),
  skipBtn: document.getElementById('skipBtn'),
  totwEmpty: document.getElementById('totwEmpty'),
  stage: document.getElementById('totwStage'),
  announce: document.getElementById('totwAnnounce'),
  lineup: document.getElementById('totwLineup'),
  curtainWrap: document.getElementById('totwCurtainWrap'),
  leaderboard: document.getElementById('totwLeaderboard'),
  boardHeading: document.getElementById('totwBoardHeading'),
  boardButtons: Array.from(document.querySelectorAll('.toggle-btn[data-board]')),
  skaterBoardWrap: document.getElementById('skaterBoardWrap'),
  goalieBoardWrap: document.getElementById('goalieBoardWrap'),
  skaterBoardBody: document.getElementById('totwSkaterBoardBody'),
  goalieBoardBody: document.getElementById('totwGoalieBoardBody'),
};

const state = {
  teamMeta: new Map(),
  seasonId: null,
  liveData: null,
  currentWeekMonday: null,
  selectedWeek: null,
  skipRequested: false,
  playing: false,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// ---------------------------------------------------------------------
// Roster computation
// ---------------------------------------------------------------------

/** Highest-rated eligible player per slot, given already-rated (and
 *  overall-sorted) pools. usedIds prevents the same player filling both
 *  Defense slots — the two positional filters are otherwise mutually
 *  exclusive by definition (a player only has one `pos`). */
function pickRoster(ratedSkaters, ratedGoalies) {
  const usedIds = new Set();
  return ROSTER_SLOTS.map((def) => {
    const pool = def.mode === 'goalies' ? ratedGoalies : ratedSkaters;
    const player = pool.find((p) => def.posFilter(p) && !usedIds.has(p.playerId)) || null;
    if (player) usedIds.add(player.playerId);
    return { slot: def.slot, label: def.label, announce: def.announce, player };
  });
}

/** For the delta between two season-data snapshots — a real week. Returns
 *  the roster picks AND the full rated pools (sorted, overall descending)
 *  behind them, for the leaderboard section under the reveal. */
function computeRoster(fromData, toData) {
  const ratedSkaters = ratePool(buildDeltaPool(fromData, toData, 'skaters'), 'skaters')
    .sort((a, b) => b.overall - a.overall);
  const ratedGoalies = ratePool(buildDeltaPool(fromData, toData, 'goalies'), 'goalies')
    .sort((a, b) => b.overall - a.overall);
  return { roster: pickRoster(ratedSkaters, ratedGoalies), ratedSkaters, ratedGoalies };
}

/** Placeholder for whenever no real weekly delta is computable yet (e.g.
 *  before the first couple of weekly snapshots exist) — same rating
 *  engine and eligibility rule (MIN_GP_FRACTION of the season's game
 *  count) Player Cards uses for its season-to-date ratings, just applied
 *  directly to the full season instead of a one-week window. */
function computeSeasonRoster(liveData) {
  const skaterMaxGP = seasonGameCount(liveData.skaters);
  const skaterMinGP = Math.ceil(skaterMaxGP * MIN_GP_FRACTION);
  const eligibleSkaters = liveData.skaters.filter((p) => p.gamesPlayed >= skaterMinGP);

  const goalieMaxGP = seasonGameCount(liveData.goalies);
  const goalieMinGP = Math.ceil(goalieMaxGP * MIN_GP_FRACTION);
  const eligibleGoalies = liveData.goalies.filter((p) => p.gamesPlayed >= goalieMinGP);

  const ratedSkaters = ratePool(eligibleSkaters, 'skaters').sort((a, b) => b.overall - a.overall);
  const ratedGoalies = ratePool(eligibleGoalies, 'goalies').sort((a, b) => b.overall - a.overall);
  return { roster: pickRoster(ratedSkaters, ratedGoalies), ratedSkaters, ratedGoalies };
}

// ---------------------------------------------------------------------
// Persistence — finished weeks are permanent; the in-progress week isn't stored
// ---------------------------------------------------------------------

function readTotwStore() {
  try {
    const raw = localStorage.getItem(TOTW_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeTotwStore(store) {
  try { localStorage.setItem(TOTW_STORAGE_KEY, JSON.stringify(store)); } catch { /* ignore */ }
}

/** { weekMonday, fromKey, toKey, isFinal, roster, ratedSkaters,
 *  ratedGoalies } for `weekMonday`, or null if it isn't computable
 *  (missing its start snapshot, or it's a past week missing its closing
 *  snapshot too). A finished week is cached forever (full rated pools
 *  included, so its leaderboard doesn't need recomputing either) on
 *  first computation; the current in-progress week is recomputed fresh
 *  every time against Live data. */
async function getOrComputeWeek(weekMonday) {
  const store = readTotwStore();
  if (store[weekMonday]?.isFinal) return store[weekMonday];

  const fromFull = getSnapshotByKey(weekMonday);
  if (!fromFull) return null;

  const nextMonday = addDays(weekMonday, 7);
  const endFull = getSnapshotByKey(nextMonday);
  const isFinal = Boolean(endFull);

  let toData;
  if (isFinal) {
    toData = endFull.data;
  } else if (weekMonday === state.currentWeekMonday) {
    toData = state.liveData;
  } else {
    return null; // past week, never got a closing snapshot — not computable
  }

  const { roster, ratedSkaters, ratedGoalies } = computeRoster(fromFull.data, toData);
  const record = {
    weekMonday,
    fromKey: weekMonday,
    toKey: isFinal ? nextMonday : LIVE_SENTINEL,
    isFinal,
    computedAt: new Date().toISOString(),
    roster,
    ratedSkaters,
    ratedGoalies,
  };

  if (isFinal) {
    store[weekMonday] = record;
    writeTotwStore(store);
  }
  return record;
}

// ---------------------------------------------------------------------
// Week selector
// ---------------------------------------------------------------------

/** Monday dates (newest first) that have a start-of-week snapshot AND
 *  are either finished (a snapshot exists the following Monday too) or
 *  are the current in-progress week. Only considers snapshots saved in
 *  the post-week-alignment key format (plain YYYY-MM-DD) — older
 *  full-timestamp-keyed snapshots don't reliably mark a week boundary. */
function availableWeeks() {
  const weekKeys = new Set(
    listSnapshots().map((s) => s.key).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)),
  );
  const weeks = Array.from(weekKeys).filter((key) => {
    const isFinished = weekKeys.has(addDays(key, 7));
    const isCurrent = key === state.currentWeekMonday;
    return isFinished || isCurrent;
  });
  weeks.sort((a, b) => b.localeCompare(a));
  return weeks;
}

function populateWeekSelect() {
  const weeks = availableWeeks();
  el.weekSelect.innerHTML = weeks
    .map((w) => `<option value="${w}">${escapeHtml(formatDateRange(w, addDays(w, 6)))}</option>`)
    .join('');

  if (weeks.length === 0) {
    // No real weekly delta yet (no snapshots, or not enough of them) —
    // fall back to a season-stats placeholder so there's still something
    // to reveal. Disappears on its own once real weeks become available.
    const seasonOpt = document.createElement('option');
    seasonOpt.value = SEASON_PLACEHOLDER_KEY;
    seasonOpt.textContent = `${seasonLabel(state.seasonId)} Season (placeholder)`;
    el.weekSelect.appendChild(seasonOpt);
    el.weekSelect.disabled = true;
    el.revealBtn.disabled = false;
    el.totwEmpty.hidden = true;
    el.stage.hidden = false;
    state.selectedWeek = SEASON_PLACEHOLDER_KEY;
    el.newBadge.hidden = true;
    return;
  }

  el.weekSelect.disabled = false;
  el.revealBtn.disabled = false;
  el.totwEmpty.hidden = true;
  el.stage.hidden = false;

  state.selectedWeek = weeks.includes(state.selectedWeek) ? state.selectedWeek : weeks[0];
  el.weekSelect.value = state.selectedWeek;
  updateNewBadge();
}

function updateNewBadge() {
  const weeks = availableWeeks();
  el.newBadge.hidden = weeks.length === 0 || state.selectedWeek !== weeks[0];
}

el.weekSelect.addEventListener('change', () => {
  state.selectedWeek = el.weekSelect.value;
  updateNewBadge();
  resetStage();
});

function resetStage() {
  el.lineup.innerHTML = '';
  el.announce.textContent = '';
  el.revealBtn.disabled = false;
  el.revealBtn.hidden = false;
  el.revealBtn.textContent = '🎬 Reveal Team of the Week';
  el.skipBtn.hidden = true;
  el.curtainWrap.classList.remove('open');
  el.curtainWrap.classList.add('closed');
  el.leaderboard.hidden = true;
  state.playing = false;
}

// ---------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------

/** A short "why they earned it" line from this player's best few
 *  categories that week (already computed by ratePool — just picking
 *  the highest-rated ones for a flattering, relevant summary). */
function buildStatline(player) {
  const top = [...player.ratings].sort((a, b) => b.rating - a.rating).slice(0, 4);
  return top.map((r) => `${formatColumnValue(r, r.value)} ${r.short}`).join(' · ');
}

function buildTotwCard(entry) {
  const wrap = document.createElement('div');
  wrap.className = 'totw-card';
  wrap.dataset.slot = entry.slot;

  const p = entry.player;
  if (!p) {
    wrap.classList.add('totw-card-empty');
    wrap.innerHTML = `
      <div class="totw-card-inner">
        <div class="totw-empty-msg">No qualifying ${escapeHtml(entry.label.toLowerCase())} this week</div>
      </div>`;
    return wrap;
  }

  const headshot = `https://assets.nhle.com/mugs/nhl/latest/${p.playerId}.png`;
  const meta = state.teamMeta.get(p.team);
  const statline = buildStatline(p);

  wrap.innerHTML = `
    <div class="totw-card-inner">
      <div class="totw-ribbon">${escapeHtml(entry.label)} of the Week</div>
      <span class="totw-piece totw-piece-pos" data-piece="pos">
        <span class="totw-pos-badge">${escapeHtml(p.pos)}</span>
      </span>
      <span class="totw-piece totw-piece-ovr" data-piece="ovr">
        <span class="totw-ovr-badge"><span class="val">${p.overall}</span><span class="lbl">OVR</span></span>
      </span>
      <span class="totw-piece totw-piece-team" data-piece="team">
        <span class="totw-team-pill">
          ${meta?.logo ? `<img src="${meta.logo}" alt="" loading="lazy">` : ''}
          <span>${escapeHtml(p.team)}</span>
        </span>
      </span>
      <span class="totw-piece totw-piece-final" data-piece="final">
        <img class="totw-photo" src="${headshot}" alt="" loading="lazy" onerror="this.style.display='none'">
        <span class="totw-name">${escapeHtml(p.name)}</span>
        <span class="totw-statline">${escapeHtml(statline)}</span>
      </span>
    </div>`;
  return wrap;
}

function revealAllInstant(cardEl) {
  cardEl.classList.add('revealed');
  cardEl.querySelectorAll('.totw-piece').forEach((piece) => piece.classList.add('revealed'));
}

// ---------------------------------------------------------------------
// Leaderboard — top 25 skaters / top 10 goalies from the same rated
// pools the roster picks came from, shown below the reveal and
// auto-scrolled to once the ceremony finishes. A toggle switches which
// one is visible, rather than stacking both.
// ---------------------------------------------------------------------

const SKATER_BOARD_SIZE = 25;
const GOALIE_BOARD_SIZE = 10;

function leaderboardRow(rank, p) {
  const meta = state.teamMeta.get(p.team);
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="col-rank">${rank}</td>
    <td><div class="team-cell">${meta?.logo ? `<img class="team-logo" src="${meta.logo}" alt="" loading="lazy">` : ''}<span>${escapeHtml(p.name)}</span></div></td>
    <td>${escapeHtml(p.team)}</td>
    <td>${escapeHtml(p.pos)}</td>
    <td class="is-numeric stat-num">${p.overall}</td>
    <td>${escapeHtml(buildStatline(p))}</td>`;
  return tr;
}

function showLeaderboard(ratedSkaters, ratedGoalies) {
  const topSkaters = ratedSkaters.slice(0, SKATER_BOARD_SIZE);
  const topGoalies = ratedGoalies.slice(0, GOALIE_BOARD_SIZE);

  el.skaterBoardBody.innerHTML = '';
  topSkaters.forEach((p, i) => el.skaterBoardBody.appendChild(leaderboardRow(i + 1, p)));

  el.goalieBoardBody.innerHTML = '';
  topGoalies.forEach((p, i) => el.goalieBoardBody.appendChild(leaderboardRow(i + 1, p)));

  el.leaderboard.hidden = false;
  setBoard('skaters');
  el.leaderboard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setBoard(board) {
  el.boardButtons.forEach((b) => {
    const active = b.dataset.board === board;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  el.skaterBoardWrap.hidden = board !== 'skaters';
  el.goalieBoardWrap.hidden = board !== 'goalies';
  el.boardHeading.textContent = board === 'skaters'
    ? `Top ${SKATER_BOARD_SIZE} Skaters`
    : `Top ${GOALIE_BOARD_SIZE} Goalies`;
}

el.boardButtons.forEach((btn) => {
  btn.addEventListener('click', () => setBoard(btn.dataset.board));
});

function announceSlot(entry) {
  el.announce.textContent = entry.player
    ? entry.announce.toUpperCase()
    : `NO QUALIFYING ${entry.label.toUpperCase()} THIS WEEK`;
  el.announce.classList.remove('totw-flash');
  void el.announce.offsetWidth; // restart the CSS animation
  el.announce.classList.add('totw-flash');
}

// ---------------------------------------------------------------------
// Reveal sequencing
// ---------------------------------------------------------------------

async function playReveal(roster, ratedSkaters, ratedGoalies) {
  state.playing = true;
  state.skipRequested = false;
  el.revealBtn.hidden = true;
  el.skipBtn.hidden = false;
  el.lineup.innerHTML = '';
  el.announce.textContent = '';

  const cardEls = roster.map((entry) => {
    const cardEl = buildTotwCard(entry);
    el.lineup.appendChild(cardEl);
    return cardEl;
  });

  // Scroll toward the goalie card specifically (first to reveal, bottom
  // row of the diamond formation) rather than the whole stage — the full
  // 3-row lineup is taller than most viewports, so centering the whole
  // stage can still leave the goalie below the fold.
  cardEls[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(500);

  const finish = () => {
    el.announce.textContent = 'TEAM OF THE WEEK';
    el.revealBtn.hidden = false;
    el.revealBtn.textContent = '🔁 Replay';
    el.skipBtn.hidden = true;
    el.curtainWrap.classList.remove('closed');
    el.curtainWrap.classList.add('open');
    state.playing = false;
    showLeaderboard(ratedSkaters, ratedGoalies);
  };

  // Cards are built (invisible) before the curtains open, so the stage
  // is already at its full height when they part — no layout jump once
  // the reveal ceremony gets going.
  el.curtainWrap.classList.remove('closed');
  el.curtainWrap.classList.add('open');
  await sleep(1000); // let the curtain-parting transition finish first

  for (let i = 0; i < roster.length; i++) {
    if (state.skipRequested) { cardEls.forEach(revealAllInstant); finish(); return; }

    const entry = roster[i];
    const cardEl = cardEls[i];
    announceSlot(entry);
    await sleep(500);
    if (state.skipRequested) { cardEls.forEach(revealAllInstant); finish(); return; }

    cardEl.classList.add('revealed');
    await sleep(400);

    if (entry.player) {
      for (const piece of ['pos', 'ovr', 'team', 'final']) {
        if (state.skipRequested) break;
        cardEl.querySelector(`[data-piece="${piece}"]`).classList.add('revealed');
        await sleep(piece === 'final' ? 700 : 450);
      }
    }
    if (state.skipRequested) { cardEls.forEach(revealAllInstant); finish(); return; }
    await sleep(500);
  }
  finish();
}

el.revealBtn.addEventListener('click', async () => {
  if (!state.selectedWeek || state.playing) return;
  el.revealBtn.disabled = true;
  try {
    const result = state.selectedWeek === SEASON_PLACEHOLDER_KEY
      ? computeSeasonRoster(state.liveData)
      : await getOrComputeWeek(state.selectedWeek);
    if (!result) {
      showBanner("Couldn't compute this week — its snapshot data might be missing or incomplete.");
      el.revealBtn.disabled = false;
      return;
    }
    el.leaderboard.hidden = true; // hide the previous reveal's leaderboard until this one finishes
    await playReveal(result.roster, result.ratedSkaters, result.ratedGoalies);
  } finally {
    el.revealBtn.disabled = false;
  }
});

el.skipBtn.addEventListener('click', () => {
  state.skipRequested = true;
});

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

async function init() {
  el.statusBanner.hidden = true;
  try {
    const data = await loadSeasonData();
    state.liveData = data;
    state.teamMeta = data.teamMeta;
    state.seasonId = data.seasonId;
  } catch (err) {
    showBanner(`Couldn't load NHL data (${err.message}). Make sure the local server is running, then retry.`);
    return;
  }

  // Same "now" resolution as schedule.js — during the season this is
  // just today's week; off-season it jumps forward to the next week
  // with real games.
  try {
    const nowData = await getJSON(`${API_WEB}/v1/schedule/now`);
    const anchorDate = nowData.gameWeek?.[0]?.date || todayISO();
    state.currentWeekMonday = mondayOf(anchorDate);
  } catch {
    state.currentWeekMonday = mondayOf(todayISO());
  }

  populateWeekSelect();
  resetStage();
}

init();
