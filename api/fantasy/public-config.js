'use strict';

const { getPrisma } = require('../_lib/db');

// Same defaults as ProjectionSettings'/RatingSettings' @default()s in
// prisma/schema.prisma — used verbatim here so a fresh DB with no
// settings row yet (before the admin has ever saved one) still
// produces normal behavior instead of forcing every caller to
// special-case "no settings saved yet". The rating defaults are an
// exact copy of ratings.js's own hardcoded constants (POSITION_WEIGHTS/
// GOALIE_WEIGHTS/MIN_GP_FRACTION/RATING_FLOOR..CEIL/RATING_PREMIUM/
// tierFor() thresholds) — keep the two in sync if either ever changes.
const DEFAULT_PROJECTION_SETTINGS = {
  seasonWeights: [0.4, 0.3, 0.2, 0.1],
  ageCurveEnabled: true,
  multiplierClipMin: 0.85,
  multiplierClipMax: 1.15,
  restOfSeasonShrinkageGames: 20,
};

const DEFAULT_RATING_SETTINGS = {
  positionWeights: {
    C: {
      goals: 1.1, assists: 1.4, points: 1.3, plusMinus: 1.0, ppGoals: 1.1, ppPoints: 1.2,
      shGoals: 1.2, shPoints: 1.3, gameWinningGoals: 1.1, otGoals: 1.0, pim: 0.7, sog: 1.0,
      shootingPct: 0.9, gamesPlayed: 0.8, hits: 0.7, blocks: 0.9, giveaways: 1.0, takeaways: 1.1,
      faceoffPct: 1.5,
    },
    W: {
      goals: 1.4, assists: 1.0, points: 1.2, plusMinus: 1.0, ppGoals: 1.3, ppPoints: 1.3,
      shGoals: 0.7, shPoints: 0.6, gameWinningGoals: 1.2, otGoals: 1.1, pim: 0.9, sog: 1.3,
      shootingPct: 1.1, gamesPlayed: 0.8, hits: 1.1, blocks: 0.6, giveaways: 0.9, takeaways: 0.8,
      faceoffPct: 0.3,
    },
    D: {
      goals: 0.6, assists: 1.1, points: 1.0, plusMinus: 1.1, ppGoals: 0.7, ppPoints: 1.1,
      shGoals: 1.0, shPoints: 1.3, gameWinningGoals: 0.7, otGoals: 0.6, pim: 1.0, sog: 0.7,
      shootingPct: 0.6, gamesPlayed: 0.9, hits: 1.5, blocks: 2.1, giveaways: 1.3, takeaways: 1.3,
      faceoffPct: 0.2,
    },
  },
  goalieWeights: {
    wins: 1.3, losses: 0.8, otLosses: 0.7, gaa: 1.4, savePct: 1.4,
    saves: 0.8, shutouts: 1.1, gamesPlayed: 0.6, gamesStarted: 0.7,
    goalsAgainst: 0.8, shotsAgainst: 0.5,
  },
  minGpFraction: 0.2,
  ratingFloor: 25,
  ratingCeil: 99,
  ratingPremium: 1.04,
  tierThresholds: { diamond: 92, amethyst: 87, ruby: 82, emerald: 77, gold: 70 },
};

/* GET /api/fantasy/public-config?season=2026-27 — PUBLIC (no login):
   the one place every stats-page view (historical, current, projected,
   custom range) fetches its admin-tunable inputs from in a single round
   trip — deployment overrides + Projection Methodology + Rating
   Methodology. Writing any of this is admin-only (see admin-deployment.js
   / admin-settings.js); this endpoint never accepts a body.
   `season` is optional — deployment overrides are season-scoped and
   only included if a season is given, but the two settings objects are
   always returned regardless (e.g. the Power Ranking column needs
   ratingSettings on views that have no "projected season" concept at all). */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const season = (url.searchParams.get('season') || '').trim();

    const prisma = getPrisma();
    const [deployment, projectionRow, ratingRow] = await Promise.all([
      season ? prisma.playerDeployment.findMany({ where: { season } }) : Promise.resolve([]),
      prisma.projectionSettings.findUnique({ where: { id: 'singleton' } }),
      prisma.ratingSettings.findUnique({ where: { id: 'singleton' } }),
    ]);

    const settings = projectionRow
      ? {
        seasonWeights: projectionRow.seasonWeights,
        ageCurveEnabled: projectionRow.ageCurveEnabled,
        multiplierClipMin: projectionRow.multiplierClipMin,
        multiplierClipMax: projectionRow.multiplierClipMax,
        restOfSeasonShrinkageGames: projectionRow.restOfSeasonShrinkageGames,
      }
      : DEFAULT_PROJECTION_SETTINGS;

    const ratingSettings = ratingRow
      ? {
        positionWeights: ratingRow.positionWeights,
        goalieWeights: ratingRow.goalieWeights,
        minGpFraction: ratingRow.minGpFraction,
        ratingFloor: ratingRow.ratingFloor,
        ratingCeil: ratingRow.ratingCeil,
        ratingPremium: ratingRow.ratingPremium,
        tierThresholds: ratingRow.tierThresholds,
      }
      : DEFAULT_RATING_SETTINGS;

    res.status(200).json({
      ok: true,
      deployment: deployment.map((d) => ({
        nhlPlayerId: d.nhlPlayerId,
        toiPerGame: d.toiPerGame,
        ppToiPerGame: d.ppToiPerGame,
        gamesProjected: d.gamesProjected,
      })),
      settings,
      ratingSettings,
    });
  } catch (err) {
    console.error('fantasy/public-config error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
