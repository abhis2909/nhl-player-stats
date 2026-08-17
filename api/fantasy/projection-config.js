'use strict';

const { getPrisma } = require('../_lib/db');

// Same defaults as ProjectionSettings' @default()s in prisma/schema.prisma —
// used verbatim here so a fresh DB with no settings row yet (before the
// admin has ever saved one) still produces a usable projection instead of
// forcing every caller to special-case "no settings saved yet".
const DEFAULT_SETTINGS = {
  seasonWeights: [0.4, 0.3, 0.2, 0.1],
  ageCurveEnabled: true,
  multiplierClipMin: 0.85,
  multiplierClipMax: 1.15,
};

/* GET /api/fantasy/projection-config?season=2026-27 — PUBLIC (no login):
   returns the admin-entered deployment overrides for that season plus the
   current projection methodology settings. Read by projections.js on the
   Stats page for every visitor, not just the admin — projections should
   show for everyone, same as everything else on the site. Writing this
   data is admin-only (see admin-deployment.js / admin-projection-settings.js);
   this endpoint never accepts a body. */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const season = (url.searchParams.get('season') || '').trim();
    if (!season) {
      res.status(400).json({ ok: false, error: 'invalid_input', message: 'season is required.' });
      return;
    }

    const prisma = getPrisma();
    const [deployment, settingsRow] = await Promise.all([
      prisma.playerDeployment.findMany({ where: { season } }),
      prisma.projectionSettings.findUnique({ where: { id: 'singleton' } }),
    ]);

    const settings = settingsRow
      ? {
        seasonWeights: settingsRow.seasonWeights,
        ageCurveEnabled: settingsRow.ageCurveEnabled,
        multiplierClipMin: settingsRow.multiplierClipMin,
        multiplierClipMax: settingsRow.multiplierClipMax,
      }
      : DEFAULT_SETTINGS;

    res.status(200).json({
      ok: true,
      deployment: deployment.map((d) => ({
        nhlPlayerId: d.nhlPlayerId,
        toiPerGame: d.toiPerGame,
        ppToiPerGame: d.ppToiPerGame,
        gamesProjected: d.gamesProjected,
      })),
      settings,
    });
  } catch (err) {
    console.error('fantasy/projection-config error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
