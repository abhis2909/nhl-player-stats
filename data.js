'use strict';

/* ======================================================================
   Shared data layer: fetches + normalizes NHL stats. Used by both the
   stats page (app.js) and the player-cards page (cards.js), so both
   always agree on what a "skater" or "goalie" object looks like — and so
   next season's rollover (new seasonId, new game counts) only has to be
   handled here, not twice.

   Reference: https://github.com/Zmalski/NHL-API-Reference
   ====================================================================== */

const API_WEB = '/api/web';
const API_STATS = '/api/stats';

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* ignore */ }
    throw new Error(`${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
  }
  return res.json();
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function lastTeam(teamAbbrevs) {
  if (!teamAbbrevs) return '—';
  const parts = teamAbbrevs.split(',').map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || '—';
}

function seasonLabel(seasonId) {
  const s = String(seasonId);
  if (s.length !== 8) return s;
  return `${s.slice(0, 4)}–${s.slice(6, 8)}`;
}

function formatHeight(inches) {
  if (!inches && inches !== 0) return '—';
  const ft = Math.floor(inches / 12);
  const inch = inches % 12;
  return `${ft}'${inch}"`;
}

function ageFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const b = new Date(birthDate + 'T00:00:00Z');
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday = (now.getUTCMonth() < b.getUTCMonth()) ||
    (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/* ---- Shared week/date math — used by schedule.js (the weekly grid) and
   snapshots.js (so "retrieve latest stats" keys/labels snapshots by the
   SAME Monday-Sunday week the Schedule page shows, since the intended
   workflow is retrieving once a week to build a Range Ratings "team of
   the week" that lines up with that week). ---- */

/** Today's date as YYYY-MM-DD, in the browser's local time. */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Monday (ISO date string) of the week containing `dateStr`. NHL's
 *  /v1/schedule/{date} returns whatever 7-day window starts at the date
 *  you give it — not necessarily Monday-aligned (confirmed: its "now"
 *  alias can jump to a Tuesday) — so schedule.js anchors every week-fetch
 *  to a Monday first via this. */
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun .. 6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/** "Sep 28 – Oct 4, 2026" (or just the one date if from === to). Same
 *  format schedule.js uses for its week/range label, reused by
 *  snapshots.js so a snapshot's label visibly matches the Schedule
 *  page's label for that same week. */
function formatDateRange(fromDateStr, toDateStr) {
  const first = new Date(fromDateStr + 'T00:00:00Z');
  const last = new Date(toDateStr + 'T00:00:00Z');
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  const yearOpts = { ...opts, year: 'numeric' };
  if (fromDateStr === toDateStr) return first.toLocaleDateString(undefined, yearOpts);
  return `${first.toLocaleDateString(undefined, opts)} – ${last.toLocaleDateString(undefined, yearOpts)}`;
}

function fallbackSeasonId() {
  const now = new Date();
  const y = now.getUTCFullYear();
  // NHL seasons flip over in the fall; before ~July treat it as the season that started the previous year.
  const startYear = now.getUTCMonth() < 6 ? y - 1 : y;
  return startYear * 10000 + (startYear + 1);
}

function buildTeamMeta(standings) {
  const teamMeta = new Map();
  for (const row of standings.standings || []) {
    const abbrev = row.teamAbbrev?.default;
    if (!abbrev) continue;
    teamMeta.set(abbrev, {
      name: row.teamName?.default || abbrev,
      common: row.teamCommonName?.default || abbrev,
      logo: row.teamLogo,
      conference: row.conferenceName,
      division: row.divisionName,
      record: `${row.wins}-${row.losses}-${row.otLosses}`,
      points: row.points,
      // Raw standing/offense/defense inputs — kept here (not just on the
      // Schedule page) since "how strong is this team" is generically
      // useful team metadata. Used by schedule.js to score matchup
      // difficulty by opponent. gamesPlayed=0 (e.g. a future/expansion
      // season with no standings data at all yet) means the per-game
      // rates below aren't meaningful — callers should treat that as
      // "no rating available" rather than a real 0.
      leagueSequence: row.leagueSequence,
      gamesPlayed: row.gamesPlayed ?? 0,
      goalFor: row.goalFor ?? 0,
      goalAgainst: row.goalAgainst ?? 0,
      pointPctg: row.pointPctg,
    });
  }
  return teamMeta;
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

/** Fetches + normalizes league-wide skater/goalie stats (regular season
 *  only) for an explicit seasonId — current or historical, any season
 *  the stats-rest API has data for. `teamMeta` is passed in rather than
 *  re-fetched since team rosters/logos are a present-day concept, not
 *  something that varies by which season's STATS you're looking at (a
 *  team that's since relocated/rebranded just won't have a current-day
 *  logo to show — same graceful fallback already used everywhere a
 *  team's logo might be missing). */
async function loadSeasonStatsFor(seasonId, teamMeta) {
  const filter = `seasonId=${seasonId} and gameTypeId=2`;
  const q = `?limit=-1&cayenneExp=${encodeURIComponent(filter)}`;
  const [skaterSummary, skaterRealtime, goalieSummary] = await Promise.all([
    getJSON(`${API_STATS}/en/skater/summary${q}`),
    getJSON(`${API_STATS}/en/skater/realtime${q}`),
    getJSON(`${API_STATS}/en/goalie/summary${q}`),
  ]);

  const skaters = buildSkaters(skaterSummary.data || [], skaterRealtime.data || []);
  const goalies = buildGoalies(goalieSummary.data || []);

  return { seasonId, teamMeta, skaters, goalies };
}

/** Fetches skater time-on-ice for a season, keyed by playerId — NOT part
 *  of loadSeasonStatsFor() above (which every plain season-toggle click
 *  uses) since most callers don't need it; it's an extra network call
 *  only the projections engine (projections.js) actually wants, to
 *  compare a player's historical TOI/game against an admin-projected
 *  one. Confirmed fields from the live API: timeOnIcePerGame (seconds),
 *  ppTimeOnIcePerGame (seconds) — converted here to MINUTES/game to
 *  match how deployment input is entered on admin.html. */
async function loadSkaterTimeOnIce(seasonId) {
  const filter = `seasonId=${seasonId} and gameTypeId=2`;
  const q = `?limit=-1&cayenneExp=${encodeURIComponent(filter)}`;
  const { data } = await getJSON(`${API_STATS}/en/skater/timeonice${q}`);
  const map = new Map();
  for (const r of data || []) {
    map.set(r.playerId, {
      toiPerGame: (r.timeOnIcePerGame || 0) / 60,
      ppToiPerGame: (r.ppTimeOnIcePerGame || 0) / 60,
    });
  }
  return map;
}

/** Fetches + normalizes the CURRENT season's league-wide skater/goalie
 *  stats and team directory (standings/now determines both). */
async function loadSeasonData() {
  const standings = await getJSON(`${API_WEB}/v1/standings/now`);
  const teamMeta = buildTeamMeta(standings);
  const seasonId = standings.standings?.[0]?.seasonId || fallbackSeasonId();
  return loadSeasonStatsFor(seasonId, teamMeta);
}

/**
 * The number of team games played so far this season, used as the "100%"
 * reference for games-played eligibility thresholds (e.g. "must have played
 * at least 30% of the season"). Derived from the data itself (the most
 * games anyone has played) rather than hardcoded to 82, so it keeps working
 * for a shortened season and updates itself as next season's games are
 * played, without code changes.
 */
function seasonGameCount(skaters) {
  return skaters.reduce((max, p) => Math.max(max, p.gamesPlayed || 0), 0);
}

/** Fetches every team's current roster — bio info (height, weight, birth
 *  date/country, shoots/catches hand), not season stats — and flattens it
 *  into one array. Used by pages that need player BIOGRAPHY rather than
 *  performance (the Mini-Games hub's daily guessing game). One request per
 *  team (`/v1/roster/{abbrev}/current`), run in parallel; a team whose
 *  roster fails to load is skipped rather than failing the whole pool.
 *  `teamMeta` supplies which abbrevs to fetch — reuse the Map already
 *  built by `buildTeamMeta()` so this always covers exactly the teams
 *  currently in the league. */
async function loadPlayerBioPool(teamMeta) {
  const abbrevs = Array.from(teamMeta.keys());
  const rosters = await Promise.all(
    abbrevs.map((abbrev) => getJSON(`${API_WEB}/v1/roster/${abbrev}/current`).catch(() => null)),
  );

  const out = [];
  rosters.forEach((roster, i) => {
    if (!roster) return;
    const abbrev = abbrevs[i];
    const players = [...(roster.forwards || []), ...(roster.defensemen || []), ...(roster.goalies || [])];
    for (const p of players) {
      const first = p.firstName?.default || '';
      const last = p.lastName?.default || '';
      out.push({
        playerId: p.id,
        name: `${first} ${last}`.trim(),
        team: abbrev,
        pos: p.positionCode,
        shootsCatches: p.shootsCatches || null,
        heightInInches: typeof p.heightInInches === 'number' ? p.heightInInches : null,
        weightInPounds: typeof p.weightInPounds === 'number' ? p.weightInPounds : null,
        birthDate: p.birthDate || null,
        birthCountry: p.birthCountry || null,
        headshot: p.headshot || `https://assets.nhle.com/mugs/nhl/latest/${p.id}.png`,
      });
    }
  });
  return out;
}
