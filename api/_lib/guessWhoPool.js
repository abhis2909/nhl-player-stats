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
   ====================================================================== */

const NHL_API = 'https://api-web.nhle.com';

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
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

/** Server-side copy of data.js's loadPlayerBioPool() + guesswho.js's
 *  init()-time filter, combined. Fetches every team's current roster
 *  directly (32 parallel requests), flattens to bio records, and keeps
 *  only players with both a birthDate and a heightInInches — matching
 *  guesswho.js's `state.pool = pool.filter(p => p.birthDate && p.heightInInches)`
 *  exactly. A team whose roster fetch fails is skipped, not fatal. */
async function loadServerPlayerBioPool() {
  const standings = await getJSON(`${NHL_API}/v1/standings/now`);
  const abbrevs = Array.from(
    new Set((standings.standings || []).map((row) => row.teamAbbrev?.default).filter(Boolean)),
  );

  const rosters = await Promise.all(
    abbrevs.map((abbrev) => getJSON(`${NHL_API}/v1/roster/${abbrev}/current`).catch(() => null)),
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
        heightInInches: typeof p.heightInInches === 'number' ? p.heightInInches : null,
        birthDate: p.birthDate || null,
        birthCountry: p.birthCountry || null,
        headshot: p.headshot || `https://assets.nhle.com/mugs/nhl/latest/${p.id}.png`,
      });
    }
  });

  return out.filter((p) => p.birthDate && p.heightInInches);
}

module.exports = { hashStringToInt, pickMysteryPlayer, loadServerPlayerBioPool };
