'use strict';

/* ======================================================================
   Server-side mirror of guesswho.js's daily mystery-player pick. Must
   match byte-for-byte — same hash, same sort, same pool filter — or
   logged-in (server-recorded) and anonymous (client-computed) players
   would see DIFFERENT daily answers. See fantasy-hub/README.md's "How
   the daily guesser links to accounts" section. If guesswho.js's
   hashStringToInt/pickMysteryPlayer/pool-filter ever change, this file
   must change with them.

   Fetches directly from api-web.nhle.com rather than through this
   site's own /api/web proxy — CORS is a browser-only restriction (the
   entire reason api/web-proxy.js exists for CLIENT calls), so a
   server-side fetch has no need to go through it.

   REAL BUG FOUND AND FIXED HERE (2026-08-19): firing all 32 team-roster
   requests at once routinely got some of them 429'd by the NHL API —
   confirmed by hand, pool size came back 811 one call and 743 the next,
   a few seconds apart, from the exact same code. Each failed team was
   silently dropped ("skipped, not fatal"), so the pool that actually
   got FROZEN as DailyPlayer for a given date could be missing a chunk
   of the league — and since pickMysteryPlayer() is `hash % pool.length`,
   a different pool size almost always means a DIFFERENT mystery player
   gets picked. Real players solved the actual daily player in their
   browser and were STILL marked "not solved" server-side, because the
   server had frozen a different answer than what every client agreed
   on. Fixed with three layers: retry-with-backoff on 429s, throttled
   concurrency instead of 32-at-once, and a hard floor below which this
   refuses to return a pool at all (better to fail the sync/freeze
   attempt — a later request just tries again — than silently freeze a
   corrupted small pool that's WRONG for the rest of the day). */

const NHL_API = 'https://api-web.nhle.com';

// Empirically ~811-813 in a healthy fetch (all 32 teams succeeded) —
// set well below that so ordinary roster churn (call-ups, trades) never
// trips it, but a chunk of teams silently failing does.
const MIN_HEALTHY_POOL_SIZE = 700;
const ROSTER_FETCH_CONCURRENCY = 6; // teams in flight at once, not all 32
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries on 429 (rate limited) and 5xx (transient upstream trouble)
 *  with linear backoff — NOT on 4xx client errors, those won't fix
 *  themselves on retry. */
async function getJSON(url, attempt = 1) {
  const res = await fetch(url);
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      await sleep(attempt * 600);
      return getJSON(url, attempt + 1);
    }
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

/** Same djb2 hash as guesswho.js's hashStringToInt(). */
function hashStringToInt(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/** Same logic as guesswho.js's pickMysteryPlayer(). `pool` must already
 *  have the same p.birthDate/p.heightInInches filter applied that
 *  guesswho.js's init() applies — see loadServerPlayerBioPool(). */
function pickMysteryPlayer(pool, dateKey) {
  const sorted = [...pool].sort((a, b) => a.playerId - b.playerId);
  const idx = hashStringToInt(dateKey) % sorted.length;
  return sorted[idx];
}

/** Fetches every team's roster with only ROSTER_FETCH_CONCURRENCY in
 *  flight at a time (instead of all 32 simultaneously, which is what
 *  was tripping the NHL API's rate limit) — a simple fixed-size worker
 *  pool, not a library dependency. A team whose roster still fails
 *  after retries is skipped, not fatal — the MIN_HEALTHY_POOL_SIZE
 *  guard in loadServerPlayerBioPool() is what actually protects against
 *  too many of those adding up. */
async function fetchRostersThrottled(abbrevs) {
  const results = new Array(abbrevs.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < abbrevs.length) {
      const i = next++;
      results[i] = await getJSON(`${NHL_API}/v1/roster/${abbrevs[i]}/current`).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: ROSTER_FETCH_CONCURRENCY }, worker));
  return results;
}

/** Server-side copy of data.js's loadPlayerBioPool() + guesswho.js's
 *  init()-time filter, combined. Fetches every team's current roster
 *  (throttled, retried — see fetchRostersThrottled()), flattens to bio
 *  records, and keeps only players with both a birthDate and a
 *  heightInInches — matching guesswho.js's
 *  `state.pool = pool.filter(p => p.birthDate && p.heightInInches)`
 *  exactly. Throws if the resulting pool is suspiciously small
 *  (MIN_HEALTHY_POOL_SIZE) rather than returning a corrupted pool that
 *  would freeze the WRONG daily answer — callers should let that
 *  propagate (guesswho-sync.js does) rather than catch-and-continue. */
async function loadServerPlayerBioPool() {
  const standings = await getJSON(`${NHL_API}/v1/standings/now`);
  const abbrevs = Array.from(
    new Set((standings.standings || []).map((row) => row.teamAbbrev?.default).filter(Boolean)),
  );

  const rosters = await fetchRostersThrottled(abbrevs);

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
        heightInInches: typeof p.heightInInches === 'number' ? p.heightInInches : null,
        birthDate: p.birthDate || null,
        birthCountry: p.birthCountry || null,
        headshot: p.headshot || `https://assets.nhle.com/mugs/nhl/latest/${p.id}.png`,
      });
    }
  });

  const pool = out.filter((p) => p.birthDate && p.heightInInches);
  if (pool.length < MIN_HEALTHY_POOL_SIZE) {
    throw new Error(`Player pool came back too small (${pool.length} players, expected ${MIN_HEALTHY_POOL_SIZE}+) — likely a partial roster-fetch failure, refusing to use it.`);
  }
  return pool;
}

module.exports = { hashStringToInt, pickMysteryPlayer, loadServerPlayerBioPool };
