'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionAdmin, readJsonBody } = require('../_lib/fantasyAuth');

const SETTINGS_ID = 'singleton';
const WEIGHT_SUM_TOLERANCE = 0.01; // floats — don't demand an exact 1.0

/* /api/fantasy/admin-settings — admin-only read/write of the site's two
   singular tunable-methodology rows: ProjectionSettings and
   RatingSettings. One file (was admin-projection-settings.js, before
   Rating Methodology needed the identical GET/POST/upsert-singleton-row
   shape) dispatched by a `type` param, same function-count discipline
   as session.js/admin-session.js merging by HTTP verb — this merges by
   resource instead, since both methods (GET+POST) apply to either type.
   The public read side is public-config.js (was projection-config.js;
   falls back to the same defaults as here if a row doesn't exist yet).

   GET  ?type=projection (default) -> { ok, settings } (ProjectionSettings)
   GET  ?type=rating               -> { ok, settings } (RatingSettings)
   POST { type: 'projection', seasonWeights, ageCurveEnabled, multiplierClipMin, multiplierClipMax, restOfSeasonShrinkageGames }
   POST { type: 'rating', positionWeights, goalieWeights, minGamesPlayedSkaters, minGamesPlayedGoalies, ratingFloor, ratingCeil, ratingPremium, tierThresholds } */
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
