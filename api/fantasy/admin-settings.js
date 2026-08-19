'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionAdmin, readJsonBody } = require('../_lib/fantasyAuth');
const { putRepoFile } = require('../_lib/github');

const SETTINGS_ID = 'singleton';
const WEIGHT_SUM_TOLERANCE = 0.01; // floats — don't demand an exact 1.0

// jerseys/<name>.png only — blocks path traversal (no ../, no
// subdirectories) since this becomes part of a GitHub API path.
const JERSEY_FILENAME_RE = /^[a-z0-9][a-z0-9-]{0,80}\.png$/i;
const JERSEY_MAX_BYTES = 3 * 1024 * 1024; // headroom under Vercel's ~4.5MB request body cap

/* /api/fantasy/admin-settings — admin-only read/write of the site's two
   singular tunable-methodology rows (ProjectionSettings and
   RatingSettings) PLUS, as of the `jersey-image` POST type, publishing
   a processed jersey PNG straight to this repo's jerseys/ folder —
   an unrelated concern jammed in here for the same reason
   session.js/admin-session.js merge by HTTP verb and this file already
   merges by resource: the Hobby-plan 12-function cap leaves no room for
   a dedicated endpoint. One admin-only auth check up top covers all of
   it. The public read side (for the two settings types) is
   public-config.js (was projection-config.js; falls back to the same
   defaults as here if a row doesn't exist yet).

   GET  ?type=projection (default) -> { ok, settings } (ProjectionSettings)
   GET  ?type=rating               -> { ok, settings } (RatingSettings)
   POST { type: 'projection', seasonWeights, ageCurveEnabled, multiplierClipMin, multiplierClipMax, restOfSeasonShrinkageGames }
   POST { type: 'rating', positionWeights, goalieWeights, minGamesPlayedSkaters, minGamesPlayedGoalies, ratingFloor, ratingCeil, ratingPremium, tierThresholds }
   POST { type: 'jersey-image', filename, dataUrl } -> commits jerseys/<filename> to GitHub;
         { ok, commitUrl, path } or { ok: false, error, message } */
module.exports = async function handler(req, res) {
  try {
    const prisma = getPrisma();
    const admin = await getSessionAdmin(req, prisma);
    if (!admin) {
      res.status(401).json({ ok: false, error: 'not_authenticated' });
      return;
    }

    if (req.method === 'GET') {
      const type = (req.query?.type || 'projection') === 'rating' ? 'rating' : 'projection';
      const row = type === 'rating'
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
