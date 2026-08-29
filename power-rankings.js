'use strict';

/* Power Rankings — split out of fantasy-hub.js into its own page (same
   move as Trade Analyzer/Schedule/Team of the Week — Fantasy Hub's
   Tools grid just links here now). Rating math is 100% reused from
   ratings.js (ratePool()) — unchanged from the original panel, just
   living on its own page.

   Ranked on PROJECTED stats for the upcoming season, not the just-
   completed season's real totals — reuses the exact same projections.js
   engine and auto-detect the Stats page's own Current Season view uses
   (see app.js's loadCurrentSeasonView()): a live rest-of-season blend
   once that season has any real games recorded, else the pure preseason
   age-curve projection. No separate toggle here — Power Rankings is a
   compact single view, so it just always shows whichever of those two
   the calendar currently calls for. */

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

/** Fetches the 4 historical seasons + bio pool + admin settings that
 *  projections.js's builders need for `projectedSeasonId` — mirrors the
 *  Stats page's own loadProjectionInputs() (app.js), minus the
 *  seasonDataCache reuse (this page has no other view to share it with). */
async function loadProjectionInputs(projectedSeasonId, teamMeta) {
  const histIds = historicalSeasonIds(projectedSeasonId); // projections.js — 4 seasons immediately before it
  const [historicalData, bioPool, configRes] = await Promise.all([
    Promise.all(histIds.map(async (histId) => {
      const data = await loadSeasonStatsFor(histId, teamMeta); // data.js
      const toiByPlayer = await loadSkaterTimeOnIce(histId); // data.js
      return { seasonId: histId, skaters: data.skaters, goalies: data.goalies, toiByPlayer };
    })),
    loadPlayerBioPool(teamMeta), // data.js
    fetch(`/api/fantasy/public-config?season=${encodeURIComponent(seasonLabel(projectedSeasonId))}`).then((r) => r.json()),
  ]);
  if (!configRes.ok) throw new Error(configRes.message || 'could not load projection settings');
  return { historicalData, bioPool, deployment: configRes.deployment, settings: configRes.settings, ratingConfig: configRes.ratingSettings };
}

/** Power Rankings' player pool: the upcoming season's projected stats
 *  instead of the just-completed season's real totals — see this file's
 *  header comment for the live/preseason auto-detect. */
async function loadProjectedSeasonPool() {
  const standings = await getJSON(`${API_WEB}/v1/standings/now`); // data.js
  const teamMeta = buildTeamMeta(standings); // data.js
  const seasonId = standings.standings?.[0]?.seasonId || fallbackSeasonId(); // data.js
  const projectedSeasonId = seasonId + 10001;

  const currentRaw = await loadSeasonStatsFor(projectedSeasonId, teamMeta); // data.js
  const isLive = currentRaw.skaters.length > 0; // has the projected season actually started yet?

  const { historicalData, bioPool, deployment, settings, ratingConfig } =
    await loadProjectionInputs(projectedSeasonId, teamMeta);

  const built = isLive
    ? buildRestOfSeasonProjection({ // projections.js
      currentSeasonId: projectedSeasonId,
      currentRaw: { skaters: currentRaw.skaters, goalies: currentRaw.goalies },
      historicalData, bioPool, teamMeta, deployment, settings,
    })
    : buildProjectedSeason({ // projections.js
      projectedSeasonId, historicalData, bioPool, teamMeta, deployment, settings,
    });

  return { skaters: built.skaters, goalies: built.goalies, ratingConfig };
}

async function init() {
  toggleSkeleton(true);
  try {
    const { skaters, goalies, ratingConfig } = await loadProjectedSeasonPool();

    const skaterMinGp = ratingConfig?.minGamesPlayedSkaters ?? MIN_GAMES_PLAYED_SKATERS; // ratings.js
    const goalieMinGp = ratingConfig?.minGamesPlayedGoalies ?? MIN_GAMES_PLAYED_GOALIES;
    const eligibleSkaters = skaters.filter((p) => p.gamesPlayed >= skaterMinGp);
    const eligibleGoalies = goalies.filter((p) => p.gamesPlayed >= goalieMinGp);

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
