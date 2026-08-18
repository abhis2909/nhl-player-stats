'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionUser, readJsonBody } = require('../_lib/fantasyAuth');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_PLAYERS_PER_SIDE = 6;
const WINNERS = new Set(['A', 'B', 'even']);

/* /api/fantasy/trades — the Fantasy Hub page's Trade Analyzer log.

   GET  (public, no auth)         -> { ok, trades: [...] }
     ?limit= caps how many rows come back (default 20, max 50), newest
     first. Each trade includes the submitter's username/displayName/
     avatarUrl (one query, no second round trip for the Recent
     Transactions feed to render an avatar next to each row).

   POST (session required)        -> { ok, trade }
     Body: { sideA, sideB, sideAOverall, sideBOverall, winner }. sideA/
     sideB are point-in-time player snapshots (NOT live roster refs —
     there's no Team/Roster model, see prisma/schema.prisma's Trade
     comment) built client-side from the already-loaded, already-rated
     current-season pool. sideAOverall/sideBOverall are the average
     ratePool() `.overall` across each side, computed the SAME way —
     this endpoint trusts and stores them as sent rather than
     recomputing server-side, since recomputing would need the full
     rated player pool available here too for no real benefit (nothing
     here is adversarial/competitive — a wrong number just means a
     wrong-looking log entry, not an unfair advantage). */
module.exports = async function handler(req, res) {
  if (req.method === 'GET') return handleList(req, res);
  if (req.method === 'POST') return handleSubmit(req, res);
  res.status(405).json({ ok: false, error: 'method_not_allowed' });
};

async function handleList(req, res) {
  try {
    const prisma = getPrisma();
    const url = new URL(req.url, 'http://localhost');
    const rawLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

    const trades = await prisma.trade.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { username: true, displayName: true, avatarUrl: true } } },
    });

    res.status(200).json({ ok: true, trades });
  } catch (err) {
    console.error('fantasy/trades (GET) error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

function isValidSide(side) {
  if (!Array.isArray(side) || side.length < 1 || side.length > MAX_PLAYERS_PER_SIDE) return false;
  return side.every((p) => p && typeof p === 'object'
    && (typeof p.playerId === 'number' || typeof p.playerId === 'string')
    && typeof p.name === 'string' && p.name.trim()
    && typeof p.team === 'string'
    && typeof p.pos === 'string'
    && typeof p.overall === 'number');
}

async function handleSubmit(req, res) {
  try {
    const prisma = getPrisma();
    const user = await getSessionUser(req, prisma);
    if (!user) {
      res.status(401).json({ ok: false, error: 'unauthenticated' });
      return;
    }

    const body = await readJsonBody(req);
    const { sideA, sideB, sideAOverall, sideBOverall, winner } = body;

    if (!isValidSide(sideA) || !isValidSide(sideB)) {
      res.status(400).json({ ok: false, error: 'invalid_input', message: `Each side needs 1-${MAX_PLAYERS_PER_SIDE} players.` });
      return;
    }
    if (typeof sideAOverall !== 'number' || typeof sideBOverall !== 'number') {
      res.status(400).json({ ok: false, error: 'invalid_input', message: 'Missing side grades.' });
      return;
    }
    if (!WINNERS.has(winner)) {
      res.status(400).json({ ok: false, error: 'invalid_input', message: 'winner must be "A", "B", or "even".' });
      return;
    }

    const trade = await prisma.trade.create({
      data: { userId: user.id, sideA, sideB, sideAOverall, sideBOverall, winner },
      include: { user: { select: { username: true, displayName: true, avatarUrl: true } } },
    });

    res.status(200).json({ ok: true, trade });
  } catch (err) {
    console.error('fantasy/trades (POST) error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}
