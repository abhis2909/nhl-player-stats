'use strict';

/* ======================================================================
   Yahoo Fantasy Sports API client — OAuth 2.0 (three-legged) token
   handling plus the actual data pulls, all built around ONE
   commissioner-level connection (see prisma/schema.prisma's YahooToken
   singleton, and its comment for why: Yahoo's access rules are based
   on league membership, so one token can read the whole league — no
   per-user OAuth needed). Used by api/fantasy/admin-settings.js's
   yahoo-* dispatch types (the connect/callback/sync endpoints) and
   api/fantasy/public-config.js's `?type=yahoo` read.

   Needs three env vars: YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET (from
   the Yahoo Developer app — see Admin -> Yahoo League for where these
   plug in) and YAHOO_REDIRECT_URI, the exact callback URL registered
   in that app's settings (e.g. "https://<domain>/api/yahoo/callback").
   Deliberately a fixed env var rather than derived from the request's
   Host header — Yahoo requires an exact match, and Vercel serves the
   same deployment from multiple hostnames (preview URLs, custom
   domain), so a derived value would only work from whichever one
   happens to match what's registered.

   A NOTE ON THE PARSING BELOW: Yahoo's Fantasy API is XML-first — its
   "?format=json" output is a fairly direct XML->JSON transliteration,
   not a clean REST shape. Collections (a league's teams, a team's
   roster, etc.) come back as an object like
   { "0": {...}, "1": {...}, "count": 2 } instead of a real array, and
   an individual resource (one team, one player) comes back as an array
   of single-key fragments that need merging into one object. yArr()
   and yMerge() below are the two generic building blocks every
   fetch*() function uses to navigate that shape — this was written
   against Yahoo's publicly documented/community-reverse-engineered
   response format (this sandbox has no network path to Yahoo's API to
   test against live), so the first real sync is the actual proof; if
   a field comes back in an unexpected spot, rawData on every cache
   table always has the untouched original response to re-derive from
   without needing another Yahoo round trip. */

const AUTHORIZE_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
const FANTASY_BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';

function requireClientCreds() {
  const clientId = process.env.YAHOO_CLIENT_ID;
  const clientSecret = process.env.YAHOO_CLIENT_SECRET;
  const redirectUri = process.env.YAHOO_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    const err = new Error('YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET / YAHOO_REDIRECT_URI are not all set.');
    err.code = 'no_yahoo_credentials';
    throw err;
  }
  return { clientId, clientSecret, redirectUri };
}

function basicAuthHeader(clientId, clientSecret) {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

/** Where "Connect to Yahoo" sends the browser. `state` is a random
 *  value the caller also stashes in a short-lived cookie, checked
 *  again in handleCallback() below — standard OAuth CSRF protection. */
function buildAuthorizeUrl(state) {
  const { clientId, redirectUri } = requireClientCreds();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    language: 'en-us',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchanges the `code` Yahoo's callback hands back for an access +
 *  refresh token pair, and persists them (YahooToken singleton). Called
 *  once, right after the OAuth redirect. */
async function completeAuthorization(prisma, code) {
  const { clientId, clientSecret, redirectUri } = requireClientCreds();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Yahoo token exchange failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  const expiresAt = new Date(Date.now() + (json.expires_in || 3600) * 1000);
  await prisma.yahooToken.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt },
    update: { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt },
  });
}

/** Returns a currently-valid access token, refreshing first if the
 *  stored one is stale (or about to be — 60s buffer). Every fetch*()
 *  below goes through this rather than reading YahooToken directly, so
 *  callers never have to think about expiry themselves. Throws a clear
 *  'not_connected' error if nobody's ever connected yet. */
async function getValidAccessToken(prisma) {
  const row = await prisma.yahooToken.findUnique({ where: { id: 'singleton' } });
  if (!row) {
    const err = new Error('No Yahoo account connected yet — see Admin -> Yahoo League.');
    err.code = 'not_connected';
    throw err;
  }
  if (row.expiresAt.getTime() > Date.now() + 60_000) {
    return row.accessToken;
  }

  const { clientId, clientSecret } = requireClientCreds();
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refreshToken });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Yahoo token refresh failed (${res.status}): ${detail.slice(0, 300)}`);
    err.code = 'refresh_failed';
    throw err;
  }
  const json = await res.json();
  const expiresAt = new Date(Date.now() + (json.expires_in || 3600) * 1000);
  await prisma.yahooToken.update({
    where: { id: 'singleton' },
    // Yahoo doesn't always send a new refresh_token on refresh — keep the old one if so.
    data: { accessToken: json.access_token, refreshToken: json.refresh_token || row.refreshToken, expiresAt },
  });
  return json.access_token;
}

/** GETs one Yahoo Fantasy API path (e.g. "/users;use_login=1/games")
 *  and returns the parsed JSON, appending format=json and the Bearer
 *  token automatically. */
async function yahooApiFetch(prisma, path) {
  const token = await getValidAccessToken(prisma);
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${FANTASY_BASE}${path}${sep}format=json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Yahoo API request failed (${res.status}) for ${path}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

// ---------- Generic Yahoo JSON-shape helpers (see file header) ----------

/** Yahoo represents a "collection" as { "0": x, "1": y, "count": 2 }
 *  instead of a real array — this returns [x, y]. Safe to call on
 *  anything; non-collection input just comes back as []. */
function yArr(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const out = [];
  for (const key of Object.keys(obj)) {
    if (key === 'count') continue;
    out.push(obj[key]);
  }
  return out;
}

/** Yahoo represents "one resource" (a team, a player, ...) as an array
 *  of single-key fragments — [{team_key: ".."}, {name: ".."}, ...] —
 *  this merges them into one flat object: {team_key: "..", name: ".."}.
 *  Nested arrays/objects are left as-is (callers use yArr() on those
 *  in turn where relevant). */
function yMerge(fragments) {
  const out = {};
  for (const frag of Array.isArray(fragments) ? fragments : [fragments]) {
    if (frag && typeof frag === 'object' && !Array.isArray(frag)) {
      Object.assign(out, frag);
    }
  }
  return out;
}

// ---------- League discovery (Admin -> Yahoo League's league picker) ----------

/** Every NHL fantasy league the connected Yahoo account belongs to,
 *  across seasons — {leagueKey, gameKey, name, season}[]. Lets the
 *  admin pick the right one instead of having to know Yahoo's league
 *  key format themselves. */
async function discoverLeagues(prisma) {
  const json = await yahooApiFetch(prisma, '/users;use_login=1/games;game_codes=nhl/leagues');
  const users = yArr(json?.fantasy_content?.users);
  const leagues = [];
  for (const u of users) {
    const games = yArr(u?.user?.[1]?.games);
    for (const g of games) {
      const gameFragments = g?.game;
      if (!Array.isArray(gameFragments)) continue;
      const gameMeta = yMerge(gameFragments[0]);
      const leagueList = yArr(gameFragments[1]?.leagues);
      for (const l of leagueList) {
        const leagueMeta = yMerge(l?.league);
        if (!leagueMeta.league_key) continue;
        leagues.push({
          leagueKey: leagueMeta.league_key,
          gameKey: gameMeta.game_key,
          name: leagueMeta.name,
          season: gameMeta.season,
        });
      }
    }
  }
  return leagues;
}

// ---------- League data sync (Admin -> Yahoo League's "Sync now", + the daily cron) ----------

/** Pulls standings, current-week matchups, every team's roster,
 *  recent transactions, and draft results for `leagueKey`, and upserts
 *  each into its cache table. Returns a small summary for the caller
 *  to show/log. Called both from the admin's manual "Sync now" and the
 *  daily cron (api/fantasy/admin-settings.js's yahoo-sync type). */
async function syncLeague(prisma, leagueKey) {
  const summary = { standings: 0, matchups: 0, rosters: 0, transactions: 0, draft: 0 };

  // Standings
  const standingsJson = await yahooApiFetch(prisma, `/league/${leagueKey}/standings`);
  await prisma.yahooStandingsCache.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', rawData: standingsJson },
    update: { rawData: standingsJson, fetchedAt: new Date() },
  });
  summary.standings = 1;

  // Teams (needed for rosters, and to know team names/keys up front)
  const teamsJson = await yahooApiFetch(prisma, `/league/${leagueKey}/teams`);
  const teamFragments = yArr(teamsJson?.fantasy_content?.league?.[1]?.teams);
  const teams = teamFragments
    .map((t) => yMerge(t?.team?.[0]))
    .filter((t) => t.team_key);

  // Current-week matchups (scoreboard defaults to the current week if none given)
  const scoreboardJson = await yahooApiFetch(prisma, `/league/${leagueKey}/scoreboard`);
  const scoreboard = scoreboardJson?.fantasy_content?.league?.[1]?.scoreboard;
  const weekKey = String(scoreboard?.[0]?.week ?? scoreboard?.week ?? '');
  const matchups = yArr(scoreboard?.[1]?.matchups ?? scoreboard?.matchups);
  for (const m of matchups) {
    const matchup = m?.matchup;
    if (!matchup) continue;
    // Matchups don't carry their own single natural id from Yahoo — build
    // one from the two teams' keys (order-independent) + the week, stable
    // across re-syncs of the same matchup.
    const matchupTeams = yArr(matchup?.[0]?.teams ?? matchup?.teams)
      .map((t) => yMerge(t?.team?.[0])?.team_key)
      .filter(Boolean)
      .sort();
    if (matchupTeams.length !== 2) continue;
    const matchupKey = `${leagueKey}.w${weekKey}.${matchupTeams.join('__')}`;
    await prisma.yahooMatchupCache.upsert({
      where: { matchupKey },
      create: { matchupKey, weekKey, rawData: m },
      update: { weekKey, rawData: m, fetchedAt: new Date() },
    });
    summary.matchups += 1;
  }

  // Rosters — one Yahoo call per team
  for (const team of teams) {
    const rosterJson = await yahooApiFetch(prisma, `/team/${team.team_key}/roster`);
    await prisma.yahooRosterCache.upsert({
      where: { teamKey: team.team_key },
      create: { teamKey: team.team_key, teamName: team.name || team.team_key, rawData: rosterJson },
      update: { teamName: team.name || team.team_key, rawData: rosterJson, fetchedAt: new Date() },
    });
    summary.rosters += 1;
  }

  // Transactions (adds/drops/trades)
  const transactionsJson = await yahooApiFetch(prisma, `/league/${leagueKey}/transactions`);
  const transactions = yArr(transactionsJson?.fantasy_content?.league?.[1]?.transactions);
  for (const t of transactions) {
    const txMeta = yMerge(t?.transaction?.[0]);
    if (!txMeta.transaction_key) continue;
    await prisma.yahooTransactionCache.upsert({
      where: { transactionKey: txMeta.transaction_key },
      create: { transactionKey: txMeta.transaction_key, rawData: t },
      update: { rawData: t, fetchedAt: new Date() },
    });
    summary.transactions += 1;
  }

  // Draft results — full list, refreshed wholesale (a completed draft never changes)
  const draftJson = await yahooApiFetch(prisma, `/league/${leagueKey}/draftresults`);
  await prisma.yahooDraftCache.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', rawData: draftJson },
    update: { rawData: draftJson, fetchedAt: new Date() },
  });
  summary.draft = 1;

  return summary;
}

module.exports = {
  buildAuthorizeUrl,
  completeAuthorization,
  getValidAccessToken,
  yahooApiFetch,
  discoverLeagues,
  syncLeague,
  yArr,
  yMerge,
};
