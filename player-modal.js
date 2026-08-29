'use strict';

/* ======================================================================
   Shared player detail modal + compare modal — originally cards.js's
   own code, extracted so the Stats page (app.js) can show the exact
   same rich modal (gem-tier card, rating trend, stats window, game log)
   when you click a player row, not a separate simpler one. Any page
   using this needs: data.js, columns.js, snapshots.js, ratings.js
   loaded first (for getJSON/seasonLabel/loadSeasonStatsFor/etc.,
   activeColumns/formatColumnValue, listSnapshots/getSnapshotByKey, and
   ratePool/buildCard/deltaValue/RATING_FLOOR/MIN_GAMES_PLAYED_SKATERS/
   MIN_GAMES_PLAYED_GOALIES/INVERT_STATS respectively) — and the modalRoot/modalOverlay/
   modalClose/modalContent + compareModalRoot/compareModalOverlay/
   compareModalClose/compareModalContent markup in its HTML (see
   index.html for the exact shape).

   Call initPlayerModal(ctx) once after data loads, and again whenever
   the host page's active season/context changes (e.g. app.js's
   Historical/Current Season toggle) — see the ctx shape below. Then
   openPlayerModal(player) opens the modal for any already-rated player
   object (must have .overall/.ratings from ratePool()).
   ====================================================================== */

let pmCtx = {
  teamMeta: new Map(),
  seasonId: null, // the "current" reference season — previous-season stats window steps back one from this, rating trend's Historical tab's own range comes from historicalSeasonIds below
  ratingConfig: null,
  seasonDataCache: new Map(), // seasonId -> { skaters, goalies } raw — shared by reference with the host page's own cache where possible, so nothing gets fetched twice
  currentSeasonRatedSkaters: [],
  currentSeasonRatedGoalies: [],
  historicalSeasonIds: [], // season ids the Rating Trend chart's "Historical" tab walks — index.html passes 2023-24 through 2025-26
  searchPool: [], // combined, already-rated skaters+goalies — what the in-modal "Compare with..." search filters over
};

/** Call once after data loads, and again whenever season/context
 *  changes — merges into the existing context rather than replacing it,
 *  so a caller only needs to pass what actually changed. */
function initPlayerModal(ctx) {
  Object.assign(pmCtx, ctx || {});
}

const pm = {
  modalRoot: document.getElementById('modalRoot'),
  modalOverlay: document.getElementById('modalOverlay'),
  modalClose: document.getElementById('modalClose'),
  modalContent: document.getElementById('modalContent'),
  compareModalRoot: document.getElementById('compareModalRoot'),
  compareModalOverlay: document.getElementById('compareModalOverlay'),
  compareModalClose: document.getElementById('compareModalClose'),
  compareModalContent: document.getElementById('compareModalContent'),
};

function pmEscapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ------------------------------ single-player modal ------------------------------ */

function closePlayerModal() {
  pm.modalRoot.hidden = true;
  document.body.style.overflow = '';
  pm.modalContent.innerHTML = '';
}

if (pm.modalClose) pm.modalClose.addEventListener('click', closePlayerModal);
if (pm.modalOverlay) pm.modalOverlay.addEventListener('click', closePlayerModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pm.modalRoot && !pm.modalRoot.hidden) closePlayerModal();
});

function openPlayerModal(player) {
  if (!pm.modalRoot) return;
  pm.modalRoot.hidden = false;
  document.body.style.overflow = 'hidden';
  pm.modalContent.innerHTML = '<div class="modal-spinner">Loading…</div>';

  getJSON(`${API_WEB}/v1/player/${player.playerId}/landing`)
    .then((landing) => {
      renderModalShell(player, landing);
      wireRatingTrend(player);
      wireStatsWindow(player);
      wireModalGameLog(player, landing);
      wireModalCompare(player);
    })
    .catch((err) => {
      pm.modalContent.innerHTML = `<div class="modal-spinner">Couldn't load player details (${pmEscapeHtml(err.message)}).</div>`;
    });
}

function buildBioSection(player, landing) {
  if (!landing) {
    return `<div class="ph-bio"><div class="ph-bio-item"><span class="value">Bio unavailable right now.</span></div></div>`;
  }
  const age = ageFromBirthDate(landing.birthDate);
  const height = formatHeight(landing.heightInInches);
  const weight = landing.weightInPounds ? `${landing.weightInPounds} lb` : '—';
  const teamName = landing.fullTeamName?.default || pmCtx.teamMeta.get(player.team)?.name || player.team;
  const birthplace = [landing.birthCity?.default, landing.birthStateProvince?.default, landing.birthCountry]
    .filter(Boolean).join(', ');
  const draft = landing.draftDetails
    ? `${landing.draftDetails.year} · Rd ${landing.draftDetails.round}, Pick ${landing.draftDetails.overallPick}`
    : 'Undrafted';
  const shootsLabel = player.pos === 'G' ? 'Catches' : 'Shoots';

  return `
    <div class="ph-bio">
      <div class="ph-bio-item"><span class="label">Age</span><span class="value">${age ?? '—'}</span></div>
      <div class="ph-bio-item"><span class="label">Height</span><span class="value">${height}</span></div>
      <div class="ph-bio-item"><span class="label">Weight</span><span class="value">${weight}</span></div>
      <div class="ph-bio-item"><span class="label">Team</span><span class="value">${pmEscapeHtml(teamName)}</span></div>
      <div class="ph-bio-item"><span class="label">Draft</span><span class="value">${pmEscapeHtml(draft)}</span></div>
      <div class="ph-bio-item"><span class="label">${shootsLabel}</span><span class="value">${landing.shootsCatches ?? '—'}</span></div>
      <div class="ph-bio-item"><span class="label">Birthplace</span><span class="value">${pmEscapeHtml(birthplace) || '—'}</span></div>
    </div>
  `;
}

function renderModalShell(player, landing) {
  pm.modalContent.innerHTML = `
    <div class="pcard-modal-body">
      <div class="pcard-modal-left">
        ${buildCard(player, pmCtx.teamMeta, null, pmCtx.ratingConfig).outerHTML}
        ${buildBioSection(player, landing)}
        <div class="pcard-section" id="modalCompareSection">
          <button type="button" class="ghost-btn" id="modalCompareToggleBtn">⚖ Compare with another player</button>
          <div class="fh-player-search" id="modalCompareSearchWrap" hidden>
            <input type="text" id="modalCompareSearch" placeholder="Search a player…" autocomplete="off">
            <div class="fh-suggestions" id="modalCompareSuggestions" hidden></div>
          </div>
        </div>
      </div>
      <div class="pcard-modal-right">
        <div class="pcard-section">
          <div class="gamelog-head">
            <h3 id="modalPlayerName">${pmEscapeHtml(player.name)} — Rating Trend</h3>
            <div class="gamelog-controls">
              <button type="button" id="trendCurrentBtn" class="active">Current Season</button>
              <button type="button" id="trendHistoricalBtn">Historical</button>
            </div>
          </div>
          <div id="trendWrap"><div class="trend-empty">Start of season.</div></div>
        </div>
        <div class="pcard-section">
          <div class="gamelog-head">
            <h3>Stats</h3>
            <div class="gamelog-controls">
              <select id="statsWindowSelect">${statsWindowOptionsHtml()}</select>
            </div>
          </div>
          <div id="seasonTotalsWrap"><div class="gamelog-loading">Loading…</div></div>
        </div>
        <div class="pcard-section">
          <div class="gamelog-head">
            <h3>Game Log</h3>
            <div class="gamelog-controls">
              <select id="gameLogSeason" aria-label="Season"></select>
              <button type="button" id="gtRegular" class="active">Regular</button>
              <button type="button" id="gtPlayoffs">Playoffs</button>
            </div>
          </div>
          <div id="gameLogWrap"><div class="gamelog-loading">Loading…</div></div>
        </div>
      </div>
    </div>
  `;
}

/** "⚖ Compare with another player" — a collapsed toggle that reveals a
 *  typeahead search (same pattern as guesswho.js/fantasy-hub.js: filter
 *  pmCtx.searchPool by name, cap 8 results, click to pick), which opens
 *  the shared compare modal against `player` once a second one is
 *  chosen. This is the ONLY compare entry point on pages without a card
 *  grid to put a checkbox on (the Stats page) — Player Ratings keeps
 *  its own checkbox+floating-bar flow too, this is additive there. */
function wireModalCompare(player) {
  const toggleBtn = document.getElementById('modalCompareToggleBtn');
  const searchWrap = document.getElementById('modalCompareSearchWrap');
  const input = document.getElementById('modalCompareSearch');
  const suggestions = document.getElementById('modalCompareSuggestions');
  if (!toggleBtn || !searchWrap || !input || !suggestions) return;

  toggleBtn.addEventListener('click', () => {
    searchWrap.hidden = false;
    toggleBtn.hidden = true;
    input.focus();
  });

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { suggestions.hidden = true; suggestions.innerHTML = ''; return; }
    const matches = pmCtx.searchPool
      .filter((p) => p.playerId !== player.playerId && p.name.toLowerCase().includes(q))
      .slice(0, 8);
    if (!matches.length) { suggestions.hidden = true; suggestions.innerHTML = ''; return; }
    suggestions.innerHTML = matches.map((p) => `
      <div class="fh-suggestion" data-player-id="${p.playerId}">
        <img src="https://assets.nhle.com/mugs/nhl/latest/${p.playerId}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <span class="fh-suggestion-name">${pmEscapeHtml(p.name)}</span>
        <span class="fh-suggestion-meta">${pmEscapeHtml(p.pos)} · ${pmEscapeHtml(p.team)}</span>
      </div>
    `).join('');
    suggestions.hidden = false;
    suggestions.querySelectorAll('.fh-suggestion').forEach((node) => {
      node.addEventListener('click', () => {
        const opponent = pmCtx.searchPool.find((p) => p.playerId === Number(node.dataset.playerId));
        suggestions.hidden = true;
        suggestions.innerHTML = '';
        input.value = '';
        if (opponent) openCompareModal(player, opponent);
      });
    });
  });

  document.addEventListener('click', (e) => {
    if (!suggestions.contains(e.target) && e.target !== input) suggestions.hidden = true;
  });
}

/** Wires the standalone "Stats" window selector (6 options — same as the
 *  compare modal's) that drives #seasonTotalsWrap, independent of the
 *  Game Log section's own season/type selector below it. */
function wireStatsWindow(player) {
  const select = document.getElementById('statsWindowSelect');
  if (!select) return;
  select.value = 'currentTotal';
  const load = () => renderPlayerStatsWindow(player, select.value);
  select.addEventListener('change', load);
  load();
}

async function renderPlayerStatsWindow(player, viewKey) {
  const wrap = document.getElementById('seasonTotalsWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="gamelog-loading">Loading…</div>';

  const win = await statsWindowFor(player, viewKey);
  if (!win) {
    wrap.innerHTML = '<div class="gamelog-empty">Not enough data for this view.</div>';
    return;
  }

  const isGoalie = player.pos === 'G';
  // Synthetic columns (Power Ranking) are excluded — a card already
  // shows that number as its own OVR badge, so it'd be a redundant tile.
  const categories = activeColumns(isGoalie ? 'goalies' : 'skaters').filter((c) => !c.synthetic);
  wrap.innerHTML = `
    <div class="ph-stats">
      ${categories.map((c) => `
        <div class="stat-chip" title="${pmEscapeHtml(c.label)}">
          <span class="num">${pmEscapeHtml(formatWindowValue(c, win))}</span>
          <span class="lbl">${pmEscapeHtml(c.short)}</span>
        </div>`).join('')}
    </div>
  `;
}

function wireModalGameLog(player, landing) {
  const seasons = Array.from(new Set(
    (landing?.seasonTotals || [])
      .filter((s) => s.leagueAbbrev === 'NHL')
      .map((s) => s.season),
  )).sort((a, b) => b - a);
  if (seasons.length === 0) seasons.push(pmCtx.seasonId);

  const seasonSelect = document.getElementById('gameLogSeason');
  seasonSelect.innerHTML = seasons.map((s) => `<option value="${s}">${seasonLabel(s)}</option>`).join('');

  const btnReg = document.getElementById('gtRegular');
  const btnPo = document.getElementById('gtPlayoffs');
  let gameType = 2;

  const load = () => loadGameLog(player, seasonSelect.value, gameType);

  seasonSelect.addEventListener('change', load);
  btnReg.addEventListener('click', () => {
    gameType = 2;
    btnReg.classList.add('active');
    btnPo.classList.remove('active');
    load();
  });
  btnPo.addEventListener('click', () => {
    gameType = 3;
    btnPo.classList.add('active');
    btnReg.classList.remove('active');
    load();
  });

  load();
}

// Maps our SKATER_COLUMNS ids to the field names the landing endpoint's
// seasonTotals entries actually use (different naming from the stats-rest
// summary endpoint data.js pulls from). Hits/blocks/giveaways/takeaways
// aren't in seasonTotals at all (realtime-only stats) — shown as "—".
const SEASON_TOTAL_FIELD_MAP = {
  goals: 'goals', assists: 'assists', points: 'points', plusMinus: 'plusMinus',
  ppGoals: 'powerPlayGoals', ppPoints: 'powerPlayPoints', shGoals: 'shorthandedGoals',
  shPoints: 'shorthandedPoints', gameWinningGoals: 'gameWinningGoals', otGoals: 'otGoals',
  pim: 'pim', sog: 'shots', shootingPct: 'shootingPctg', faceoffPct: 'faceoffWinningPctg',
  gamesPlayed: 'gamesPlayed',
};

/** One category's value from a landing seasonTotals entry. Goalies get a
 *  small direct mapping (field names differ enough from our catalog ids
 *  to be clearer spelled out); skaters go through SEASON_TOTAL_FIELD_MAP.
 *  Returns null for anything not present in this endpoint at all. */
function seasonTotalValue(totals, catId, isGoalie) {
  if (isGoalie) {
    switch (catId) {
      case 'wins': return totals.wins ?? 0;
      case 'losses': return totals.losses ?? 0;
      case 'otLosses': return totals.otLosses ?? 0;
      case 'gaa': return totals.goalsAgainstAvg ?? null;
      case 'savePct': return totals.savePctg ?? null;
      case 'saves':
        return typeof totals.shotsAgainst === 'number' && typeof totals.goalsAgainst === 'number'
          ? totals.shotsAgainst - totals.goalsAgainst : null;
      case 'shutouts': return totals.shutouts ?? 0;
      case 'gamesPlayed': return totals.gamesPlayed ?? 0;
      case 'gamesStarted': return totals.gamesStarted ?? 0;
      case 'goalsAgainst': return totals.goalsAgainst ?? 0;
      case 'shotsAgainst': return totals.shotsAgainst ?? 0;
      default: return null;
    }
  }
  const key = SEASON_TOTAL_FIELD_MAP[catId];
  return key ? (totals[key] ?? null) : null;
}

// Per-game data sources for the game log. Regular-season box score fields
// (goals, assists, PPP, etc.) come straight from the game-log endpoint.
// Hits/blocks/giveaways/takeaways aren't in that response at all — they
// come from a second, batched query to the stats-rest API's per-game
// realtime report (isGame=true). Anything not resolvable per game
// (shootingPct, faceoffPct) shows as "—".
const GAMELOG_FIELD_MAP = {
  goals: 'goals', assists: 'assists', points: 'points', plusMinus: 'plusMinus',
  ppGoals: 'powerPlayGoals', ppPoints: 'powerPlayPoints', shGoals: 'shorthandedGoals',
  shPoints: 'shorthandedPoints', gameWinningGoals: 'gameWinningGoals', otGoals: 'otGoals',
  pim: 'pim', sog: 'shots',
};
const REALTIME_FIELD_MAP = { hits: 'hits', blocks: 'blockedShots', giveaways: 'giveaways', takeaways: 'takeaways' };

async function loadGameLog(player, season, gameType) {
  const gameLogWrap = document.getElementById('gameLogWrap');
  if (!gameLogWrap) return;
  gameLogWrap.innerHTML = '<div class="gamelog-loading">Loading…</div>';

  const isGoalie = player.pos === 'G';
  const categories = activeColumns(isGoalie ? 'goalies' : 'skaters').filter((c) => !c.synthetic);

  try {
    const logData = await getJSON(`${API_WEB}/v1/player/${player.playerId}/game-log/${season}/${gameType}`);
    const games = logData.gameLog || [];

    if (games.length === 0) {
      const label = gameType === 3 ? 'playoff' : 'regular season';
      gameLogWrap.innerHTML = `<div class="gamelog-empty">No ${label} games found for ${seasonLabel(season)}.</div>`;
      return;
    }

    if (!isGoalie) {
      const needsRealtime = categories.some((c) => REALTIME_FIELD_MAP[c.id]);
      if (needsRealtime) {
        const orExpr = games.map((g) => `gameId=${g.gameId}`).join(' or ');
        const filter = `(${orExpr}) and playerId=${player.playerId}`;
        try {
          const rt = await getJSON(`${API_STATS}/en/skater/realtime?isGame=true&cayenneExp=${encodeURIComponent(filter)}`);
          const byGame = new Map((rt.data || []).map((r) => [r.gameId, r]));
          for (const g of games) g._realtime = byGame.get(g.gameId) || {};
        } catch {
          // Non-fatal — those columns just show "—" for this player.
        }
      }
    }

    gameLogWrap.innerHTML = buildGameLogTable(games, categories, isGoalie);
  } catch (err) {
    gameLogWrap.innerHTML = `<div class="gamelog-empty">Couldn't load game log (${pmEscapeHtml(err.message)}).</div>`;
  }
}

/** A single game's value for `catId` — the shared building block for the
 *  game-log table. Returns null if that stat isn't resolvable per game
 *  (shootingPct, faceoffPct). */
function perGameValue(g, catId, isGoalie) {
  if (isGoalie) {
    switch (catId) {
      case 'wins': return g.decision === 'W' ? 1 : 0;
      case 'losses': return g.decision === 'L' ? 1 : 0;
      case 'otLosses': return g.decision === 'O' ? 1 : 0;
      case 'shutouts': return g.shutouts ?? 0;
      case 'gamesStarted': return g.gamesStarted ?? 0;
      case 'gamesPlayed': return 1;
      case 'goalsAgainst': return g.goalsAgainst ?? 0;
      case 'shotsAgainst': return g.shotsAgainst ?? 0;
      case 'saves': return Math.max(0, (g.shotsAgainst ?? 0) - (g.goalsAgainst ?? 0));
      case 'gaa': {
        const minutes = parseToiMinutes(g.toi);
        return minutes > 0 && typeof g.goalsAgainst === 'number' ? (g.goalsAgainst / minutes) * 60 : null;
      }
      case 'savePct': return typeof g.savePctg === 'number' ? g.savePctg : null;
      default: return null;
    }
  }
  if (REALTIME_FIELD_MAP[catId]) return g._realtime?.[REALTIME_FIELD_MAP[catId]] ?? null;
  if (GAMELOG_FIELD_MAP[catId]) return g[GAMELOG_FIELD_MAP[catId]] ?? null;
  return null;
}

function parseToiMinutes(toi) {
  if (!toi || typeof toi !== 'string') return 0;
  const [m, s] = toi.split(':').map(Number);
  return (m || 0) + (s || 0) / 60;
}

function buildGameLogTable(games, categories, isGoalie) {
  const DECISION_COL = { wins: 'W', losses: 'L', otLosses: 'O' };
  const head = `<tr><th>Date</th><th>Opp</th>${categories.map((c) => `<th title="${pmEscapeHtml(c.label)}">${pmEscapeHtml(c.short)}</th>`).join('')}</tr>`;

  const rows = games.map((g) => {
    const opp = (g.homeRoadFlag === 'H' ? 'vs ' : '@ ') + (g.opponentAbbrev ?? '');
    const cells = categories.map((c) => {
      if (isGoalie && DECISION_COL[c.id]) {
        const isThis = g.decision === DECISION_COL[c.id];
        const cls = isThis ? (c.id === 'wins' ? 'result-w' : c.id === 'losses' ? 'result-l' : 'result-o') : '';
        const label = c.id === 'otLosses' ? 'OT' : DECISION_COL[c.id];
        return `<td class="${cls}">${isThis ? label : '–'}</td>`;
      }
      const raw = perGameValue(g, c.id, isGoalie);
      const display = raw == null ? '—' : pmEscapeHtml(formatColumnValue(c, raw));
      return `<td>${display}</td>`;
    }).join('');
    return `<tr><td>${formatDate(g.gameDate)}</td><td>${pmEscapeHtml(opp)}</td>${cells}</tr>`;
  }).join('');

  return `<div class="gamelog-table-wrap"><table class="gamelog-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

/* ------------------------------ rating trend ------------------------------ */

/** Groups `entries` (oldest -> newest, `{ snap, full }` pairs already
 *  filtered to one season) into one per calendar month — keeping the
 *  LAST (most recent) entry in each month, i.e. "where the rating stood
 *  by the end of that month" — instead of one point per individual
 *  saved snapshot. Snapshot keys are plain YYYY-MM-DD dates (see
 *  snapshots.js); a key that doesn't look like a date (very old,
 *  pre-database local data) falls back to being its own bucket rather
 *  than crashing. */
function monthlySnapshots(entries) {
  const byMonth = new Map();
  for (const entry of entries) {
    const key = /^\d{4}-\d{2}/.test(entry.snap.key) ? entry.snap.key.slice(0, 7) : entry.snap.key;
    byMonth.set(key, entry); // later (more recent) entry in the same month overwrites
  }
  return Array.from(byMonth.values());
}

/** "Aug 2026" from a YYYY-MM(-DD) snapshot key. Falls back to the raw
 *  key if it doesn't parse as a date (see monthlySnapshots()). */
function monthLabel(dateKey) {
  const d = new Date(`${dateKey.slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Builds the rating-trend chart's data points from saved snapshots (see
 *  snapshots.js), NOT from the game log — this is a trend of "what would
 *  this player's overall rating have been around each point in the
 *  season", not a per-game breakdown. Snapshots are bucketed to one per
 *  CALENDAR MONTH (monthlySnapshots(), above) rather than the raw one-
 *  per-day granularity the underlying snapshots are saved at — a season-
 *  long trend reads as noise at daily resolution. Each month's snapshot
 *  is re-rated independently against its OWN eligibility pool (same
 *  MIN_GAMES_PLAYED_SKATERS/GOALIES rule as the live pool) so the
 *  comparison is always fair for that point in time. Only snapshots
 *  from pmCtx.seasonId are included. The
 *  final "Live" point always comes from pmCtx.currentSeasonRated* (NOT
 *  whatever the host page's own grid/table happens to be displaying) —
 *  otherwise viewing a past season elsewhere on the page would leak
 *  into and mislabel this chart's "Live" point. */
function buildSnapshotTrendPoints(player) {
  const isGoalie = player.pos === 'G';
  const mode = isGoalie ? 'goalies' : 'skaters';
  const minGP = isGoalie
    ? (pmCtx.ratingConfig?.minGamesPlayedGoalies ?? MIN_GAMES_PLAYED_GOALIES)
    : (pmCtx.ratingConfig?.minGamesPlayedSkaters ?? MIN_GAMES_PLAYED_SKATERS);
  const points = [];

  const chronological = listSnapshots().slice().reverse(); // listSnapshots() is newest-first
  const seasonSnaps = [];
  for (const snap of chronological) {
    const full = getSnapshotByKey(snap.key);
    if (!full || full.data.seasonId !== pmCtx.seasonId) continue;
    seasonSnaps.push({ snap, full });
  }

  for (const { snap, full } of monthlySnapshots(seasonSnaps)) {
    const rawPool = isGoalie ? full.data.goalies : full.data.skaters;
    const eligible = rawPool.filter((p) => p.gamesPlayed >= minGP);

    const rated = ratePool(eligible, mode, pmCtx.ratingConfig);
    const found = rated.find((p) => p.playerId === player.playerId);
    if (found) points.push({ label: monthLabel(snap.key), value: found.overall });
  }

  const livePool = isGoalie ? pmCtx.currentSeasonRatedGoalies : pmCtx.currentSeasonRatedSkaters;
  const live = livePool.find((p) => p.playerId === player.playerId);
  if (live) points.push({ label: 'Live', value: live.overall });

  return points;
}

/** Renders the CURRENT-season weekly-snapshot trend into #trendWrap. */
function renderSnapshotTrend(player) {
  const trendWrap = document.getElementById('trendWrap');
  if (!trendWrap) return;

  const points = buildSnapshotTrendPoints(player);
  if (points.length < 2) {
    trendWrap.innerHTML = '<div class="trend-empty">Start of season — retrieve stats weekly once the season begins to build a trend here.</div>';
    return;
  }
  trendWrap.innerHTML = `<div class="trend-chart-wrap">${buildTrendSvg(points)}</div>`;
}

/** One point per season in pmCtx.historicalSeasonIds — this player's
 *  overall rating within THAT season's own pool, so it's a career
 *  trajectory rather than a within-season progression. Reuses
 *  pmCtx.seasonDataCache (a season already browsed elsewhere on the
 *  host page needs no extra fetch); anything not yet cached is fetched
 *  here, in parallel. Skips a season entirely if the player didn't play
 *  (or wasn't rated as eligible) in it. */
async function buildHistoricalTrendPoints(player) {
  const isGoalie = player.pos === 'G';
  const mode = isGoalie ? 'goalies' : 'skaters';
  const seasons = pmCtx.historicalSeasonIds.slice().reverse(); // oldest to newest

  await Promise.all(seasons.map(async (id) => {
    if (pmCtx.seasonDataCache.has(id)) return;
    const data = await loadSeasonStatsFor(id, pmCtx.teamMeta);
    pmCtx.seasonDataCache.set(id, { skaters: data.skaters, goalies: data.goalies });
  }));

  const minGP = isGoalie
    ? (pmCtx.ratingConfig?.minGamesPlayedGoalies ?? MIN_GAMES_PLAYED_GOALIES)
    : (pmCtx.ratingConfig?.minGamesPlayedSkaters ?? MIN_GAMES_PLAYED_SKATERS);
  const points = [];
  for (const id of seasons) {
    const raw = pmCtx.seasonDataCache.get(id);
    if (!raw) continue;
    const pool = isGoalie ? raw.goalies : raw.skaters;
    const eligible = pool.filter((p) => p.gamesPlayed >= minGP);
    const rated = ratePool(eligible, mode, pmCtx.ratingConfig);
    const found = rated.find((p) => p.playerId === player.playerId);
    if (found) points.push({ label: seasonLabel(id), value: found.overall });
  }
  return points;
}

/** Renders the cross-season (career) trend into #trendWrap. */
async function renderHistoricalTrend(player) {
  const trendWrap = document.getElementById('trendWrap');
  if (!trendWrap) return;
  trendWrap.innerHTML = '<div class="trend-empty">Loading…</div>';

  const points = await buildHistoricalTrendPoints(player);
  if (points.length < 2) {
    trendWrap.innerHTML = '<div class="trend-empty">Not enough seasons of data for this player.</div>';
    return;
  }
  trendWrap.innerHTML = `<div class="trend-chart-wrap">${buildTrendSvg(points)}</div>`;
}

/** Wires the Current Season / Historical toggle above the Rating Trend
 *  chart and renders the default (Current Season) view. */
function wireRatingTrend(player) {
  const btnCurrent = document.getElementById('trendCurrentBtn');
  const btnHistorical = document.getElementById('trendHistoricalBtn');
  if (!btnCurrent || !btnHistorical) return;

  btnCurrent.addEventListener('click', () => {
    btnCurrent.classList.add('active');
    btnHistorical.classList.remove('active');
    renderSnapshotTrend(player);
  });
  btnHistorical.addEventListener('click', () => {
    btnHistorical.classList.add('active');
    btnCurrent.classList.remove('active');
    renderHistoricalTrend(player);
  });

  renderSnapshotTrend(player);
}

function buildTrendSvg(points) {
  const w = 600, h = 170, padL = 26, padR = 14, padT = 20, padB = 24;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const values = points.map((p) => p.value);
  const minV = Math.min(...values, RATING_FLOOR);
  const maxV = Math.max(...values, RATING_FLOOR + 5);
  const span = Math.max(1, maxV - minV);
  const xFor = (i) => (points.length === 1 ? padL + innerW / 2 : padL + (i / (points.length - 1)) * innerW);
  const yFor = (v) => padT + innerH - ((v - minV) / span) * innerH;

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(p.value).toFixed(1)}`).join(' ');
  const areaD = `${pathD} L ${xFor(points.length - 1).toFixed(1)} ${(padT + innerH).toFixed(1)} L ${xFor(0).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`;

  const marks = points.map((p, i) => `
    <circle cx="${xFor(i).toFixed(1)}" cy="${yFor(p.value).toFixed(1)}" r="3.5" fill="var(--accent)" stroke="#0b0f14" stroke-width="1"></circle>
    <text x="${xFor(i).toFixed(1)}" y="${(yFor(p.value) - 9).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text)">${p.value}</text>
    <text x="${xFor(i).toFixed(1)}" y="${h - 6}" text-anchor="middle" font-size="10" fill="var(--text-faint)">${pmEscapeHtml(p.label)}</text>
  `).join('');

  return `
    <svg class="trend-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Rating trend">
      <path d="${areaD}" fill="var(--accent)" opacity="0.12"></path>
      <path d="${pathD}" fill="none" stroke="var(--accent)" stroke-width="2"></path>
      ${marks}
    </svg>
  `;
}

/* ------------------------------ stats windows ------------------------------
   Shared by the compare modal and the single-player modal's Stats
   section. Six views: previous/current season totals + per-game, and
   last week totals + per-game. */

const PREV_SEASON_OFFSET = 10001; // NHL season ids are YYYYYYYY+1; subtract this to step back one season
const PER_GAME_EXEMPT = new Set(['shootingPct', 'faceoffPct', 'gaa', 'savePct']); // already rates — per-game toggle leaves these as-is

const STATS_WINDOW_OPTIONS = [
  { key: 'prevTotal', label: () => `${seasonLabel(pmCtx.seasonId - PREV_SEASON_OFFSET)} Season (Total)` },
  { key: 'prevPerGame', label: () => `${seasonLabel(pmCtx.seasonId - PREV_SEASON_OFFSET)} Season (Per Game)` },
  { key: 'currentTotal', label: () => `${seasonLabel(pmCtx.seasonId)} Season (Total)` },
  { key: 'currentPerGame', label: () => `${seasonLabel(pmCtx.seasonId)} Season (Per Game)` },
  { key: 'lastWeekTotal', label: () => 'Last Week (Total)' },
  { key: 'lastWeekPerGame', label: () => 'Last Week (Per Game)' },
];

function statsWindowOptionsHtml() {
  return STATS_WINDOW_OPTIONS.map((o) => `<option value="${o.key}">${pmEscapeHtml(o.label())}</option>`).join('');
}

/** { raw, gamesPlayed, perGame } for `player` in one of the 6 windows
 *  above, or null if that window isn't available right now (no
 *  previous-season data, or missing weekly snapshots for "last week").
 *  `raw` always carries every catalog stat id it can resolve, including
 *  hits/blocks/giveaways/takeaways where possible:
 *   - current season: the already-loaded rated `player` object itself
 *     (built from data.js's buildSkaters/buildGoalies, which already
 *     merges in realtime stats) — no fetch needed.
 *   - previous season: landing.seasonTotals (doesn't have realtime
 *     stats) PLUS a supplemental stats-rest realtime query for that
 *     specific season, merged in.
 *   - last week: raw snapshot skater/goalie records, which already
 *     include realtime stats (every snapshot is a full buildSkaters()
 *     capture) — subtracted via the shared deltaValue() (ratings.js). */
async function statsWindowFor(player, viewKey) {
  const isGoalie = player.pos === 'G';
  const categories = activeColumns(isGoalie ? 'goalies' : 'skaters').filter((c) => !c.synthetic);
  const perGame = viewKey.endsWith('PerGame');

  if (viewKey === 'currentTotal' || viewKey === 'currentPerGame') {
    const gp = player.gamesPlayed ?? 0;
    if (!gp) return null;
    return { raw: player, gamesPlayed: gp, perGame };
  }

  if (viewKey === 'prevTotal' || viewKey === 'prevPerGame') {
    const prevSeasonId = pmCtx.seasonId - PREV_SEASON_OFFSET;
    let landing;
    try {
      landing = await getJSON(`${API_WEB}/v1/player/${player.playerId}/landing`);
    } catch {
      return null;
    }
    const totals = (landing.seasonTotals || []).find(
      (s) => s.leagueAbbrev === 'NHL' && s.season === prevSeasonId && s.gameTypeId === 2,
    );
    if (!totals) return null;

    const raw = { gamesPlayed: totals.gamesPlayed ?? 0 };
    for (const cat of categories) {
      if (cat.id === 'gamesPlayed') continue;
      raw[cat.id] = seasonTotalValue(totals, cat.id, isGoalie);
    }
    if (!isGoalie && categories.some((c) => REALTIME_FIELD_MAP[c.id])) {
      try {
        const filter = `seasonId=${prevSeasonId} and gameTypeId=2 and playerId=${player.playerId}`;
        const rt = await getJSON(`${API_STATS}/en/skater/realtime?cayenneExp=${encodeURIComponent(filter)}`);
        const row = rt.data?.[0];
        if (row) {
          raw.hits = row.hits ?? 0;
          raw.blocks = row.blockedShots ?? 0;
          raw.giveaways = row.giveaways ?? 0;
          raw.takeaways = row.takeaways ?? 0;
        }
      } catch {
        // Non-fatal — those columns just show "—" for this player/season.
      }
    }
    return { raw, gamesPlayed: raw.gamesPlayed, perGame };
  }

  if (viewKey === 'lastWeekTotal' || viewKey === 'lastWeekPerGame') {
    const thisMonday = mondayOf(todayISO());
    const lastMonday = addDays(thisMonday, -7);
    const fromFull = getSnapshotByKey(lastMonday);
    const toFull = getSnapshotByKey(thisMonday);
    if (!fromFull || !toFull) return null;

    const fromList = isGoalie ? fromFull.data.goalies : fromFull.data.skaters;
    const toList = isGoalie ? toFull.data.goalies : toFull.data.skaters;
    const fromP = fromList.find((p) => p.playerId === player.playerId) || {};
    const toP = toList.find((p) => p.playerId === player.playerId);
    if (!toP) return null;

    const gpDelta = (toP.gamesPlayed ?? 0) - (fromP.gamesPlayed ?? 0);
    if (gpDelta <= 0) return null;
    const raw = { gamesPlayed: gpDelta };
    for (const cat of categories) {
      if (cat.id === 'gamesPlayed') continue;
      raw[cat.id] = deltaValue(cat.id, fromP, toP, isGoalie);
    }
    return { raw, gamesPlayed: gpDelta, perGame };
  }

  return null;
}

function statsWindowValue(win, catId) {
  if (!win) return null;
  const raw = win.raw[catId];
  if (raw == null) return null;
  if (win.perGame && !PER_GAME_EXEMPT.has(catId) && win.gamesPlayed > 0) return raw / win.gamesPlayed;
  return raw;
}

function formatWindowValue(col, win) {
  const value = statsWindowValue(win, col.id);
  if (value == null) return '—';
  if (win.perGame && !PER_GAME_EXEMPT.has(col.id)) return value.toFixed(2);
  return formatColumnValue(col, value);
}

/* ------------------------------ compare modal ------------------------------ */

function closeCompareModal() {
  if (!pm.compareModalRoot) return;
  pm.compareModalRoot.hidden = true;
  document.body.style.overflow = '';
  pm.compareModalContent.innerHTML = '';
}

if (pm.compareModalClose) pm.compareModalClose.addEventListener('click', closeCompareModal);
if (pm.compareModalOverlay) pm.compareModalOverlay.addEventListener('click', closeCompareModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pm.compareModalRoot && !pm.compareModalRoot.hidden) closeCompareModal();
});

async function renderCompareTable(a, b, viewKey) {
  const wrap = document.getElementById('compareTableWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="gamelog-loading">Loading…</div>';

  const [winA, winB] = await Promise.all([statsWindowFor(a, viewKey), statsWindowFor(b, viewKey)]);
  if (!winA || !winB) {
    const missing = !winA ? a.name : b.name;
    wrap.innerHTML = `<div class="gamelog-empty">Not enough data for this view for ${pmEscapeHtml(missing)}.</div>`;
    return;
  }

  const isGoalie = a.pos === 'G';
  const categories = activeColumns(isGoalie ? 'goalies' : 'skaters').filter((c) => !c.synthetic);

  const overallRow = `
    <tr class="cmp-overall-row">
      <td class="cmp-val ${a.overall > b.overall ? 'cmp-win' : ''}">${a.overall}</td>
      <td class="cmp-label" title="Season-long overall rating">OVR</td>
      <td class="cmp-val ${b.overall > a.overall ? 'cmp-win' : ''}">${b.overall}</td>
    </tr>`;

  const rows = categories.map((cat) => {
    const av = statsWindowValue(winA, cat.id);
    const bv = statsWindowValue(winB, cat.id);
    const inverted = INVERT_STATS.has(cat.id);
    let aWin = false;
    let bWin = false;
    if (av != null && bv != null && av !== bv) {
      aWin = inverted ? av < bv : av > bv;
      bWin = !aWin;
    }
    return `
      <tr>
        <td class="cmp-val ${aWin ? 'cmp-win' : ''}">${pmEscapeHtml(formatWindowValue(cat, winA))}</td>
        <td class="cmp-label" title="${pmEscapeHtml(cat.label)}">${pmEscapeHtml(cat.short)}</td>
        <td class="cmp-val ${bWin ? 'cmp-win' : ''}">${pmEscapeHtml(formatWindowValue(cat, winB))}</td>
      </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="compare-table"><tbody>${overallRow}${rows}</tbody></table>`;
}

function openCompareModal(a, b) {
  if (!pm.compareModalRoot) return;
  pm.compareModalRoot.hidden = false;
  document.body.style.overflow = 'hidden';

  pm.compareModalContent.innerHTML = `
    <div class="compare-heads">
      <div class="compare-head">${buildCard(a, pmCtx.teamMeta, null, pmCtx.ratingConfig).outerHTML}</div>
      <div class="compare-vs">VS</div>
      <div class="compare-head">${buildCard(b, pmCtx.teamMeta, null, pmCtx.ratingConfig).outerHTML}</div>
    </div>
    <div class="stats-window-bar">
      <label for="compareViewSelect">Stats</label>
      <select id="compareViewSelect">${statsWindowOptionsHtml()}</select>
    </div>
    <div id="compareTableWrap"><div class="gamelog-loading">Loading…</div></div>
  `;

  const select = document.getElementById('compareViewSelect');
  select.value = 'currentTotal';
  select.addEventListener('change', () => renderCompareTable(a, b, select.value));
  renderCompareTable(a, b, 'currentTotal');
}
