'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionAdmin, readJsonBody } = require('../_lib/fantasyAuth');
const { putRepoFile } = require('../_lib/github');
const yahoo = require('../_lib/yahoo');
const crypto = require('crypto');

const SETTINGS_ID = 'singleton';
const WEIGHT_SUM_TOLERANCE = 0.01; // floats — don't demand an exact 1.0

// jerseys/<name>.png only — blocks path traversal (no ../, no
// subdirectories) since this becomes part of a GitHub API path.
const JERSEY_FILENAME_RE = /^[a-z0-9][a-z0-9-]{0,80}\.png$/i;
const JERSEY_MAX_BYTES = 3 * 1024 * 1024; // headroom under Vercel's ~4.5MB request body cap

const YAHOO_STATE_COOKIE = 'yh_oauth_state';

/* /api/fantasy/admin-settings — admin-only read/write of the site's two
   singular tunable-methodology rows (ProjectionSettings and
   RatingSettings) PLUS, as of the `jersey-image` POST type, publishing
   a processed jersey PNG straight to this repo's jerseys/ folder, PLUS
   the whole Yahoo Fantasy import flow (`yahoo-*` types) — all unrelated
   concerns jammed in here for the same reason session.js/
   admin-session.js merge by HTTP verb and this file already merges by
   resource: the Hobby-plan 12-function cap leaves no room for a
   dedicated endpoint. One admin-only auth check up top covers all of
   it (except the cron-triggered sync — see below). The public read
   side (for the two settings types, and Yahoo's cached league data) is
   public-config.js.

   GET  ?type=projection (default) -> { ok, settings } (ProjectionSettings)
   GET  ?type=rating               -> { ok, settings } (RatingSettings)
   GET  ?type=yahoo-authorize      -> 302 to Yahoo's OAuth consent screen
   GET  ?type=yahoo-callback       -> exchanges Yahoo's ?code, 302 back to admin.html
   GET  ?type=yahoo-status         -> { ok, connected, leagueKey, leagueName, gameKey, lastSyncAt }
   GET  ?type=yahoo-sync           -> cron-only (Authorization: Bearer $CRON_SECRET, see vercel.json); same as the POST below
   POST { type: 'projection', seasonWeights, ageCurveEnabled, multiplierClipMin, multiplierClipMax, restOfSeasonShrinkageGames }
   POST { type: 'rating', positionWeights, goalieWeights, minGamesPlayedSkaters, minGamesPlayedGoalies, ratingFloor, ratingCeil, ratingPremium, tierThresholds }
   POST { type: 'jersey-image', filename, dataUrl } -> commits jerseys/<filename> to GitHub;
         { ok, commitUrl, path } or { ok: false, error, message }
   POST { type: 'yahoo-discover-leagues' } -> { ok, leagues: [{leagueKey, gameKey, name, season}] }
   POST { type: 'yahoo-set-league', leagueKey, gameKey, leagueName } -> { ok }
   POST { type: 'yahoo-sync' } -> pulls standings/matchups/rosters/transactions/draft for the connected league; { ok, summary } */
module.exports = async function handler(req, res) {
  try {
    const prisma = getPrisma();

    // The daily cron hits this with no browser session at all —
    // authenticated by Vercel's own CRON_SECRET bearer token instead
    // (Vercel injects `Authorization: Bearer $CRON_SECRET` on
    // cron-triggered requests when that env var is set; see
    // vercel.json's crons entry and fantasy-hub/README.md). Everything
    // else below this still requires a real admin session.
    if (req.method === 'GET' && req.query?.type === 'yahoo-sync') {
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret && req.headers.authorization === `Bearer ${cronSecret}`) {
        await handleYahooSync(prisma, res);
        return;
      }
    }

    const admin = await getSessionAdmin(req, prisma);
    if (!admin) {
      res.status(401).json({ ok: false, error: 'not_authenticated' });
      return;
    }

    if (req.method === 'GET') {
      const type = req.query?.type;

      if (type === 'yahoo-authorize') {
        handleYahooAuthorize(res);
        return;
      }
      if (type === 'yahoo-callback') {
        await handleYahooCallback(req, res, prisma);
        return;
      }
      if (type === 'yahoo-status') {
        await handleYahooStatus(prisma, res);
        return;
      }

      const settingsType = (type || 'projection') === 'rating' ? 'rating' : 'projection';
      const row = settingsType === 'rating'
        ? await prisma.ratingSettings.findUnique({ where: { id: SETTINGS_ID } })
        : await prisma.projectionSettings.findUnique({ where: { id: SETTINGS_ID } });
      res.status(200).json({ ok: true, settings: row });
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);

      if (body.type === 'jersey-image') {
        await handleJerseyImagePublish(body, res);
        return;
      }
      if (body.type === 'yahoo-discover-leagues') {
        await handleYahooDiscoverLeagues(prisma, res);
        return;
      }
      if (body.type === 'yahoo-set-league') {
        await handleYahooSetLeague(body, prisma, res);
        return;
      }
      if (body.type === 'yahoo-sync') {
        await handleYahooSync(prisma, res);
        return;
      }

      const type = body.type === 'rating' ? 'rating' : 'projection';

      if (type === 'rating') {
        const { positionWeights, goalieWeights, minGamesPlayedSkaters, minGamesPlayedGoalies, ratingFloor, ratingCeil, ratingPremium, tierThresholds } = body;

        const isWeightMap = (obj) => obj && typeof obj === 'object'
          && Object.values(obj).every((v) => typeof v === 'number' && Number.isFinite(v));
        if (!positionWeights || typeof positionWeights !== 'object'
          || !['C', 'W', 'D'].every((k) => isWeightMap(positionWeights[k]))) {
          res.status(400).json({ ok: false, error: 'invalid_input', message: 'positionWeights must have numeric weight maps for C, W, and D.' });
          return;
        }
        if (!isWeightMap(goalieWeights)) {
          res.status(400).json({ ok: false, error: 'invalid_input', message: 'goalieWeights must be a numeric weight map.' });
          return;
        }
        const minGpSkaters = Number(minGamesPlayedSkaters);
        const minGpGoalies = Number(minGamesPlayedGoalies);
        if (!Number.isInteger(minGpSkaters) || minGpSkaters < 0 || !Number.isInteger(minGpGoalies) || minGpGoalies < 0) {
          res.status(400).json({ ok: false, error: 'invalid_input', message: 'minGamesPlayedSkaters/Goalies must be non-negative whole numbers.' });
          return;
        }
        const floor = Number(ratingFloor);
        const ceil = Number(ratingCeil);
        if (!Number.isInteger(floor) || !Number.isInteger(ceil) || floor < 0 || ceil > 100 || floor >= ceil) {
          res.status(400).json({ ok: false, error: 'invalid_input', message: 'ratingFloor/Ceil must be integers with floor < ceil, within 0-100.' });
          return;
        }
        const premium = Number(ratingPremium);
        if (!Number.isFinite(premium) || premium <= 0) {
          res.status(400).json({ ok: false, error: 'invalid_input', message: 'ratingPremium must be a positive number.' });
          return;
        }
        const t = tierThresholds;
        const tierKeys = ['diamond', 'amethyst', 'ruby', 'emerald', 'gold'];
        if (!t || typeof t !== 'object' || !tierKeys.every((k) => typeof t[k] === 'number' && Number.isFinite(t[k]))) {
          res.status(400).json({ ok: false, error: 'invalid_input', message: 'tierThresholds needs numeric diamond/amethyst/ruby/emerald/gold values.' });
          return;
        }
        if (!(t.diamond > t.amethyst && t.amethyst > t.ruby && t.ruby > t.emerald && t.emerald > t.gold)) {
          res.status(400).json({ ok: false, error: 'invalid_input', message: 'tierThresholds must be strictly descending: diamond > amethyst > ruby > emerald > gold.' });
          return;
        }

        const data = { positionWeights, goalieWeights, minGamesPlayedSkaters: minGpSkaters, minGamesPlayedGoalies: minGpGoalies, ratingFloor: floor, ratingCeil: ceil, ratingPremium: premium, tierThresholds };
        const row = await prisma.ratingSettings.upsert({
          where: { id: SETTINGS_ID },
          create: { id: SETTINGS_ID, ...data },
          update: data,
        });
        res.status(200).json({ ok: true, settings: row });
        return;
      }

      // type === 'projection'
      const weights = body.seasonWeights;
      if (!Array.isArray(weights) || weights.length !== 4 || weights.some((w) => typeof w !== 'number' || !Number.isFinite(w) || w < 0)) {
        res.status(400).json({ ok: false, error: 'invalid_input', message: 'seasonWeights must be 4 non-negative numbers.' });
        return;
      }
      const sum = weights.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
        res.status(400).json({ ok: false, error: 'invalid_input', message: `seasonWeights must sum to 1 (currently ${sum.toFixed(3)}).` });
        return;
      }
      const clipMin = Number(body.multiplierClipMin);
      const clipMax = Number(body.multiplierClipMax);
      if (!Number.isFinite(clipMin) || !Number.isFinite(clipMax) || clipMin <= 0 || clipMax <= clipMin) {
        res.status(400).json({ ok: false, error: 'invalid_input', message: 'multiplierClipMin/Max must be positive with min < max.' });
        return;
      }
      const shrinkage = Number(body.restOfSeasonShrinkageGames);
      if (!Number.isInteger(shrinkage) || shrinkage < 1) {
        res.status(400).json({ ok: false, error: 'invalid_input', message: 'restOfSeasonShrinkageGames must be a positive integer.' });
        return;
      }

      const data = {
        seasonWeights: weights,
        ageCurveEnabled: Boolean(body.ageCurveEnabled),
        multiplierClipMin: clipMin,
        multiplierClipMax: clipMax,
        restOfSeasonShrinkageGames: shrinkage,
      };
      const row = await prisma.projectionSettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID, ...data },
        update: data,
      });
      res.status(200).json({ ok: true, settings: row });
      return;
    }

    res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (err) {
    console.error('fantasy/admin-settings error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};

/** POST { type: 'jersey-image', filename, dataUrl } handler — commits
 *  jerseys/<filename> straight to GitHub (see api/_lib/github.js).
 *  `dataUrl` is the exact string a <canvas>.toDataURL('image/png')
 *  call produces client-side (admin-jerseys.js already processes/trims
 *  the image in the browser; this just lands the result in the repo,
 *  it doesn't touch pixels). Image-only publish, by design — this does
 *  NOT also edit packs.js's JERSEY_ART registry, so wiring a published
 *  image up to a team still needs that one-line addition by hand (or
 *  ask Claude) — see jerseys/README.md. */
async function handleJerseyImagePublish(body, res) {
  const filename = String(body.filename || '');
  if (!JERSEY_FILENAME_RE.test(filename)) {
    res.status(400).json({ ok: false, error: 'invalid_filename', message: 'Filename must be lowercase letters/numbers/hyphens ending in .png.' });
    return;
  }

  const dataUrl = String(body.dataUrl || '');
  const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) {
    res.status(400).json({ ok: false, error: 'invalid_image', message: 'Expected a PNG data URL (data:image/png;base64,...).' });
    return;
  }
  const base64Content = match[1];
  const approxBytes = Math.floor(base64Content.length * 0.75);
  if (approxBytes > JERSEY_MAX_BYTES) {
    res.status(400).json({ ok: false, error: 'too_large', message: `Image is too large (${(approxBytes / 1024 / 1024).toFixed(1)}MB, max 3MB).` });
    return;
  }

  try {
    const result = await putRepoFile(
      `jerseys/${filename}`,
      base64Content,
      `Jersey Packs: add ${filename} via admin upload`,
    );
    res.status(200).json(result);
  } catch (err) {
    const status = err.code === 'no_github_token' ? 501 : 502;
    res.status(status).json({ ok: false, error: err.code || 'github_error', message: err.message });
  }
}

/** Maps a yahoo.js error's .code to an HTTP status — shared by every
 *  yahoo-* handler below so a missing env var / not-yet-connected /
 *  expired-refresh-token all surface as a distinct, actionable status
 *  instead of a blanket 500. */
function yahooErrorStatus(err) {
  if (err.code === 'no_yahoo_credentials') return 501;
  if (err.code === 'not_connected') return 409;
  if (err.code === 'refresh_failed') return 502;
  return 502;
}

/** GET ?type=yahoo-authorize — starts the OAuth flow. Sets a short-lived
 *  random `state` in an HttpOnly cookie and redirects the browser to
 *  Yahoo's consent screen with that same state; handleYahooCallback()
 *  below checks the two match (CSRF protection — nothing but a request
 *  that actually came from clicking this exact link should be able to
 *  complete the flow). */
function handleYahooAuthorize(res) {
  let url;
  try {
    var state = crypto.randomBytes(24).toString('base64url');
    url = yahoo.buildAuthorizeUrl(state);
  } catch (err) {
    res.status(err.code === 'no_yahoo_credentials' ? 501 : 500).json({ ok: false, error: err.code || 'server_error', message: err.message });
    return;
  }
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  res.setHeader('Set-Cookie', `${YAHOO_STATE_COOKIE}=${state}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=600`);
  res.writeHead(302, { Location: url });
  res.end();
}

/** GET ?type=yahoo-callback — where Yahoo redirects back to after the
 *  admin approves (or denies) access. Full browser navigation, not a
 *  fetch() — always ends in a redirect back to admin.html, never JSON,
 *  with the outcome as a query param the Yahoo League tab reads on
 *  load to show a status message. */
async function handleYahooCallback(req, res, prisma) {
  const { parseCookies } = require('../_lib/fantasyAuth');
  const cookies = parseCookies(req);
  const returnedState = req.query?.state;
  const expectedState = cookies[YAHOO_STATE_COOKIE];
  // Clear the state cookie either way — it's single-use.
  res.setHeader('Set-Cookie', `${YAHOO_STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);

  if (req.query?.error) {
    res.writeHead(302, { Location: `/admin.html?tab=yahoo&yahoo=denied` });
    res.end();
    return;
  }
  if (!expectedState || !returnedState || expectedState !== returnedState) {
    res.writeHead(302, { Location: `/admin.html?tab=yahoo&yahoo=state_mismatch` });
    res.end();
    return;
  }
  const code = req.query?.code;
  if (!code) {
    res.writeHead(302, { Location: `/admin.html?tab=yahoo&yahoo=no_code` });
    res.end();
    return;
  }

  try {
    await yahoo.completeAuthorization(prisma, code);
    res.writeHead(302, { Location: `/admin.html?tab=yahoo&yahoo=connected` });
    res.end();
  } catch (err) {
    console.error('yahoo-callback error:', err);
    res.writeHead(302, { Location: `/admin.html?tab=yahoo&yahoo=error` });
    res.end();
  }
}

/** GET ?type=yahoo-status — connection state for the Yahoo League tab:
 *  whether anyone's connected, which league (if picked yet), and when
 *  each cache table last actually got fresh data. */
async function handleYahooStatus(prisma, res) {
  const token = await prisma.yahooToken.findUnique({ where: { id: 'singleton' } });
  if (!token) {
    res.status(200).json({ ok: true, connected: false });
    return;
  }
  const [standings, draft] = await Promise.all([
    prisma.yahooStandingsCache.findUnique({ where: { id: 'singleton' } }),
    prisma.yahooDraftCache.findUnique({ where: { id: 'singleton' } }),
  ]);
  const lastSyncAt = [standings?.fetchedAt, draft?.fetchedAt].filter(Boolean).sort().pop() || null;
  res.status(200).json({
    ok: true,
    connected: true,
    leagueKey: token.leagueKey,
    leagueName: token.leagueName,
    gameKey: token.gameKey,
    lastSyncAt,
  });
}

/** POST { type: 'yahoo-discover-leagues' } — every NHL fantasy league
 *  the connected Yahoo account belongs to, so the admin can pick the
 *  right one by name instead of typing a league key by hand. */
async function handleYahooDiscoverLeagues(prisma, res) {
  try {
    const leagues = await yahoo.discoverLeagues(prisma);
    res.status(200).json({ ok: true, leagues });
  } catch (err) {
    console.error('yahoo-discover-leagues error:', err);
    res.status(yahooErrorStatus(err)).json({ ok: false, error: err.code || 'yahoo_error', message: err.message });
  }
}

/** POST { type: 'yahoo-set-league', leagueKey, gameKey, leagueName } —
 *  picks which discovered league syncLeague() pulls from now on. */
async function handleYahooSetLeague(body, prisma, res) {
  const leagueKey = String(body.leagueKey || '').trim();
  if (!leagueKey) {
    res.status(400).json({ ok: false, error: 'invalid_input', message: 'leagueKey is required.' });
    return;
  }
  const token = await prisma.yahooToken.findUnique({ where: { id: 'singleton' } });
  if (!token) {
    res.status(409).json({ ok: false, error: 'not_connected', message: 'Connect to Yahoo first.' });
    return;
  }
  await prisma.yahooToken.update({
    where: { id: 'singleton' },
    data: {
      leagueKey,
      gameKey: body.gameKey ? String(body.gameKey) : null,
      leagueName: body.leagueName ? String(body.leagueName) : null,
    },
  });
  res.status(200).json({ ok: true, leagueKey });
}

/** POST { type: 'yahoo-sync' } (admin-triggered) or GET ?type=yahoo-sync
 *  with the cron's bearer secret (daily-scheduled — see vercel.json).
 *  Same underlying pull either way: standings, current-week matchups,
 *  every team's roster, transactions, and draft results for whichever
 *  league Admin -> Yahoo League has picked. */
async function handleYahooSync(prisma, res) {
  try {
    const token = await prisma.yahooToken.findUnique({ where: { id: 'singleton' } });
    if (!token) {
      res.status(409).json({ ok: false, error: 'not_connected', message: 'Connect to Yahoo first.' });
      return;
    }
    if (!token.leagueKey) {
      res.status(409).json({ ok: false, error: 'no_league_selected', message: 'Pick a league first (Admin -> Yahoo League).' });
      return;
    }
    const summary = await yahoo.syncLeague(prisma, token.leagueKey);
    res.status(200).json({ ok: true, summary });
  } catch (err) {
    console.error('yahoo-sync error:', err);
    res.status(yahooErrorStatus(err)).json({ ok: false, error: err.code || 'yahoo_error', message: err.message });
  }
}
