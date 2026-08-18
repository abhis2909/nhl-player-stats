'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionAdmin, readJsonBody } = require('../_lib/fantasyAuth');

/* /api/fantasy/admin-users — admin-only, the Users sub-tab on
   admin.html.

   GET  -> list every league-member account, plus each one's current
   avatar, any pending avatar-change request (avatarRequestUrl/
   avatarRequestNote/avatarRequestedAt — see prisma/schema.prisma's
   User model and api/fantasy/session.js's PATCH, which is where a
   request actually gets submitted), and their credits balance (Phase 1
   of the credits system — summed fresh from CreditTransaction, same as
   session.js's toUserPayload). Never returns passwordHash itself, just
   a derived "setUp" boolean (whether the person has logged in and
   picked a password yet). Also returns `dailyActivity`: the most recent
   daily-guesser results across everyone (date, who, solved?, attempts)
   — this is the "performance reported to admin" half of Phase 1; it's
   not per-user paginated, just a flat recent-first feed, since a league
   this size will never need more than that.

   POST -> { username, action: 'approveAvatar' | 'rejectAvatar' }
   Reviews a pending avatar request:
     - approveAvatar: copies avatarRequestUrl -> avatarUrl, clears the
       request fields. 409 no_pending_request if there isn't one.
     - rejectAvatar: just clears the request fields, avatarUrl untouched.
   Both admin-gated, same session check as the GET side. */

const RECENT_ACTIVITY_LIMIT = 30;
module.exports = async function handler(req, res) {
  if (req.method === 'GET') return handleList(req, res);
  if (req.method === 'POST') return handleReview(req, res);
  res.status(405).json({ ok: false, error: 'method_not_allowed' });
};

async function handleList(req, res) {
  try {
    const prisma = getPrisma();
    const admin = await getSessionAdmin(req, prisma);
    if (!admin) {
      res.status(401).json({ ok: false, error: 'not_authenticated' });
      return;
    }

    const [users, creditSums, recentGuesses] = await Promise.all([
      prisma.user.findMany({
        orderBy: { username: 'asc' },
        select: {
          id: true,
          username: true,
          displayName: true,
          createdAt: true,
          lastLoginAt: true,
          lockedUntil: true,
          passwordHash: true,
          avatarUrl: true,
          avatarRequestUrl: true,
          avatarRequestNote: true,
          avatarRequestedAt: true,
        },
      }),
      // Same "no stored balance, sum it fresh" approach as session.js's
      // creditBalanceFor() — one groupBy for everyone instead of N
      // per-user aggregate queries.
      prisma.creditTransaction.groupBy({ by: ['userId'], _sum: { amount: true } }),
      prisma.dailyGuess.findMany({
        orderBy: [{ date: 'desc' }, { updatedAt: 'desc' }],
        take: RECENT_ACTIVITY_LIMIT,
        include: { user: { select: { username: true, displayName: true } } },
      }),
    ]);

    const creditByUserId = new Map(creditSums.map((row) => [row.userId, row._sum.amount || 0]));

    res.status(200).json({
      ok: true,
      users: users.map((u) => ({
        username: u.username,
        displayName: u.displayName,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        lockedUntil: u.lockedUntil,
        setUp: Boolean(u.passwordHash),
        avatarUrl: u.avatarUrl,
        avatarRequestUrl: u.avatarRequestUrl,
        avatarRequestNote: u.avatarRequestNote,
        avatarRequestedAt: u.avatarRequestedAt,
        creditBalance: creditByUserId.get(u.id) || 0,
      })),
      dailyActivity: recentGuesses.map((g) => ({
        date: g.date,
        username: g.user.username,
        displayName: g.user.displayName,
        solved: g.solved,
        attempts: g.attempts,
      })),
    });
  } catch (err) {
    console.error('fantasy/admin-users (GET) error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

async function handleReview(req, res) {
  try {
    const prisma = getPrisma();
    const admin = await getSessionAdmin(req, prisma);
    if (!admin) {
      res.status(401).json({ ok: false, error: 'not_authenticated' });
      return;
    }

    const body = await readJsonBody(req);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const action = body.action;
    if (!username || (action !== 'approveAvatar' && action !== 'rejectAvatar')) {
      res.status(400).json({ ok: false, error: 'invalid_input', message: 'username and a valid action are required.' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      res.status(404).json({ ok: false, error: 'unknown_username', message: 'No account with that username.' });
      return;
    }
    if (!user.avatarRequestedAt) {
      res.status(409).json({ ok: false, error: 'no_pending_request', message: 'No pending avatar request for this user.' });
      return;
    }

    const updated = await prisma.user.update({
      where: { username },
      data: {
        avatarUrl: action === 'approveAvatar' ? user.avatarRequestUrl : user.avatarUrl,
        avatarRequestUrl: null,
        avatarRequestNote: null,
        avatarRequestedAt: null,
      },
    });

    res.status(200).json({ ok: true, username: updated.username, avatarUrl: updated.avatarUrl });
  } catch (err) {
    console.error('fantasy/admin-users (POST) error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}
