'use strict';

/* Power Rankings — split out of fantasy-hub.js into its own page (same
   move as Trade Analyzer/Schedule/Team of the Week — Fantasy Hub's
   Tools grid just links here now). Rating math is 100% reused from
   ratings.js (ratePool()) — unchanged from the original panel, just
   living on its own page. */

const el = {
  statusBanner: document.getElementById('statusBanner'),
  skeleton: document.getElementById('skeleton'),
  toolBody: document.getElementById('toolBody'),
  prModeGroup: document.getElementById('prModeGroup'),
  powerRankList: document.getElementById('powerRankList'),
};

const state = {
  ratedSkaters: [],
  ratedGoalies: [],
  prMode: 'skaters',
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toggleSkeleton(show) {
  el.skeleton.hidden = !show;
  el.toolBody.hidden = show || el.toolBody.dataset.ready !== '1';
}

function showBanner(message) {
  el.statusBanner.textContent = message;
  el.statusBanner.hidden = false;
}

async function init() {
  toggleSkeleton(true);
  try {
    const [seasonData, ratingConfigRes] = await Promise.all([
      loadSeasonData(), // data.js
      fetch('/api/fantasy/public-config').then((r) => r.json()).catch(() => null),
    ]);
    const ratingConfig = ratingConfigRes && ratingConfigRes.ok ? ratingConfigRes.ratingSettings : null;

    const skaterMinGp = ratingConfig?.minGamesPlayedSkaters ?? MIN_GAMES_PLAYED_SKATERS; // ratings.js
    const goalieMinGp = ratingConfig?.minGamesPlayedGoalies ?? MIN_GAMES_PLAYED_GOALIES;
    const eligibleSkaters = seasonData.skaters.filter((p) => p.gamesPlayed >= skaterMinGp);
    const eligibleGoalies = seasonData.goalies.filter((p) => p.gamesPlayed >= goalieMinGp);

    state.ratedSkaters = ratePool(eligibleSkaters, 'skaters', ratingConfig); // ratings.js
    state.ratedGoalies = ratePool(eligibleGoalies, 'goalies', ratingConfig);

    renderPowerRankings();
    el.toolBody.dataset.ready = '1';
  } catch (err) {
    showBanner(`Couldn't load Power Rankings (${err.message}).`);
  } finally {
    toggleSkeleton(false);
  }
}

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

init();
