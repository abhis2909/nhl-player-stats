'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionAdmin, readJsonBody } = require('../_lib/fantasyAuth');

const SETTINGS_ID = 'singleton';
const WEIGHT_SUM_TOLERANCE = 0.01; // floats — don't demand an exact 1.0

/* /api/fantasy/admin-projection-settings — admin-only read/write of the
   ONE ProjectionSettings row, edited from admin.html's Projection
   Methodology sub-tab. The public read side is projection-config.js
   (falls back to the same defaults if this row doesn't exist yet).

   GET  -> { ok, settings }
   POST { seasonWeights: [w1,w2,w3,w4], ageCurveEnabled, multiplierClipMin, multiplierClipMax }
       -> validates weights are 4 numbers summing to ~1 and the clip
          range is sane, then upserts the singleton row. */
module.exports = async function handler(req, res) {
  try {
    const prisma = getPrisma();
    const admin = await getSessionAdmin(req, prisma);
    if (!admin) {
      res.status(401).json({ ok: false, error: 'not_authenticated' });
      return;
    }

    if (req.method === 'GET') {
      const row = await prisma.projectionSettings.findUnique({ where: { id: SETTINGS_ID } });
      res.status(200).json({ ok: true, settings: row });
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
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

      const data = {
        seasonWeights: weights,
        ageCurveEnabled: Boolean(body.ageCurveEnabled),
        multiplierClipMin: clipMin,
        multiplierClipMax: clipMax,
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
    console.error('fantasy/admin-projection-settings error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
