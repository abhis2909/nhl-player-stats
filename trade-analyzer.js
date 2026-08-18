'use strict';

/* ======================================================================
   Trade Analyzer — split out of fantasy-hub.js into its own page
   (Fantasy Hub's Tools grid now just links here, same as Schedule/Team
   of the Week). Logic is otherwise UNCHANGED from the original panel:
   rating math is 100% reused from ratings.js (ratePool()), a trade
   grade is computed from a pool rated ONCE against the full
   current-season pool (never re-rated against just the 2-6 traded
   players — percentileRank() returns 100 for any group of size <=1, so
   a tiny ad-hoc pool would give meaningless numbers), player search
   reuses guesswho.js's typeahead pattern.
   ====================================================================== */

const MAX_PLAYERS_PER_SIDE = 6; // matches api/fantasy/trades.js's server-side cap
const VERDICT_EVEN_MARGIN = 2; // |avgA - avgB| this close or closer reads as "even"

const el = {
  statusBanner: document.getElementById('statusBanner'),
  skeleton: document.getElementById('skeleton'),
  toolBody: document.getElementById('toolBody'),

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
};

const state = {
  searchPool: [], // combined skaters+goalies, already rated — what the trade search filters over
  ratedById: new Map(), // playerId -> rated player object
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
  el.toolBody.hidden = show || el.toolBody.dataset.ready !== '1';
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
    const ratingConfig = ratingConfigRes && ratingConfigRes.ok ? ratingConfigRes.ratingSettings : null;

    // Same eligibility pre-filter Player Ratings/the Stats page's Power
    // Ranking column use — a long tail of 1-2-game callups otherwise
    // compresses the percentile range for everyone else.
    const skaterMinGp = ratingConfig?.minGamesPlayedSkaters ?? MIN_GAMES_PLAYED_SKATERS; // ratings.js
    const goalieMinGp = ratingConfig?.minGamesPlayedGoalies ?? MIN_GAMES_PLAYED_GOALIES;
    const eligibleSkaters = seasonData.skaters.filter((p) => p.gamesPlayed >= skaterMinGp);
    const eligibleGoalies = seasonData.goalies.filter((p) => p.gamesPlayed >= goalieMinGp);

    const ratedSkaters = ratePool(eligibleSkaters, 'skaters', ratingConfig); // ratings.js
    const ratedGoalies = ratePool(eligibleGoalies, 'goalies', ratingConfig);
    state.searchPool = [...ratedSkaters, ...ratedGoalies];
    for (const p of state.searchPool) state.ratedById.set(p.playerId, p);

    el.toolBody.dataset.ready = '1';
  } catch (err) {
    showBanner(`Couldn't load the Trade Analyzer (${err.message}).`);
  } finally {
    toggleSkeleton(false);
  }
}

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
    el.tradeLogStatus.innerHTML = 'Logged ✓ — see it on <a href="fantasy-hub.html">Fantasy Hub</a>.';
    resetTrade();
  } catch (err) {
    el.tradeLogStatus.textContent = `Couldn't log trade (${err.message}).`;
    el.tradeLogBtn.disabled = state.tradeSides.A.length === 0 || state.tradeSides.B.length === 0;
  }
});

/* ------------------------------- boot ------------------------------- */

window.fantasyAuth.ready.then(updateTradeActions);
window.fantasyAuth.onChange(updateTradeActions);

init();
