'use strict';

/* ======================================================================
   Range Ratings: the same gem-tier cards as the Player Cards page, but
   rated on a DELTA between two points in time instead of season-to-date
   totals — pick a "From" and "To" (any saved weekly snapshot, or "Live"
   for right now) and every player's stats for just that window get
   ranked against everyone else's for that same window. Short range =
   a "team of the week" leaderboard; longer range = an updated monthly
   ratings pass. Same rating engine and card renderer as cards.js, both
   pulled from the shared ratings.js.

   Why deltas between two SAVED SNAPSHOTS, not per-game fetches: the NHL
   API only gives season-cumulative totals per player directly, and
   fetching a full game log for every one of ~700 players just to sum a
   date range isn't practical from a static site through a shared proxy.
   Subtracting two season-cumulative snapshots for the same player gives
   an exact count for everything that's a straightforward counting stat
   (goals, assists, hits, wins, etc.) with zero extra network calls — the
   tradeoff is that you can only pick endpoints you've actually saved (or
   "now"), not an arbitrary past date you never retrieved.

   A few rate stats (shooting%, save%, GAA) can't just be subtracted —
   see deltaValue() below for how each is either recomputed from its
   underlying counts or, when that's not possible (faceoff% — the NHL
   summary endpoint doesn't expose raw faceoff win/loss counts), falls
   back to the end-of-window season-to-date rate as a documented
   approximation.
   ====================================================================== */

/* Wrapped in an IIFE so its top-level `const el`/`state` don't collide
   with admin.js's own top-level `const el` — this now loads alongside
   admin.js on admin.html's Range Ratings sub-tab (moved here from its
   own range.html; see fantasy-hub/README.md history). */
(function () {

const BATCH_SIZE = 48;
// MIN_RANGE_GP, deltaValue(), buildDeltaPool() all come from ratings.js
// (loaded before this file) — shared with totw.js's Team of the Week.

const el = {
  seasonLabel: document.getElementById('seasonLabel'),
  statusBanner: document.getElementById('statusBanner'),
  skeleton: document.getElementById('cardsSkeleton'),
  grid: document.getElementById('cardsGrid'),
  resultCount: document.getElementById('resultCount'),
  loadMoreWrap: document.getElementById('loadMoreWrap'),
  loadMoreBtn: document.getElementById('loadMoreBtn'),
  searchInput: document.getElementById('searchInput'),
  teamSelect: document.getElementById('teamSelect'),
  modeButtons: Array.from(document.querySelectorAll('.toggle-btn[data-mode]')),
  posToggleGroup: document.getElementById('posToggleGroup'),
  posButtons: Array.from(document.querySelectorAll('.toggle-btn[data-pos]')),
  fromSelect: document.getElementById('rangeFrom'),
  toSelect: document.getElementById('rangeTo'),
  deleteFromBtn: document.getElementById('deleteFromBtn'),
  quickWeek: document.getElementById('quickWeek'),
  quickMonth: document.getElementById('quickMonth'),
  retrieveBtn: document.getElementById('retrieveBtn'),
  rangeNote: document.getElementById('rangeNote'),
  rangeEmpty: document.getElementById('rangeEmpty'),
  modalRoot: document.getElementById('modalRoot'),
  modalOverlay: document.getElementById('modalOverlay'),
  modalClose: document.getElementById('modalClose'),
  modalContent: document.getElementById('modalContent'),
};

const state = {
  teamMeta: new Map(),
  seasonId: null,
  liveData: null, // { seasonId, teamMeta, skaters, goalies } from a real fetch, cached
  mode: 'skaters', // 'skaters' | 'goalies'
  fromKey: null,
  toKey: LIVE_SENTINEL,
  deltaSkaters: [], ratedSkaters: [],
  deltaGoalies: [], ratedGoalies: [],
  search: '',
  team: 'ALL',
  pos: 'ALL',
  visibleCount: BATCH_SIZE,
};

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

function endpointData(key) {
  if (key === LIVE_SENTINEL) return state.liveData;
  const full = getSnapshotByKey(key);
  return full ? full.data : null;
}

function endpointLabel(key) {
  if (key === LIVE_SENTINEL) return 'Live (now)';
  const snap = listSnapshots().find((s) => s.key === key);
  return snap ? snap.label : key;
}

/** Saved snapshots for the CURRENT season only, oldest first — crossing a
 *  season boundary in a delta wouldn't mean anything, so last season's
 *  snapshots just don't show up as pickable endpoints once 2026-27 starts.
 *  Thin wrapper over snapshots.js's shared snapshotsForSeason() (also
 *  used by app.js's date-range picker on the Stats page) — kept as its
 *  own name here since every call site in this file already says
 *  "current season snapshots", not "snapshots for state.seasonId". */
function currentSeasonSnapshots() {
  return snapshotsForSeason(state.seasonId);
}

function rerate() {
  state.ratedSkaters = ratePool(state.deltaSkaters, 'skaters');
  state.ratedGoalies = ratePool(state.deltaGoalies, 'goalies');
}

function refreshRange() {
  const fromData = state.fromKey ? endpointData(state.fromKey) : null;
  const toData = endpointData(state.toKey);

  if (!fromData || !toData) {
    state.deltaSkaters = []; state.ratedSkaters = [];
    state.deltaGoalies = []; state.ratedGoalies = [];
    el.rangeEmpty.hidden = false;
    el.skeleton.hidden = true;
    el.grid.innerHTML = '';
    el.resultCount.textContent = '';
    el.loadMoreWrap.hidden = true;
    el.rangeNote.textContent = '';
    return;
  }

  el.rangeEmpty.hidden = true;
  state.deltaSkaters = buildDeltaPool(fromData, toData, 'skaters');
  state.deltaGoalies = buildDeltaPool(fromData, toData, 'goalies');
  rerate();
  updateRangeNote();
  render(true);
}

function updateRangeNote() {
  if (!state.fromKey) { el.rangeNote.textContent = ''; return; }
  const pool = state.mode === 'goalies' ? state.ratedGoalies : state.ratedSkaters;
  el.rangeNote.textContent =
    `Showing ${pool.length.toLocaleString()} ${state.mode} who played at least one game between ` +
    `${endpointLabel(state.fromKey)} and ${endpointLabel(state.toKey)}. Ratings are percentile ranks ` +
    `within just this window, not the full season — a hot week can outrank a season-long star here, on purpose.`;
}

// ---------------------------------------------------------------------
// Endpoint pickers
// ---------------------------------------------------------------------

function populateEndpointSelects() {
  const snaps = currentSeasonSnapshots();

  const fromOpts = snaps.map((s) => `<option value="${s.key}">${escapeHtml(s.label)}</option>`).join('');
  el.fromSelect.innerHTML = fromOpts;
  el.toSelect.innerHTML = fromOpts + `<option value="${LIVE_SENTINEL}">Live (now)</option>`;

  if (snaps.length === 0) {
    el.fromSelect.disabled = true;
    el.deleteFromBtn.hidden = true;
    state.fromKey = null;
    state.toKey = LIVE_SENTINEL;
    el.toSelect.value = LIVE_SENTINEL;
    return;
  }

  el.fromSelect.disabled = false;
  el.deleteFromBtn.hidden = false;

  state.fromKey = state.fromKey && snaps.some((s) => s.key === state.fromKey) ? state.fromKey : snaps[0].key;
  el.fromSelect.value = state.fromKey;

  state.toKey = state.toKey === LIVE_SENTINEL || snaps.some((s) => s.key === state.toKey) ? state.toKey : LIVE_SENTINEL;
  el.toSelect.value = state.toKey;
}

function pickClosestSnapshot(daysAgo) {
  const snaps = currentSeasonSnapshots();
  if (snaps.length === 0) return null;
  const targetTime = Date.now() - daysAgo * 86400000;
  let best = snaps[0];
  let bestDiff = Infinity;
  for (const s of snaps) {
    const diff = Math.abs(new Date(s.savedAt).getTime() - targetTime);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

el.fromSelect.addEventListener('change', () => { state.fromKey = el.fromSelect.value; el.deleteFromBtn.hidden = false; refreshRange(); });
el.toSelect.addEventListener('change', () => { state.toKey = el.toSelect.value; refreshRange(); });

el.quickWeek.addEventListener('click', () => {
  const s = pickClosestSnapshot(7);
  if (!s) return;
  state.fromKey = s.key;
  state.toKey = LIVE_SENTINEL;
  el.fromSelect.value = s.key;
  el.toSelect.value = LIVE_SENTINEL;
  refreshRange();
});

el.quickMonth.addEventListener('click', () => {
  const s = pickClosestSnapshot(30);
  if (!s) return;
  state.fromKey = s.key;
  state.toKey = LIVE_SENTINEL;
  el.fromSelect.value = s.key;
  el.toSelect.value = LIVE_SENTINEL;
  refreshRange();
});

el.deleteFromBtn.addEventListener('click', () => {
  const key = el.fromSelect.value;
  if (!key) return;
  const snap = listSnapshots().find((s) => s.key === key);
  const label = snap ? snap.label : 'this snapshot';
  if (!window.confirm(`Delete the "${label}" snapshot? This can't be undone.`)) return;
  deleteSnapshot(key);
  state.fromKey = null;
  populateEndpointSelects();
  refreshRange();
});

// This page lives under Admin now, so "Retrieve Latest Stats" writes to
// the shared database (api/fantasy/snapshots.js, admin-gated POST) —
// not just this browser's localStorage — so it shows up for every
// visitor once they next sync, same as the daily cron's own snapshots.
// See snapshots.js's syncServerSnapshots(), called here to pull the
// server-confirmed copy back down immediately after saving.
el.retrieveBtn.addEventListener('click', async () => {
  const original = el.retrieveBtn.textContent;
  el.retrieveBtn.disabled = true;
  el.retrieveBtn.textContent = 'Retrieving…';
  try {
    const res = await fetch('/api/fantasy/snapshots', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
    await syncServerSnapshots();
    populateEndpointSelects();
    refreshRange();
  } catch (err) {
    showBanner(`Couldn't retrieve latest stats (${err.message}).`);
  } finally {
    el.retrieveBtn.disabled = false;
    el.retrieveBtn.textContent = original;
  }
});

// ---------------------------------------------------------------------
// Filtering / rendering (same pattern as cards.js)
// ---------------------------------------------------------------------

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

function render(reset) {
  if (reset) state.visibleCount = BATCH_SIZE;
  const filtered = getFiltered();
  const slice = filtered.slice(0, state.visibleCount);

  el.grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  slice.forEach((p) => frag.appendChild(buildCard(p, state.teamMeta, openRangeModal)));
  el.grid.appendChild(frag);

  el.resultCount.textContent = state.fromKey
    ? `Showing ${slice.length.toLocaleString()} of ${filtered.length.toLocaleString()} ${state.mode}`
    : '';
  el.loadMoreWrap.hidden = slice.length >= filtered.length;
}

el.modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode;
    el.modeButtons.forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    el.posToggleGroup.hidden = state.mode === 'goalies';
    state.pos = 'ALL';
    el.posButtons.forEach((b) => b.classList.toggle('active', b.dataset.pos === 'ALL'));
    updateRangeNote();
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

// Re-rate the already-built delta pools in place (no need to recompute
// the deltas) when the column config changes — no need to re-fetch
// anything, just re-run the rating pass with the new category set.
function refreshAfterColumnsChange() {
  if (!state.fromKey) return;
  rerate();
  updateRangeNote();
  render(true);
}

// Columns and Range Ratings are sub-tabs of the same page now, so a
// same-tab Save calls window.__rangeTab.refresh() directly (see
// admin.js). This 'storage' listener is a leftover safety net for the
// cross-tab case (e.g. two admin.html tabs open at once).
window.addEventListener('storage', (e) => {
  if (e.key !== COLUMN_STORAGE_KEY) return;
  refreshAfterColumnsChange();
});

// Exposed for admin.js to call after a Columns Save/Reset.
window.__rangeTab = { refresh: refreshAfterColumnsChange };

// ---------------------------------------------------------------------
// Detail modal — lightweight, no network calls (everything's already
// local): mini card + the full category breakdown for this window.
// ---------------------------------------------------------------------

function closeModal() {
  el.modalRoot.hidden = true;
  document.body.style.overflow = '';
  el.modalContent.innerHTML = '';
}

el.modalClose.addEventListener('click', closeModal);
el.modalOverlay.addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.modalRoot.hidden) closeModal();
});

function openRangeModal(player) {
  el.modalRoot.hidden = false;
  document.body.style.overflow = 'hidden';
  const isGoalie = player.pos === 'G';

  const breakdown = player.ratings.map((r) => `
    <div class="ph-bio-item">
      <span class="label">${escapeHtml(r.label)}</span>
      <span class="value">${escapeHtml(formatColumnValue(r, r.value))} · ${r.rating} rtg</span>
    </div>
  `).join('');

  el.modalContent.innerHTML = `
    <div class="pcard-modal-body">
      <div class="pcard-modal-left">
        ${buildCard(player, state.teamMeta).outerHTML}
      </div>
      <div class="pcard-modal-right">
        <div class="pcard-section">
          <h3 id="modalPlayerName">${escapeHtml(player.name)} — ${escapeHtml(endpointLabel(state.fromKey))} → ${escapeHtml(endpointLabel(state.toKey))}</h3>
          <p class="range-note" style="margin:0 0 12px; padding:0;">
            ${player.gamesPlayed} game${player.gamesPlayed === 1 ? '' : 's'} played in this window. Ratings below
            are percentile ranks against other ${isGoalie ? 'goalies' : 'skaters'} in this same window, not the
            full season.
          </p>
          <div class="ph-bio">${breakdown}</div>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

async function init() {
  el.statusBanner.hidden = true;
  el.skeleton.hidden = false;
  el.grid.innerHTML = '';
  await snapshotsReady; // snapshots.js — server-synced snapshots for the From/To pickers

  try {
    const data = await loadSeasonData();
    state.liveData = data;
    state.teamMeta = data.teamMeta;
    state.seasonId = data.seasonId;
    el.seasonLabel.textContent = `${seasonLabel(data.seasonId)} · Range Ratings`;

    populateEndpointSelects();
    populateTeamSelect();
    refreshRange();
  } catch (err) {
    showBanner(`Couldn't load NHL data (${err.message}). Make sure the local server is running, then retry.`);
  } finally {
    el.skeleton.hidden = true;
  }
}

init();

})();
