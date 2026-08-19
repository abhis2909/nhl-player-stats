'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionAdmin, readJsonBody } = require('../_lib/fantasyAuth');

/* /api/fantasy/admin-users — admin-only, the Users sub-tab on
   admin.html.

   GET  -> two modes on the same route, dispatched by an optional
   ?username= query param (see server.js's req.query shim for local dev
   parity with Vercel's Node runtime):
     - no ?username=: list every league-member account (current avatar,
       any pending avatar-change request, credits balance — summed
       fresh from CreditTransaction, same as session.js's
       toUserPayload) plus `dailyActivity`, the most recent
       daily-guesser results across everyone (date, who, solved?,
       attempts) — flat, recent-first, not paginated, since a league
       this size never needs more than that.
     - ?username=<name>: single-user detail (Admin -> Users -> Manage)
       — that user's own profile fields plus their FULL credit
       transaction history (reason/amount/note/date), newest first.
       404 unknown_username if there's no such account.
   Neither mode ever returns passwordHash itself, just a derived
   "setUp" boolean (whether the person has logged in and picked a
   password yet).

   POST -> { username, action, ...action-specific fields }
     - approveAvatar / rejectAvatar: review a pending avatar request —
       approve copies avatarRequestUrl -> avatarUrl, reject just clears
       the request fields. 409 no_pending_request if there isn't one.
     - setAvatar: { avatarUrl } — sets avatarUrl DIRECTLY, no approval
       step (this is the admin doing it themselves, e.g. from the
       Manage modal's upload), and clears any pending request too since
       a direct set supersedes it.
     - adjustCredits: { amount, note? } — amount is a non-zero integer
       delta (negative to deduct); creates a CreditTransaction with
       reason "admin_adjustment" so it's a normal, audited ledger entry
       like every other credit movement, not a hidden balance edit.
   All admin-gated, same session check as the GET side. */

const RECENT_ACTIVITY_LIMIT = 30;
const USER_TRANSACTIONS_LIMIT = 100;
const MAX_AVATAR_URL_LENGTH = 2_000_000; // same cap as session.js's PATCH
const MAX_CREDIT_ADJUSTMENT = 100_000; // sanity bound against a fat-fingered amount
const MAX_ADJUSTMENT_NOTE_LENGTH = 200;

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

    const detailUsername = typeof req.query?.username === 'string' ? req.query.username.trim() : '';
    if (detailUsername) return await handleUserDetail(res, prisma, detailUsername);

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

    // Whether a solve ACTUALLY got credited — not assumed from `solved`
    // alone. A day can be solved but never credited (e.g. it was solved
    // before this feature existed, or the winning sync never reached
    // the server), so this checks for a real CreditTransaction row
    // rather than hardcoding "+25" next to every solved day.
    const creditedRows = await prisma.creditTransaction.findMany({
      where: { refType: 'DailyGuess', refId: { in: recentGuesses.map((g) => g.id) } },
      select: { refId: true, amount: true },
    });
    const creditedByGuessId = new Map(creditedRows.map((c) => [c.refId, c.amount]));

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
        creditsAwarded: creditedByGuessId.get(g.id) || 0,
      })),
    });
  } catch (err) {
    console.error('fantasy/admin-users (GET) error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

async function handleUserDetail(res, prisma, username) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    res.status(404).json({ ok: false, error: 'unknown_username', message: 'No account with that username.' });
    return;
  }

  const transactions = await prisma.creditTransaction.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: USER_TRANSACTIONS_LIMIT,
  });
  // Sum ALL of them for the balance, not just the capped page above —
  // a heavy user could in principle have more than USER_TRANSACTIONS_LIMIT
  // rows, and the balance must never be short by whatever fell off the page.
  const sum = await prisma.creditTransaction.aggregate({
    where: { userId: user.id },
    _sum: { amount: true },
  });

  res.status(200).json({
    ok: true,
    user: {
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      avatarRequestUrl: user.avatarRequestUrl,
      avatarRequestNote: user.avatarRequestNote,
      avatarRequestedAt: user.avatarRequestedAt,
      creditBalance: sum._sum.amount || 0,
    },
    transactions: transactions.map((t) => ({
      id: t.id,
      amount: t.amount,
      reason: t.reason,
      refType: t.refType,
      note: t.note,
      createdAt: t.createdAt,
    })),
  });
}

const VALID_ACTIONS = new Set(['approveAvatar', 'rejectAvatar', 'setAvatar', 'adjustCredits']);

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
    if (!username || !VALID_ACTIONS.has(action)) {
      res.status(400).json({ ok: false, error: 'invalid_input', message: 'username and a valid action are required.' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      res.status(404).json({ ok: false, error: 'unknown_username', message: 'No account with that username.' });
      return;
    }

    if (action === 'approveAvatar' || action === 'rejectAvatar') return await reviewAvatarRequest(res, prisma, user, action);
    if (action === 'setAvatar') return await setAvatarDirect(res, prisma, user, body);
    if (action === 'adjustCredits') return await adjustCredits(res, prisma, user, body);
  } catch (err) {
    console.error('fantasy/admin-users (POST) error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

async function reviewAvatarRequest(res, prisma, user, action) {
  if (!user.avatarRequestedAt) {
    res.status(409).json({ ok: false, error: 'no_pending_request', message: 'No pending avatar request for this user.' });
    return;
  }
  const updated = await prisma.user.update({
    where: { username: user.username },
    data: {
      avatarUrl: action === 'approveAvatar' ? user.avatarRequestUrl : user.avatarUrl,
      avatarRequestUrl: null,
      avatarRequestNote: null,
      avatarRequestedAt: null,
    },
  });
  res.status(200).json({ ok: true, username: updated.username, avatarUrl: updated.avatarUrl });
}

/* Admin sets a user's avatar directly (Manage modal's own upload —
   distinct from the manager's own self-submitted REQUEST flow above).
   No approval step since the admin IS the approver here. Accepts the
   same data: URI shape session.js's PATCH validates (client-side
   resized/compressed before ever arriving), OR a plain site-relative
   path like /avatars/name.jpg (the fantasy-hub/scripts/set-avatar.js
   CLI's own shape) — either is just a string an <img src> points at.
   Clears any pending request too, since a direct admin set supersedes
   whatever the manager had asked for. */
async function setAvatarDirect(res, prisma, user, body) {
  const avatarUrl = typeof body.avatarUrl === 'string' ? body.avatarUrl.trim() : '';
  if (!avatarUrl) {
    res.status(400).json({ ok: false, error: 'invalid_input', message: 'Pick an image to set.' });
    return;
  }
  if (avatarUrl.length > MAX_AVATAR_URL_LENGTH) {
    res.status(400).json({ ok: false, error: 'invalid_input', message: 'That image is too large — try a smaller one.' });
    return;
  }
  const updated = await prisma.user.update({
    where: { username: user.username },
    data: { avatarUrl, avatarRequestUrl: null, avatarRequestNote: null, avatarRequestedAt: null },
  });
  res.status(200).json({ ok: true, username: updated.username, avatarUrl: updated.avatarUrl });
}

/* { amount, note? } — amount is a non-zero integer delta (negative
   deducts). Always a NEW CreditTransaction row, never a direct balance
   edit, so this shows up in the user's own history exactly like every
   other credit movement (reason "admin_adjustment") — see
   prisma/schema.prisma's CreditTransaction.note doc comment. */
async function adjustCredits(res, prisma, user, body) {
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_CREDIT_ADJUSTMENT) {
    res.status(400).json({ ok: false, error: 'invalid_input', message: `Amount must be a non-zero whole number (max ${MAX_CREDIT_ADJUSTMENT}).` });
    return;
  }
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_ADJUSTMENT_NOTE_LENGTH) || null : null;

  await prisma.creditTransaction.create({
    data: { userId: user.id, amount, reason: 'admin_adjustment', note },
  });
  const sum = await prisma.creditTransaction.aggregate({
    where: { userId: user.id },
    _sum: { amount: true },
  });
  res.status(200).json({ ok: true, username: user.username, creditBalance: sum._sum.amount || 0 });
}
