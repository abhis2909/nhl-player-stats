'use strict';

/* ======================================================================
   Fantasy Hub page — the hub itself: a Tools box grid (Trade Analyzer,
   Power Rankings, Schedule, Team of the Week — each its own page now,
   see trade-analyzer.js/power-rankings.js), Recent Transactions, and
   My Avatar. This file only owns the latter two, plus the Team of the
   Week box's NEW badge (see checkTotwNewBadge() below) — Trade Analyzer
   and Power Rankings used to live here but were split into their own
   pages so they could become clickable boxes here, same as Schedule/
   TOTW already were. columns.js/ratings.js aren't needed on this page
   anymore as a result — Recent Transactions and My Avatar don't touch
   the rating engine at all. data.js IS still loaded, just for its
   todayISO()/mondayOf() date helpers, not loadSeasonData().
   ====================================================================== */

const el = {
  statusBanner: document.getElementById('statusBanner'),
  skeleton: document.getElementById('skeleton'),
  hubGrid: document.getElementById('hubGrid'),

  transactionsList: document.getElementById('transactionsList'),

  avatarPanelBody: document.getElementById('avatarPanelBody'),
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toggleSkeleton(show) {
  el.skeleton.hidden = !show;
  el.hubGrid.hidden = show || el.hubGrid.dataset.ready !== '1';
}

function showBanner(message) {
  el.statusBanner.textContent = message;
  el.statusBanner.hidden = false;
}

/* -------------------------- Team of the Week NEW badge -------------------------- */
/* Shows a "NEW" pill on the Team of the Week box exactly on the one
   calendar day a fresh week becomes available: the daily snapshot cron
   (api/fantasy/snapshots.js) writes a StatsSnapshot dated every day,
   including every Monday — and totw.js treats "a snapshot exists at
   THIS Monday" as "last week is now finished and computable". So
   "today is Monday AND today's snapshot has actually landed" is exactly
   the trigger the user asked for ("when the data is updated for the
   entire previous week"), and since that's only ever true on a single
   calendar day, it also naturally satisfies "have it there for 1 day"
   — no separate expiry timer needed, tomorrow it's just false again.
   Uses the lightweight ?date= existence check (see that file's doc
   comment) rather than the full snapshot-sync endpoint, so this never
   downloads anyone's actual season stats just to show a pill. */
async function checkTotwNewBadge() {
  const badge = document.getElementById('totwBoxNewBadge');
  if (!badge) return;
  const today = todayISO(); // data.js
  if (mondayOf(today) !== today) return; // not Monday — stays hidden, no network call needed
  try {
    const res = await fetch(`/api/fantasy/snapshots?date=${today}`);
    const data = await res.json();
    badge.hidden = !(data.ok && data.exists);
  } catch {
    // Non-fatal — badge just stays hidden, same as any other day.
  }
}

/* ------------------------------ init ------------------------------ */

async function init() {
  toggleSkeleton(true);
  try {
    await loadTransactions();
    renderAvatarPanel();
    el.hubGrid.dataset.ready = '1';
  } catch (err) {
    showBanner(`Couldn't load Fantasy Hub (${err.message}).`);
  } finally {
    toggleSkeleton(false);
  }
  checkTotwNewBadge(); // independent of the try/catch above — never blocks the rest of the page
}

/* -------------------------- Recent Transactions -------------------------- */

async function loadTransactions() {
  let trades = [];
  try {
    const res = await fetch('/api/fantasy/trades?limit=15');
    const data = await res.json();
    trades = (data.ok && data.trades) || [];
  } catch {
    trades = [];
  }
  renderTransactions(trades);
}

function relativeTime(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function renderTransactions(trades) {
  if (!trades.length) {
    el.transactionsList.innerHTML = '<p class="admin-hint">No trades logged yet — <a href="trade-analyzer.html">be the first!</a></p>';
    return;
  }
  el.transactionsList.innerHTML = trades.map((t) => {
    const who = escapeHtml(t.user?.displayName || t.user?.username || 'Someone');
    const sideANames = (t.sideA || []).map((p) => p.name).join(', ');
    const sideBNames = (t.sideB || []).map((p) => p.name).join(', ');
    const winnerLabel = t.winner === 'even' ? 'Even trade' : `Side ${escapeHtml(t.winner)} wins`;
    return `
      <div class="fh-transaction-row">
        ${buildAvatarImg(t.user?.avatarUrl, 32, 'bust')}
        <div class="fh-tx-body">
          <div class="fh-tx-user">${who}</div>
          <div class="fh-tx-sides">${escapeHtml(sideANames)} ⇄ ${escapeHtml(sideBNames)}</div>
        </div>
        <div class="fh-tx-meta">
          <span class="fh-tx-winner">${winnerLabel}</span>
          <span class="fh-tx-time">${relativeTime(t.createdAt)}</span>
        </div>
      </div>
    `;
  }).join('');
}

/* ------------------------------ My Avatar ------------------------------ */
/* Commissioner-managed (see avatar.js's header comment + fantasy-hub/
   scripts/set-avatar.js) — this panel just displays whichever image is
   assigned, no self-serve editor. */

// Resize/compress a picked file down to a small JPEG data: URI before
// it ever leaves the browser — there's no upload/CDN infra here, this
// gets stored as plain text on the User row (see api/fantasy/session.js's
// PATCH), so keeping it small matters. Caps the longer side at 640px,
// preserving aspect ratio (NOT forced square — these are full-body
// portraits), JPEG quality 0.82.
const AVATAR_REQUEST_MAX_DIM = 640;
const AVATAR_REQUEST_JPEG_QUALITY = 0.82;

function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That doesn't look like a valid image."));
      img.onload = () => {
        const scale = Math.min(1, AVATAR_REQUEST_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', AVATAR_REQUEST_JPEG_QUALITY));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function renderAvatarPanel() {
  const user = window.fantasyAuth && window.fantasyAuth.getUser();
  if (!user) {
    el.avatarPanelBody.innerHTML = '<p class="admin-hint">Log in to see your avatar.</p>';
    return;
  }

  const requestSection = user.avatarRequestPending
    ? '<p class="admin-hint">⏳ Your avatar request is pending review — submitting a new one below replaces it.</p>'
    : '';

  el.avatarPanelBody.innerHTML = `
    <div class="fh-avatar-panel-row">
      ${buildAvatarImg(user.avatarUrl, 64)}
      <p class="admin-hint">${user.avatarUrl ? 'Your current avatar.' : 'No avatar set yet.'}</p>
    </div>
    ${requestSection}
    <div class="fh-avatar-request-form">
      <div class="fh-field">
        <label for="avatarRequestFile">${user.avatarRequestPending ? 'Replace your request' : 'Request a new avatar'}</label>
        <input type="file" id="avatarRequestFile" accept="image/*">
      </div>
      <div class="fh-field">
        <label for="avatarRequestNote">Note to your commissioner (optional)</label>
        <input type="text" id="avatarRequestNote" placeholder="e.g. new haircut, different jersey..." maxlength="500">
      </div>
      <button type="button" class="ghost-btn" id="avatarRequestSubmitBtn" disabled>Submit Request</button>
      <p class="fh-trade-status" id="avatarRequestStatus"></p>
    </div>
  `;

  const fileInput = document.getElementById('avatarRequestFile');
  const noteInput = document.getElementById('avatarRequestNote');
  const submitBtn = document.getElementById('avatarRequestSubmitBtn');
  const statusEl = document.getElementById('avatarRequestStatus');
  let pendingDataUrl = null;

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    submitBtn.disabled = true;
    pendingDataUrl = null;
    if (!file) return;
    statusEl.textContent = 'Processing image…';
    try {
      pendingDataUrl = await resizeImageFile(file);
      statusEl.textContent = 'Ready to submit.';
      submitBtn.disabled = false;
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });

  submitBtn.addEventListener('click', async () => {
    if (!pendingDataUrl) return;
    submitBtn.disabled = true;
    statusEl.textContent = 'Submitting…';
    try {
      const res = await fetch('/api/fantasy/session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarRequestUrl: pendingDataUrl, avatarRequestNote: noteInput.value.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
      window.fantasyAuth.setUser(data.user); // triggers onChange -> re-renders this panel showing "pending"
      statusEl.textContent = 'Submitted ✓';
    } catch (err) {
      statusEl.textContent = `Couldn't submit (${err.message}).`;
      submitBtn.disabled = false;
    }
  });
}

/* ------------------------------- boot ------------------------------- */

window.fantasyAuth.ready.then(renderAvatarPanel);
window.fantasyAuth.onChange(renderAvatarPanel);

init();
