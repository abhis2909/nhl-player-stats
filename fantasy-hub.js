'use strict';

/* ======================================================================
   Fantasy Hub page — Trade Analyzer, Power Rankings, Recent Transactions,
   My Avatar. Rating math is 100% reused from ratings.js (ratePool()) —
   this file never invents its own scoring. Trade grades are computed
   from a pool rated ONCE against the full current-season pool (never
   re-rated against just the 2-6 traded players — percentileRank()
   returns 100 for any group of size <=1, so a tiny ad-hoc pool would
   give meaningless numbers). Player search/add reuses guesswho.js's
   typeahead pattern, adapted to this page's combined skater+goalie pool.
   ====================================================================== */

const MAX_PLAYERS_PER_SIDE = 6; // matches api/fantasy/trades.js's server-side cap
const VERDICT_EVEN_MARGIN = 2; // |avgA - avgB| this close or closer reads as "even"

const el = {
  statusBanner: document.getElementById('statusBanner'),
  skeleton: document.getElementById('skeleton'),
  hubGrid: document.getElementById('hubGrid'),

  prModeGroup: document.getElementById('prModeGroup'),
  powerRankList: document.getElementById('powerRankList'),

  sideASearch: document.getElementById('sideASearch'),
  sideASuggestions: document.getElementById('sideASuggestions'),
  sideAList: document.getElementById('sideAList'),
  sideAGrade: document.getElementById('sideAGrade'),
  sideBSearch: document.getElementById('sideBSearch'),
  sideBSuggestions: document.getElementById('sideBSuggestions'),
  sideBList: document.getElementById('sideBList'),
  sideBGrade: document.getElementById('sideBGrade'),
  tradeVerdict: document.getElementById('tradeVerdict'),
  tradeResetBtn: document.getElementById('tradeResetBtn'),
  tradeLogBtn: document.getElementById('tradeLogBtn'),
  tradeLoginHint: document.getElementById('tradeLoginHint'),
  tradeLogStatus: document.getElementById('tradeLogStatus'),

  transactionsList: document.getElementById('transactionsList'),

  avatarPanelBody: document.getElementById('avatarPanelBody'),
};

const state = {
  teamMeta: new Map(),
  searchPool: [], // combined skaters+goalies, already rated — what the trade search filters over
  ratedById: new Map(), // playerId -> rated player object
  ratedSkaters: [],
  ratedGoalies: [],
  prMode: 'skaters',
  tradeSides: { A: [], B: [] }, // arrays of rated player objects
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function headshotUrl(playerId) {
  return `https://assets.nhle.com/mugs/nhl/latest/${playerId}.png`;
}

function toggleSkeleton(show) {
  el.skeleton.hidden = !show;
  el.hubGrid.hidden = show || el.hubGrid.dataset.ready !== '1';
}

function showBanner(message) {
  el.statusBanner.textContent = message;
  el.statusBanner.hidden = false;
}

/* ------------------------------ init ------------------------------ */

async function init() {
  toggleSkeleton(true);
  try {
    const [seasonData, ratingConfigRes] = await Promise.all([
      loadSeasonData(), // data.js
      fetch('/api/fantasy/public-config').then((r) => r.json()).catch(() => null),
    ]);
    state.teamMeta = seasonData.teamMeta;
    const ratingConfig = ratingConfigRes && ratingConfigRes.ok ? ratingConfigRes.ratingSettings : null;

    // Same eligibility pre-filter Player Ratings/the Stats page's Power
    // Ranking column use — a long tail of 1-2-game callups otherwise
    // compresses the percentile range for everyone else.
    const minGpFraction = ratingConfig?.minGpFraction ?? MIN_GP_FRACTION; // ratings.js
    const skaterMinGp = Math.ceil(seasonGameCount(seasonData.skaters) * minGpFraction); // data.js
    const goalieMinGp = Math.ceil(seasonGameCount(seasonData.goalies) * minGpFraction);
    const eligibleSkaters = seasonData.skaters.filter((p) => p.gamesPlayed >= skaterMinGp);
    const eligibleGoalies = seasonData.goalies.filter((p) => p.gamesPlayed >= goalieMinGp);

    state.ratedSkaters = ratePool(eligibleSkaters, 'skaters', ratingConfig); // ratings.js
    state.ratedGoalies = ratePool(eligibleGoalies, 'goalies', ratingConfig);
    state.searchPool = [...state.ratedSkaters, ...state.ratedGoalies];
    for (const p of state.searchPool) state.ratedById.set(p.playerId, p);

    renderPowerRankings();
    await loadTransactions();
    renderAvatarPanel();

    el.hubGrid.dataset.ready = '1';
  } catch (err) {
    showBanner(`Couldn't load Fantasy Hub (${err.message}).`);
  } finally {
    toggleSkeleton(false);
  }
}

/* --------------------------- Power Rankings --------------------------- */

function renderPowerRankings() {
  const pool = state.prMode === 'goalies' ? state.ratedGoalies : state.ratedSkaters;
  const top = pool.slice().sort((a, b) => b.overall - a.overall).slice(0, 10);
  el.powerRankList.innerHTML = top.map((p, i) => `
    <li class="fh-rank-row">
      <span class="fh-rank-num">${i + 1}</span>
      <span class="fh-rank-name">${escapeHtml(p.name)}</span>
      <span class="fh-rank-team">${escapeHtml(p.team)}</span>
      <span class="fh-rank-ovr">${p.overall}</span>
    </li>
  `).join('');
}

el.prModeGroup.querySelectorAll('.toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.prMode = btn.dataset.prMode;
    el.prModeGroup.querySelectorAll('.toggle-btn').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderPowerRankings();
  });
});

/* ---------------------------- Trade Analyzer ---------------------------- */

function sideEls(side) {
  return side === 'A'
    ? { search: el.sideASearch, suggestions: el.sideASuggestions, list: el.sideAList, grade: el.sideAGrade }
    : { search: el.sideBSearch, suggestions: el.sideBSuggestions, list: el.sideBList, grade: el.sideBGrade };
}

function renderSuggestions(side, query) {
  const { search, suggestions } = sideEls(side);
  const q = query.trim().toLowerCase();
  if (!q) { suggestions.hidden = true; suggestions.innerHTML = ''; return; }

  const addedIds = new Set([...state.tradeSides.A, ...state.tradeSides.B].map((p) => p.playerId));
  const matches = state.searchPool
    .filter((p) => !addedIds.has(p.playerId) && p.name.toLowerCase().includes(q))
    .slice(0, 8);

  if (!matches.length) { suggestions.hidden = true; suggestions.innerHTML = ''; return; }

  suggestions.innerHTML = matches.map((p) => `
    <div class="fh-suggestion" data-player-id="${p.playerId}">
      <img src="${headshotUrl(p.playerId)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <span class="fh-suggestion-name">${escapeHtml(p.name)}</span>
      <span class="fh-suggestion-meta">${escapeHtml(p.pos)} · ${escapeHtml(p.team)}</span>
    </div>
  `).join('');
  suggestions.hidden = false;

  suggestions.querySelectorAll('.fh-suggestion').forEach((node) => {
    node.addEventListener('click', () => {
      const player = state.ratedById.get(Number(node.dataset.playerId));
      addToSide(side, player);
      suggestions.hidden = true;
      suggestions.innerHTML = '';
      search.value = '';
      search.focus();
    });
  });
}

function addToSide(side, player) {
  if (!player) return;
  const list = state.tradeSides[side];
  if (list.some((p) => p.playerId === player.playerId)) return;
  if (list.length >= MAX_PLAYERS_PER_SIDE) return;
  list.push(player);
  renderTradeSide(side);
  renderVerdict();
}

function removeFromSide(side, playerId) {
  state.tradeSides[side] = state.tradeSides[side].filter((p) => p.playerId !== playerId);
  renderTradeSide(side);
  renderVerdict();
}

function avgOverall(players) {
  if (!players.length) return 0;
  return Math.round(players.reduce((sum, p) => sum + p.overall, 0) / players.length);
}

function renderTradeSide(side) {
  const { list, grade } = sideEls(side);
  const players = state.tradeSides[side];
  list.innerHTML = players.map((p) => `
    <li class="fh-trade-chip" data-player-id="${p.playerId}">
      <img src="${headshotUrl(p.playerId)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <span class="fh-chip-name">${escapeHtml(p.name)}</span>
      <span class="fh-chip-ovr">${p.overall}</span>
      <button type="button" aria-label="Remove ${escapeHtml(p.name)}">✕</button>
    </li>
  `).join('');
  list.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      removeFromSide(side, Number(btn.closest('.fh-trade-chip').dataset.playerId));
    });
  });
  grade.innerHTML = players.length ? `Avg Power Ranking: <strong>${avgOverall(players)}</strong>` : '—';
  updateTradeActions();
}

/** Single source of truth for "who wins" — used by both the live
 *  verdict display and the payload sent to POST /api/fantasy/trades,
 *  so the logged trade's `winner` always matches what was shown. */
function computeVerdict(sideA, sideB) {
  const avgA = avgOverall(sideA);
  const avgB = avgOverall(sideB);
  const diff = avgA - avgB;
  if (Math.abs(diff) <= VERDICT_EVEN_MARGIN) {
    return { avgA, avgB, winner: 'even', text: `Roughly even (Side A ${avgA} · Side B ${avgB})` };
  }
  return diff > 0
    ? { avgA, avgB, winner: 'A', text: `Side A wins by ${diff} (${avgA} vs ${avgB})` }
    : { avgA, avgB, winner: 'B', text: `Side B wins by ${-diff} (${avgB} vs ${avgA})` };
}

function renderVerdict() {
  const { A, B } = state.tradeSides;
  if (!A.length || !B.length) { el.tradeVerdict.hidden = true; return; }
  el.tradeVerdict.textContent = computeVerdict(A, B).text;
  el.tradeVerdict.hidden = false;
}

function updateTradeActions() {
  const ready = state.tradeSides.A.length > 0 && state.tradeSides.B.length > 0;
  const user = window.fantasyAuth && window.fantasyAuth.getUser();
  el.tradeLogBtn.disabled = !ready;
  el.tradeLoginHint.hidden = !(ready && !user);
}

function resetTrade() {
  state.tradeSides = { A: [], B: [] };
  renderTradeSide('A');
  renderTradeSide('B');
  el.tradeVerdict.hidden = true;
  el.tradeLogStatus.textContent = '';
}

el.sideASearch.addEventListener('input', () => renderSuggestions('A', el.sideASearch.value));
el.sideBSearch.addEventListener('input', () => renderSuggestions('B', el.sideBSearch.value));
document.addEventListener('click', (e) => {
  if (!el.sideASuggestions.contains(e.target) && e.target !== el.sideASearch) {
    el.sideASuggestions.hidden = true;
  }
  if (!el.sideBSuggestions.contains(e.target) && e.target !== el.sideBSearch) {
    el.sideBSuggestions.hidden = true;
  }
});

el.tradeResetBtn.addEventListener('click', resetTrade);

el.tradeLogBtn.addEventListener('click', async () => {
  const user = window.fantasyAuth && window.fantasyAuth.getUser();
  const { A, B } = state.tradeSides;
  if (!user) { el.tradeLoginHint.hidden = false; return; }
  if (!A.length || !B.length) return;

  const { avgA, avgB, winner } = computeVerdict(A, B);
  const toSnapshot = (p) => ({ playerId: p.playerId, name: p.name, team: p.team, pos: p.pos, overall: p.overall });

  el.tradeLogBtn.disabled = true;
  el.tradeLogStatus.textContent = 'Logging…';
  try {
    const res = await fetch('/api/fantasy/trades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sideA: A.map(toSnapshot), sideB: B.map(toSnapshot),
        sideAOverall: avgA, sideBOverall: avgB, winner,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    el.tradeLogStatus.textContent = 'Logged ✓';
    resetTrade();
    await loadTransactions();
  } catch (err) {
    el.tradeLogStatus.textContent = `Couldn't log trade (${err.message}).`;
    el.tradeLogBtn.disabled = state.tradeSides.A.length === 0 || state.tradeSides.B.length === 0;
  }
});

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
    el.transactionsList.innerHTML = '<p class="admin-hint">No trades logged yet — be the first!</p>';
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

window.fantasyAuth.ready.then(() => {
  renderAvatarPanel();
  updateTradeActions();
});
window.fantasyAuth.onChange(() => {
  renderAvatarPanel();
  updateTradeActions();
});

init();
