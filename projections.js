'use strict';

/* ======================================================================
   Projected-season stats — the "Projected" option on the Stats page's
   Season toggle (app.js). Builds a full { seasonId, teamMeta, skaters,
   goalies } object SHAPED IDENTICALLY to data.js's loadSeasonStatsFor(),
   so app.js's render/sort/filter/Total-Per-Game/Qualified-only code
   needs zero changes to display it — a projected player is just a
   normal player object whose gamesPlayed is a projected total instead
   of a real one.

   Methodology (full writeup: the Phase 2 plan) —
   for each stat column, per player:
     1. WEIGHTED HISTORY: a recency-weighted average of the player's
        own per-game rate over their qualifying seasons among the 4
        immediately before the projected one (qualifying = met
        ratings.js's MIN_GP_FRACTION that season, same eligibility bar
        used everywhere else on the site). Weights come from admin-
        tunable ProjectionSettings.seasonWeights and are RENORMALIZED
        over just the seasons the player actually qualified in, so a
        shorter track record doesn't get deflated toward zero — it's
        just a smaller sample feeding the same kind of average.
     2. AGE ADJUSTMENT: a quadratic regression curve of rate-vs-age is
        fit INDEPENDENTLY per (position group, stat column) from the
        same 4 seasons' pooled league-wide data (see fitAgeCurves()).
        Every stat gets its own curve — an aging defenseman's "blocks"
        curve and "points" curve are free to move in opposite
        directions, which is what actually captures a shifting role
        with age, with no separate role-shift model needed. The
        player's predicted rate at their age entering the projected
        season, divided by their predicted rate at their age in their
        most recent qualifying season, is that stat's multiplier —
        clipped to [multiplierClipMin, multiplierClipMax] since a
        4-season sample gets thin at the young/old tails.
     3. DEPLOYMENT: if the admin entered a projected toiPerGame /
        ppToiPerGame / gamesProjected for this player (PlayerDeployment,
        via /api/fantasy/public-config), scale by
        projected ÷ their own weighted-historical average of that same
        metric. Optional per player — no override means multiplier 1.
     4. ROOKIES (0 qualifying seasons): no personal baseline to weight,
        so the age curve's predicted rate IS the baseline, and
        deployment (if entered) compares against the POSITION GROUP's
        average TOI rather than a personal history that doesn't exist.

   Rate-type columns (columns.js's `fmt`, e.g. shootingPct/gaa/savePct)
   skip deployment scaling (role change doesn't mechanically move a
   rate the way TOI moves a counting stat) and are never multiplied by
   games played — same "already a rate" treatment app.js's
   toPerGame()/formatStatValue() already give them.
   ====================================================================== */

const PROJECTION_SEASONS_BACK = 4;

// The real scheduled length of the season being projected — 2026-27 is an
// 84-game season (not the usual 82). Caps the DEFAULT (historical-average)
// games-played projection so it can never exceed a real full season, which
// a weighted average or an outlier historical game count could otherwise
// do. An explicit per-player admin override (PlayerDeployment.gamesProjected,
// Admin -> Deployment) is trusted as-is and NOT clamped — this only guards
// the fallback every unconfigured player uses. Update this if a future
// season's schedule length changes again.
const SEASON_GAME_COUNT = 84;

/** Age as of Oct 1 of `seasonId`'s starting year (e.g. 20262027 -> Oct 1
 *  2026) — a fixed reference date, unlike data.js's ageFromBirthDate()
 *  which uses "today". Needed so every player-season in the age-curve
 *  pool is measured consistently regardless of when this code happens
 *  to run. */
function ageAsOfSeasonStart(birthDate, seasonId) {
  if (!birthDate) return null;
  const b = new Date(birthDate + 'T00:00:00Z');
  if (Number.isNaN(b.getTime())) return null;
  const startYear = Math.floor(seasonId / 10000);
  let age = startYear - b.getUTCFullYear();
  const REF_MONTH = 9; // October, 0-indexed
  const REF_DAY = 1;
  const beforeRef = b.getUTCMonth() > REF_MONTH || (b.getUTCMonth() === REF_MONTH && b.getUTCDate() > REF_DAY);
  if (beforeRef) age -= 1;
  return age;
}

/** The 4 season ids immediately before `projectedSeasonId`, newest
 *  first — same -10001-per-season convention as app.js's seasonOffsets(). */
function historicalSeasonIds(projectedSeasonId) {
  const ids = [];
  for (let i = 1; i <= PROJECTION_SEASONS_BACK; i++) ids.push(projectedSeasonId - 10001 * i);
  return ids;
}

/** A catalog column this engine projects — every counting stat EXCEPT
 *  gamesPlayed itself (which is computed separately, not rate*GP) and
 *  anything with a `fmt` (already a rate — shootingPct, faceoffPct,
 *  gaa, savePct — projected as a rate directly, no deployment scaling,
 *  same convention app.js's toPerGame() already uses). */
function isCountingColumn(col) {
  return !col.fmt && col.id !== 'gamesPlayed';
}

// ---------------------------------------------------------------------
// Least-squares quadratic fit: y = a*x^2 + b*x + c
// ---------------------------------------------------------------------

function solve3x3(A, b) {
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-9) return null; // singular — not enough distinct x values
  const withCol = (col) => A.map((row, i) => row.map((v, j) => (j === col ? b[i] : v)));
  return [det(withCol(0)) / D, det(withCol(1)) / D, det(withCol(2)) / D];
}

/** Fits y = a*x^2 + b*x + c to `points` ([x, y] pairs) via the normal
 *  equations. Returns a `predict(x)` function, or null if there's too
 *  little data to trust a fit (fewer than MIN_POINTS, or a degenerate
 *  x-range) — callers treat null as "no age adjustment for this
 *  combination," i.e. multiplier stays 1 rather than extrapolating
 *  wildly from a handful of points. */
function fitQuadratic(points) {
  const MIN_POINTS = 20;
  if (points.length < MIN_POINTS) return null;

  let Sx0 = 0, Sx1 = 0, Sx2 = 0, Sx3 = 0, Sx4 = 0, Sy0 = 0, Sxy1 = 0, Sxy2 = 0;
  for (const [x, y] of points) {
    const x2 = x * x;
    Sx0 += 1; Sx1 += x; Sx2 += x2; Sx3 += x2 * x; Sx4 += x2 * x2;
    Sy0 += y; Sxy1 += x * y; Sxy2 += x2 * y;
  }
  const A = [[Sx4, Sx3, Sx2], [Sx3, Sx2, Sx1], [Sx2, Sx1, Sx0]];
  const coeffs = solve3x3(A, [Sxy2, Sxy1, Sy0]);
  if (!coeffs) return null;
  const [a, b, c] = coeffs;
  return (x) => a * x * x + b * x + c;
}

/** Builds { [positionGroup]: { [statId]: predict(age) | null } } for
 *  every skater column, plus a single 'G' group for goalie columns —
 *  fit from every qualifying player-season across the 4 pooled
 *  historical seasons (see buildProjectedSeason()). `seasonsPooled` is
 *  [{ seasonId, skaters, goalies }, ...] (already MIN_GP_FRACTION-
 *  filtered), `bioMap` is playerId -> birthDate. */
function fitAgeCurves(seasonsPooled, bioMap) {
  const curves = { C: {}, W: {}, D: {}, G: {} };
  const pointsByGroupStat = {};

  function addPoint(group, statId, age, value) {
    const key = `${group}::${statId}`;
    (pointsByGroupStat[key] ||= []).push([age, value]);
  }

  for (const { seasonId, skaters, goalies } of seasonsPooled) {
    for (const p of skaters) {
      const birthDate = bioMap.get(p.playerId);
      const age = ageAsOfSeasonStart(birthDate, seasonId);
      if (age == null || !p.gamesPlayed) continue;
      const group = positionGroup(p.pos);
      for (const col of SKATER_COLUMNS) {
        if (!isCountingColumn(col)) continue;
        addPoint(group, col.id, age, p[col.id] / p.gamesPlayed);
      }
    }
    for (const p of goalies) {
      const birthDate = bioMap.get(p.playerId);
      const age = ageAsOfSeasonStart(birthDate, seasonId);
      if (age == null || !p.gamesPlayed) continue;
      for (const col of GOALIE_COLUMNS) {
        if (!isCountingColumn(col)) continue;
        addPoint('G', col.id, age, p[col.id] / p.gamesPlayed);
      }
    }
  }

  for (const [key, points] of Object.entries(pointsByGroupStat)) {
    const [group, statId] = key.split('::');
    curves[group][statId] = fitQuadratic(points);
  }
  return curves;
}

// ---------------------------------------------------------------------
// Per-player projection
// ---------------------------------------------------------------------

/** `history` is this player's row (or null) in each of the 4 historical
 *  seasons, newest first, each tagged with that season's own
 *  eligibility bar. Returns the qualifying subset with renormalized
 *  weights (summing to 1 over just the seasons they qualified in). */
function qualifyingHistory(history, seasonWeights) {
  const qualifying = history
    .map((h, i) => ({ ...h, weight: seasonWeights[i] }))
    .filter((h) => h.row && h.qualifies);
  const weightSum = qualifying.reduce((s, h) => s + h.weight, 0);
  if (weightSum <= 0) return [];
  return qualifying.map((h) => ({ ...h, weight: h.weight / weightSum }));
}

function clip(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Core per-player, per-stat math described in the file header. `mode`
 *  is 'skaters' | 'goalies'. `deployRow` is this player's
 *  PlayerDeployment row from /api/fantasy/public-config, or
 *  undefined if the admin never entered one. `groupToiAvg` is the
 *  position group's average TOI/game (rookie deployment fallback).
 *
 *  Pass `ytdRow` (this player's REAL row from the season actually being
 *  played, i.e. state.seasonId itself — see buildRestOfSeasonProjection())
 *  plus `shrinkageGames` to switch into REST-OF-SEASON mode instead of
 *  the default preseason mode: every rate gets BLENDED with the
 *  player's real year-to-date rate before being scaled, using
 *  regression-to-a-prior shrinkage —
 *    blended = g/(g+K)*ytdRate + K/(g+K)*modeledRate
 *  (g = real games played so far, K = shrinkageGames) — small g trusts
 *  the model more, large g trusts real results more, which is what
 *  makes this "update as games played changes" automatically: it's
 *  just a live recompute against however many real games exist right
 *  now, no separate update mechanism needed. Counting-stat totals
 *  become actualYtdTotal + blendedRate * remainingGames instead of
 *  blendedRate * a full assumed season — the anchor-to-real-results
 *  step preseason mode has no equivalent of. */
function computeProjection({
  playerId, currentInfo, history, mode, ageCurves, settings,
  projectedAge, deployRow, groupToiAvg, defaultGamesPlayed,
  ytdRow, shrinkageGames,
}) {
  const catalog = mode === 'goalies' ? GOALIE_COLUMNS : SKATER_COLUMNS;
  const group = mode === 'goalies' ? 'G' : positionGroup(currentInfo.pos);
  const qualified = qualifyingHistory(history, settings.seasonWeights);
  const isRookie = qualified.length === 0;

  const g = ytdRow?.gamesPlayed || 0;
  const isRestOfSeason = Boolean(ytdRow) && g > 0;
  const K = shrinkageGames || 20;
  const credibility = g / (g + K); // weight on the real YTD side of the blend

  // Historical TOI/game (skaters only) — weighted avg over the same
  // qualifying seasons, used as the deployment comparison baseline.
  let historicalToi = null, historicalPpToi = null, historicalGP = null;
  if (mode === 'skaters') {
    if (!isRookie) {
      historicalToi = qualified.reduce((s, h) => s + h.weight * (h.toi?.toiPerGame || 0), 0);
      historicalPpToi = qualified.reduce((s, h) => s + h.weight * (h.toi?.ppToiPerGame || 0), 0);
    } else {
      historicalToi = groupToiAvg.toi;
      historicalPpToi = groupToiAvg.ppToi;
    }
  }
  historicalGP = isRookie
    ? defaultGamesPlayed
    : qualified.reduce((s, h) => s + h.weight * h.row.gamesPlayed, 0);

  const out = { ...currentInfo, playerId };

  for (const col of catalog) {
    if (col.id === 'gamesPlayed') continue; // set at the end, below

    if (!isCountingColumn(col)) {
      // Already a rate stat: weighted history only (renormalized over
      // qualifying seasons), age-adjusted, NO deployment scaling and
      // NO multiplication by games played — it already is per-instance.
      let rate;
      if (isRookie) {
        const curve = ageCurves[group][col.id];
        rate = curve ? curve(projectedAge) : 0;
      } else {
        rate = qualified.reduce((s, h) => s + h.weight * (h.row[col.id] || 0), 0);
        rate *= ageMultiplier(ageCurves, group, col.id, settings, projectedAge, mostRecentAge(qualified));
      }
      if (isRestOfSeason) {
        const ytdRate = ytdRow[col.id] || 0; // already per-instance, no /g needed
        rate = credibility * ytdRate + (1 - credibility) * rate;
      }
      out[col.id] = rate;
      continue;
    }

    // Counting stat.
    let ratePerGame;
    if (isRookie) {
      const curve = ageCurves[group][col.id];
      ratePerGame = curve ? Math.max(0, curve(projectedAge)) : 0;
    } else {
      const weightedRate = qualified.reduce((s, h) => s + h.weight * ((h.row[col.id] || 0) / h.row.gamesPlayed), 0);
      const ageMult = ageMultiplier(ageCurves, group, col.id, settings, projectedAge, mostRecentAge(qualified));
      ratePerGame = Math.max(0, weightedRate * ageMult);
    }

    const deployMult = deploymentMultiplier(col, mode, deployRow, historicalToi, historicalPpToi);
    let modeledRate = ratePerGame * deployMult;

    if (isRestOfSeason) {
      const ytdRate = (ytdRow[col.id] || 0) / g;
      modeledRate = credibility * ytdRate + (1 - credibility) * modeledRate;
    }
    out[col.id] = modeledRate; // still a per-game rate here — scaled to a total below, once gamesPlayed is finalized
  }

  const fullSeasonGames = deployRow?.gamesProjected ?? Math.min(historicalGP, SEASON_GAME_COUNT);

  if (isRestOfSeason) {
    const remainingGames = Math.max(0, Math.round(fullSeasonGames) - g);
    for (const col of catalog) {
      if (!isCountingColumn(col)) continue;
      const ytdTotal = ytdRow[col.id] || 0;
      out[col.id] = Math.round(ytdTotal + out[col.id] * remainingGames);
    }
    out.gamesPlayed = g + remainingGames; // real games so far + projected rest = full-season total
  } else {
    out.gamesPlayed = Math.max(0, Math.round(fullSeasonGames));
    for (const col of catalog) {
      if (isCountingColumn(col)) out[col.id] = Math.round(out[col.id] * out.gamesPlayed);
    }
  }

  return out;
}

function mostRecentAge(qualified) {
  return qualified.length ? qualified[0].age : null; // qualified[] is newest-first, same order as history
}

function ageMultiplier(ageCurves, group, statId, settings, projectedAge, mostRecentQualifyingAge) {
  if (!settings.ageCurveEnabled || mostRecentQualifyingAge == null) return 1;
  const curve = ageCurves[group][statId];
  if (!curve) return 1;
  const atProjected = curve(projectedAge);
  const atRecent = curve(mostRecentQualifyingAge);
  if (!(atRecent > 0)) return 1;
  return clip(atProjected / atRecent, settings.multiplierClipMin, settings.multiplierClipMax);
}

function deploymentMultiplier(col, mode, deployRow, historicalToi, historicalPpToi) {
  if (!deployRow) return 1;
  if (mode === 'goalies') return 1; // goalies scale entirely via gamesProjected, not a rate multiplier
  const isPp = col.id === 'ppGoals' || col.id === 'ppPoints';
  if (isPp && deployRow.ppToiPerGame && historicalPpToi > 0) {
    return clip(deployRow.ppToiPerGame / historicalPpToi, 0.3, 3);
  }
  if (!isPp && deployRow.toiPerGame && historicalToi > 0) {
    return clip(deployRow.toiPerGame / historicalToi, 0.3, 3);
  }
  return 1;
}

// ---------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------

/** Shared setup for both orchestrators below (preseason and rest-of-
 *  season): the eligibility-filtered pool per historical season (age-
 *  curve fit input + each player's own qualifying-seasons check),
 *  position-group average TOI (rookie deployment fallback), the
 *  "assume a healthy full season" games-played default, and a
 *  per-player history lookup. `historicalData` is [{ seasonId, skaters,
 *  goalies, toiByPlayer }, ...] for the 4 seasons (newest first) —
 *  toiByPlayer from loadSkaterTimeOnIce(). `bioPool` supplies age
 *  (birthDate) for the age-curve fit's player-seasons. */
function buildProjectionContext(historicalData, bioPool) {
  const bioMap = new Map(bioPool.map((p) => [p.playerId, p.birthDate]));

  const eligible = historicalData.map(({ seasonId, skaters, goalies, toiByPlayer }) => {
    const skaterMinGP = Math.ceil(seasonGameCount(skaters) * MIN_GP_FRACTION);
    const goalieMinGP = Math.ceil(seasonGameCount(goalies) * MIN_GP_FRACTION);
    const eligSkaters = skaters.filter((p) => p.gamesPlayed >= skaterMinGP);
    const eligGoalies = goalies.filter((p) => p.gamesPlayed >= goalieMinGP);
    return {
      seasonId,
      skaters: eligSkaters,
      goalies: eligGoalies,
      // O(1) per-player lookup for historyFor() below, instead of an
      // O(n) .find() per player per season (this runs once per player
      // in the whole pool, ~700+ times, so the difference matters).
      skatersById: new Map(eligSkaters.map((p) => [p.playerId, p])),
      goaliesById: new Map(eligGoalies.map((p) => [p.playerId, p])),
      toiByPlayer,
    };
  });

  const ageCurves = fitAgeCurves(eligible, bioMap);

  const groupToiTotals = { C: [0, 0, 0], W: [0, 0, 0], D: [0, 0, 0] }; // [toiSum, ppToiSum, n]
  for (const { skaters, toiByPlayer } of eligible) {
    for (const p of skaters) {
      const toi = toiByPlayer.get(p.playerId);
      if (!toi) continue;
      const gTotals = groupToiTotals[positionGroup(p.pos)];
      gTotals[0] += toi.toiPerGame; gTotals[1] += toi.ppToiPerGame; gTotals[2] += 1;
    }
  }
  const groupToiAvg = {};
  for (const [group, [toiSum, ppToiSum, n]] of Object.entries(groupToiTotals)) {
    groupToiAvg[group] = { toi: n ? toiSum / n : 0, ppToi: n ? ppToiSum / n : 0 };
  }

  const defaultGamesPlayed = Math.max(...eligible.map((e) => seasonGameCount(e.skaters)), 0);

  function historyFor(playerId, isGoalie) {
    // Newest-first, matching eligible[]'s order (already newest-first).
    return eligible.map((e) => {
      const row = (isGoalie ? e.goaliesById : e.skatersById).get(playerId) || null;
      return {
        row,
        qualifies: Boolean(row),
        toi: e.toiByPlayer.get(playerId),
        age: ageAsOfSeasonStart(bioMap.get(playerId), e.seasonId),
      };
    });
  }

  return { bioMap, ageCurves, groupToiAvg, defaultGamesPlayed, historyFor };
}

/** Builds the full preseason-projected season (the Next-Season Preview
 *  option). `bioPool` is loadPlayerBioPool()'s current-roster array —
 *  every current-roster player gets a projected row, with the rookie
 *  fallback for anyone with no qualifying history. `deployment`/
 *  `settings` come from GET /api/fantasy/public-config. */
function buildProjectedSeason({ projectedSeasonId, historicalData, bioPool, teamMeta, deployment, settings }) {
  const { bioMap, ageCurves, groupToiAvg, defaultGamesPlayed, historyFor } = buildProjectionContext(historicalData, bioPool);
  const deployMap = new Map(deployment.map((d) => [d.nhlPlayerId, d]));

  const skaters = [];
  const goalies = [];

  for (const bio of bioPool) {
    if (!bio.birthDate) continue; // can't age-project without a birth date, skip
    const projectedAge = ageAsOfSeasonStart(bio.birthDate, projectedSeasonId);
    if (projectedAge == null) continue;
    const isGoalie = bio.pos === 'G';
    const mode = isGoalie ? 'goalies' : 'skaters';
    const history = historyFor(bio.playerId, isGoalie);

    const currentInfo = {
      name: bio.name, pos: bio.pos, team: bio.team, teamsRaw: bio.team,
    };

    const projected = computeProjection({
      playerId: bio.playerId,
      currentInfo,
      history,
      mode,
      ageCurves,
      settings,
      projectedAge,
      deployRow: deployMap.get(bio.playerId),
      groupToiAvg: isGoalie ? null : groupToiAvg[positionGroup(bio.pos)],
      defaultGamesPlayed,
    });

    if (isGoalie) goalies.push(projected); else skaters.push(projected);
  }

  return { seasonId: projectedSeasonId, teamMeta, skaters, goalies };
}

/** Builds the Rest-of-Season projection: real year-to-date stats for
 *  the season actually being played (`currentSeasonId`/`currentRaw`)
 *  blended with a modeled rate for the remaining games — see
 *  computeProjection()'s doc comment for the blend math. Iterates the
 *  CURRENT season's real raw pool (not bioPool) — only players who've
 *  actually played this season have a YTD row to anchor to; anyone who
 *  hasn't played yet has nothing meaningful to blend and just isn't
 *  part of this view (they'd show up fine on Year to Date once they do
 *  play). `historicalData` is still the 4 seasons BEFORE the current
 *  one (same age-curve/weighted-history inputs preseason mode uses),
 *  `bioPool` supplies age. `settings.restOfSeasonShrinkageGames` is the
 *  shrinkage constant K. */
function buildRestOfSeasonProjection({ currentSeasonId, currentRaw, historicalData, bioPool, teamMeta, deployment, settings }) {
  const { bioMap, ageCurves, groupToiAvg, defaultGamesPlayed, historyFor } = buildProjectionContext(historicalData, bioPool);
  const deployMap = new Map(deployment.map((d) => [d.nhlPlayerId, d]));
  const shrinkageGames = settings.restOfSeasonShrinkageGames || 20;

  function project(ytdRow, isGoalie) {
    const bio = { name: ytdRow.name, pos: ytdRow.pos, team: ytdRow.team, teamsRaw: ytdRow.teamsRaw };
    const birthDate = bioMap.get(ytdRow.playerId);
    if (!birthDate) return null; // can't age-project without a birth date, skip
    const currentAge = ageAsOfSeasonStart(birthDate, currentSeasonId);
    if (currentAge == null) return null;
    const mode = isGoalie ? 'goalies' : 'skaters';

    return computeProjection({
      playerId: ytdRow.playerId,
      currentInfo: bio,
      history: historyFor(ytdRow.playerId, isGoalie),
      mode,
      ageCurves,
      settings,
      projectedAge: currentAge,
      deployRow: deployMap.get(ytdRow.playerId),
      groupToiAvg: isGoalie ? null : groupToiAvg[positionGroup(ytdRow.pos)],
      defaultGamesPlayed,
      ytdRow,
      shrinkageGames,
    });
  }

  const skaters = currentRaw.skaters.map((p) => project(p, false)).filter(Boolean);
  const goalies = currentRaw.goalies.map((p) => project(p, true)).filter(Boolean);

  return { seasonId: currentSeasonId, teamMeta, skaters, goalies };
}
