'use strict';

/* ======================================================================
   Weekly stats snapshots, shared by the Stats page and Player Cards.

   This is a static site with no database, so snapshots live in this
   browser's localStorage — they will NOT show up on a different device
   or browser. That's a real limitation: if you check the site from your
   phone and your laptop, each has its own snapshot history. Fine for a
   single-user workflow ("I refresh this once a week from my laptop"),
   not fine if you need everyone in the league to see the same frozen
   week. Say if you need that — it'd mean adding real server-side storage
   (Vercel KV/Postgres), which needs your Vercel account to provision.

   Model: "Live" is always available (fetches straight from the NHL API,
   nothing saved). Clicking Retrieve Latest Stats fetches live data once
   and freezes it as a snapshot for THAT CALENDAR WEEK (Monday-Sunday,
   same week boundary the Schedule page uses — see retrieveAndSaveSnapshot()),
   which becomes the active view. Switching the dropdown just changes
   which already-fetched data the Stats/Cards/Range pages compute from —
   no network call. Retrieving again later in the same week updates that
   week's snapshot rather than adding a new one, so one retrieval a week
   is exactly enough — matches the intended workflow of building a Range
   Ratings "team of the week" week over week.
   ====================================================================== */

const SNAPSHOT_STORAGE_KEY = 'nhlStats.snapshots.v1';
const ACTIVE_SNAPSHOT_KEY = 'nhlStats.activeSnapshot.v1';
const MAX_SNAPSHOTS = 30; // ~30 weeks (more than a full season) before the oldest get pruned
const LIVE_SENTINEL = 'live';

function readSnapshotStore() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeSnapshotStore(store) {
  localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(store));
}

function getActiveSnapshotKey() {
  try {
    return localStorage.getItem(ACTIVE_SNAPSHOT_KEY) || LIVE_SENTINEL;
  } catch {
    return LIVE_SENTINEL;
  }
}

function setActiveSnapshotKey(key) {
  try { localStorage.setItem(ACTIVE_SNAPSHOT_KEY, key); } catch { /* ignore */ }
}

/** Saved snapshots, newest first. */
function listSnapshots() {
  const store = readSnapshotStore();
  return Object.entries(store)
    .map(([key, snap]) => ({ key, savedAt: snap.savedAt, label: snap.label }))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

function serializeSeasonData({ seasonId, teamMeta, skaters, goalies }) {
  return { seasonId, teamMeta: Array.from(teamMeta.entries()), skaters, goalies };
}

function deserializeSeasonData(raw) {
  return { seasonId: raw.seasonId, teamMeta: new Map(raw.teamMeta), skaters: raw.skaters, goalies: raw.goalies };
}

/** Fetches fresh live data (network call), saves it as a new snapshot, and
 *  makes it the active one. This is the only place that ever hits the API
 *  on your behalf for a snapshot — switching the dropdown never re-fetches.
 *
 *  Keyed and labeled by the Monday-Sunday week it falls in (via
 *  mondayOf()/formatDateRange() from data.js) — the SAME week boundary
 *  the Schedule page uses — rather than the exact moment you clicked
 *  Retrieve. Two effects, both intentional for a "retrieve once a week
 *  to build a Range Ratings team-of-the-week" workflow: the label reads
 *  like "Sep 28 – Oct 4, 2026", visibly matching what the Schedule page
 *  shows for that same week; and retrieving again later in the same
 *  week updates that week's snapshot in place instead of piling up a
 *  second near-duplicate entry, so a week you retrieved twice still
 *  counts as one snapshot for that week. */
async function retrieveAndSaveSnapshot() {
  const data = await loadSeasonData(); // data.js — always a real fetch
  const now = new Date();
  const weekMonday = mondayOf(todayISO());
  const key = weekMonday;
  const label = formatDateRange(weekMonday, addDays(weekMonday, 6));

  const store = readSnapshotStore();
  store[key] = { savedAt: now.toISOString(), label, data: serializeSeasonData(data) };

  const keys = Object.keys(store).sort();
  while (keys.length > MAX_SNAPSHOTS) delete store[keys.shift()];

  writeSnapshotStore(store);
  setActiveSnapshotKey(key);
  return { key, label, data };
}

/** Permanently removes a saved snapshot (e.g. one retrieved by mistake).
 *  If it was the active one, falls back to Live so the caller isn't left
 *  pointing at a snapshot that no longer exists — the caller should still
 *  re-render after calling this. */
function deleteSnapshot(key) {
  const store = readSnapshotStore();
  delete store[key];
  writeSnapshotStore(store);
  if (getActiveSnapshotKey() === key) setActiveSnapshotKey(LIVE_SENTINEL);
}

/** { key, label, data } for ANY saved snapshot by key (not just the active
 *  one), or null if it doesn't exist OR fails to deserialize. No network
 *  call — pure localStorage read — used to build the rating-trend chart
 *  from snapshot history and by range.js's from/to pickers. The try/catch
 *  matters here specifically: range.js calls this for every saved
 *  snapshot to build its date pickers, and one corrupted entry (e.g. from
 *  a manual localStorage edit) shouldn't take down every other valid
 *  snapshot along with it. */
function getSnapshotByKey(key) {
  const store = readSnapshotStore();
  const snap = store[key];
  if (!snap) return null;
  try {
    return { key, label: snap.label, data: deserializeSeasonData(snap.data) };
  } catch {
    return null;
  }
}

/** { key, label, data } for the active snapshot, or null if set to Live /
 *  the saved snapshot no longer exists (caller should fetch live instead). */
function getActiveSnapshot() {
  const activeKey = getActiveSnapshotKey();
  if (activeKey === LIVE_SENTINEL) return null;
  return getSnapshotByKey(activeKey);
}

/** What the Stats/Cards pages should call instead of loadSeasonData()
 *  directly: returns the active snapshot's data (no network call) if one's
 *  selected, otherwise fetches live. */
async function getSeasonData() {
  const active = getActiveSnapshot();
  if (active) return { ...active.data, source: 'snapshot', snapshotLabel: active.label };
  const data = await loadSeasonData();
  return { ...data, source: 'live', snapshotLabel: null };
}

/** Wires up the shared data-bar markup (#dataSourceLabel / #snapshotSelect /
 *  #retrieveBtn / optional #deleteSnapshotBtn) on whichever page includes
 *  it. `onDataChanged` is called (and awaited) whenever the active snapshot
 *  changes — pass the page's own init/render function. `onError` gets fetch
 *  errors from Retrieve, if any. */
function wireDataBar(onDataChanged, onError) {
  const label = document.getElementById('dataSourceLabel');
  const select = document.getElementById('snapshotSelect');
  const btn = document.getElementById('retrieveBtn');
  const deleteBtn = document.getElementById('deleteSnapshotBtn');
  if (!label || !select || !btn) return;

  function refreshControls() {
    const snapshots = listSnapshots();
    const activeKey = getActiveSnapshotKey();
    const activeExists = snapshots.some((s) => s.key === activeKey);

    select.innerHTML = '';
    const liveOpt = document.createElement('option');
    liveOpt.value = LIVE_SENTINEL;
    liveOpt.textContent = 'Live (current)';
    select.appendChild(liveOpt);
    for (const s of snapshots) {
      const opt = document.createElement('option');
      opt.value = s.key;
      opt.textContent = s.label;
      select.appendChild(opt);
    }
    select.value = activeExists ? activeKey : LIVE_SENTINEL;

    const active = snapshots.find((s) => s.key === activeKey);
    label.textContent = activeExists && active ? `Snapshot: ${active.label}` : 'Live data';

    if (deleteBtn) deleteBtn.hidden = select.value === LIVE_SENTINEL;
  }

  select.addEventListener('change', async () => {
    setActiveSnapshotKey(select.value);
    refreshControls();
    await onDataChanged();
  });

  btn.addEventListener('click', async () => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Retrieving…';
    try {
      await retrieveAndSaveSnapshot();
      refreshControls();
      await onDataChanged();
    } catch (err) {
      if (onError) onError(err);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      const key = select.value;
      if (key === LIVE_SENTINEL) return;
      const snap = listSnapshots().find((s) => s.key === key);
      const snapLabel = snap ? snap.label : 'this snapshot';
      if (!window.confirm(`Delete the "${snapLabel}" snapshot? This can't be undone.`)) return;
      deleteSnapshot(key);
      refreshControls();
      await onDataChanged();
    });
  }

  refreshControls();
}
