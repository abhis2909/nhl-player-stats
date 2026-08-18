'use strict';

/* ======================================================================
   Server-side mirror of data.js's loadSeasonData()/buildTeamMeta()/
   buildSkaters()/buildGoalies() — deliberately duplicated, not shared,
   same precedent as api/_lib/guessWhoPool.js mirroring guesswho.js:
   data.js is written for <script> tag consumption (global consts/
   functions, relative /api/web + /api/stats fetch paths that only
   resolve in a browser), not as a CommonJS module, so a server-side
   caller (the snapshot cron/admin-retrieve handler in
   api/fantasy/snapshots.js) needs its own copy hitting the NHL hosts
   directly instead of self-calling this deployment's own proxy routes.

   DRIFT RISK: if data.js's field mapping ever changes (a new stat,
   a renamed NHL API field), this needs the same change made here too —
   there is no automatic sync between them. Keep the two side by side
   when editing either.
   ====================================================================== */

const API_WEB = 'https://api-web.nhle.com';
const API_STATS = 'https://api.nhle.com/stats/rest';

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'nhl-stats-site/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function lastTeam(teamAbbrevs) {
  if (!teamAbbrevs) return '—';
  const parts = teamAbbrevs.split(',').map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || '—';
}

function fallbackSeasonId() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const startYear = now.getUTCMonth() < 6 ? y - 1 : y;
  return startYear * 10000 + (startYear + 1);
}

function buildTeamMeta(standings) {
  const teamMeta = [];
  for (const row of standings.standings || []) {
    const abbrev = row.teamAbbrev?.default;
    if (!abbrev) continue;
    teamMeta.push([abbrev, {
      name: row.teamName?.default || abbrev,
      common: row.teamCommonName?.default || abbrev,
      logo: row.teamLogo,
      conference: row.conferenceName,
      division: row.divisionName,
      record: `${row.wins}-${row.losses}-${row.otLosses}`,
      points: row.points,
      leagueSequence: row.leagueSequence,
      gamesPlayed: row.gamesPlayed ?? 0,
      goalFor: row.goalFor ?? 0,
      goalAgainst: row.goalAgainst ?? 0,
      pointPctg: row.pointPctg,
    }]);
  }
  return teamMeta; // array of [abbrev, meta] pairs — same shape snapshots.js's serializeSeasonData() already stores teamMeta as
}

function buildSkaters(summaryRows, realtimeRows) {
  const map = new Map();
  for (const r of summaryRows) {
    map.set(r.playerId, {
      playerId: r.playerId,
      name: r.skaterFullName,
      pos: r.positionCode,
      team: lastTeam(r.teamAbbrevs),
      teamsRaw: r.teamAbbrevs || '',
      goals: r.goals ?? 0,
      assists: r.assists ?? 0,
      points: r.points ?? 0,
      plusMinus: r.plusMinus ?? 0,
      ppGoals: r.ppGoals ?? 0,
      ppPoints: r.ppPoints ?? 0,
      shGoals: r.shGoals ?? 0,
      shPoints: r.shPoints ?? 0,
      gameWinningGoals: r.gameWinningGoals ?? 0,
      otGoals: r.otGoals ?? 0,
      pim: r.penaltyMinutes ?? 0,
      sog: r.shots ?? 0,
      shootingPct: r.shootingPct ?? 0,
      gamesPlayed: r.gamesPlayed ?? 0,
      faceoffPct: r.faceoffWinPct ?? 0,
      hits: 0,
      blocks: 0,
      giveaways: 0,
      takeaways: 0,
    });
  }
  for (const r of realtimeRows) {
    const s = map.get(r.playerId);
    if (s) {
      s.hits = r.hits ?? 0;
      s.blocks = r.blockedShots ?? 0;
      s.giveaways = r.giveaways ?? 0;
      s.takeaways = r.takeaways ?? 0;
    }
  }
  return Array.from(map.values());
}

function buildGoalies(rows) {
  return rows.map((r) => ({
    playerId: r.playerId,
    name: r.goalieFullName,
    pos: 'G',
    team: lastTeam(r.teamAbbrevs),
    teamsRaw: r.teamAbbrevs || '',
    wins: r.wins ?? 0,
    losses: r.losses ?? 0,
    otLosses: r.otLosses ?? 0,
    gaa: typeof r.goalsAgainstAverage === 'number' ? r.goalsAgainstAverage : 0,
    savePct: typeof r.savePct === 'number' ? r.savePct : 0,
    saves: r.saves ?? 0,
    shutouts: r.shutouts ?? 0,
    gamesPlayed: r.gamesPlayed ?? 0,
    gamesStarted: r.gamesStarted ?? 0,
    goalsAgainst: r.goalsAgainst ?? 0,
    shotsAgainst: r.shotsAgainst ?? 0,
  }));
}

/** Fetches the CURRENT season's full league-wide stats + team directory,
 *  ready to store as a StatsSnapshot row — { seasonId, teamMeta,
 *  skaters, goalies }, teamMeta already as [abbrev, meta] pairs (the
 *  same shape the `data` JSON column stores, mirroring
 *  snapshots.js's serializeSeasonData()). */
async function fetchCurrentSeasonSnapshot() {
  const standings = await getJSON(`${API_WEB}/v1/standings/now`);
  const teamMeta = buildTeamMeta(standings);
  const seasonId = standings.standings?.[0]?.seasonId || fallbackSeasonId();

  const filter = `seasonId=${seasonId} and gameTypeId=2`;
  const q = `?limit=-1&cayenneExp=${encodeURIComponent(filter)}`;
  const [skaterSummary, skaterRealtime, goalieSummary] = await Promise.all([
    getJSON(`${API_STATS}/en/skater/summary${q}`),
    getJSON(`${API_STATS}/en/skater/realtime${q}`),
    getJSON(`${API_STATS}/en/goalie/summary${q}`),
  ]);

  return {
    seasonId,
    teamMeta,
    skaters: buildSkaters(skaterSummary.data || [], skaterRealtime.data || []),
    goalies: buildGoalies(goalieSummary.data || []),
  };
}

module.exports = { fetchCurrentSeasonSnapshot };
