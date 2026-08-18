'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionAdmin, readJsonBody } = require('../_lib/fantasyAuth');

/* /api/fantasy/admin-deployment — admin-only read/write of PlayerDeployment
   rows, edited from admin.html's Deployment sub-tab. The public read side
   (everyone's Stats page) is the separate GET-only public-config.js —
   this endpoint is never called by anyone but the logged-in admin.

   GET  ?season=2026-27              -> { ok, deployment: [...] } (all rows for that season)
   POST { season, nhlPlayerId,
          toiPerGame?, ppToiPerGame?, gamesProjected? }
                                      -> upserts one player's row (fields
                                         omitted/null are left/cleared to
                                         null — "no override for that metric",
                                         see prisma/schema.prisma)
   DELETE ?season=X&nhlPlayerId=Y    -> removes the row entirely (back to
                                         "use historical average" for every
                                         metric) */
module.exports = async function handler(req, res) {
  try {
    const prisma = getPrisma();
    const admin = await getSessionAdmin(req, prisma);
    if (!admin) {
      res.status(401).json({ ok: false, error: 'not_authenticated' });
      return;
    }

    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const season = (url.searchParams.get('season') || '').trim();
      if (!season) {
        res.status(400).json({ ok: false, error: 'invalid_input', message: 'season is required.' });
        return;
      }
      const rows = await prisma.playerDeployment.findMany({ where: { season }, orderBy: { nhlPlayerId: 'asc' } });
      res.status(200).json({ ok: true, deployment: rows });
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const season = typeof body.season === 'string' ? body.season.trim() : '';
      const nhlPlayerId = Number(body.nhlPlayerId);
      if (!season || !Number.isInteger(nhlPlayerId)) {
        res.status(400).json({ ok: false, error: 'invalid_input', message: 'season and nhlPlayerId are required.' });
        return;
      }
      const toNullableFloat = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
      const toNullableInt = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v)));

      const data = {
        toiPerGame: toNullableFloat(body.toiPerGame),
        ppToiPerGame: toNullableFloat(body.ppToiPerGame),
        gamesProjected: toNullableInt(body.gamesProjected),
      };

      const row = await prisma.playerDeployment.upsert({
        where: { season_nhlPlayerId: { season, nhlPlayerId } },
        create: { season, nhlPlayerId, ...data },
        update: data,
      });
      res.status(200).json({ ok: true, deployment: row });
      return;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, 'http://localhost');
      const season = (url.searchParams.get('season') || '').trim();
      const nhlPlayerId = Number(url.searchParams.get('nhlPlayerId'));
      if (!season || !Number.isInteger(nhlPlayerId)) {
        res.status(400).json({ ok: false, error: 'invalid_input', message: 'season and nhlPlayerId are required.' });
        return;
      }
      await prisma.playerDeployment.deleteMany({ where: { season, nhlPlayerId } });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (err) {
    console.error('fantasy/admin-deployment error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
