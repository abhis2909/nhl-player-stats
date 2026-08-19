'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionUser, readJsonBody } = require('../_lib/fantasyAuth');
const { getOrFreezeDailyPlayer } = require('../_lib/guessWhoPool');

const MAX_GUESSES = 8;

// Phase 1 of the credits system — see prisma/schema.prisma's
// CreditTransaction model. A correct daily-guesser solve is worth a
// flat 25 credits, once per user per date. Nothing else spends or
// awards credits yet.
const DAILY_GUESS_REWARD = 25;

/* /api/fantasy/guesswho-sync

   GET ?date=YYYY-MM-DD — PUBLIC (no auth; anonymous play must keep
   working). Returns { ok, date, pool } — the SAME frozen roster/bio
   pool that determined that date's mystery player. getOrFreezeDailyPlayer()
   (api/_lib/guessWhoPool.js) is USUALLY just a fast DB read here — the
   daily cron (api/fantasy/snapshots.js) already proactively freezes
   today's pool once, right alongside the season-stats snapshot it
   fetches on the same schedule, so by the time real visitors show up
   there's typically nothing left to fetch. This only falls back to a
   live NHL API call for a date the cron didn't anticipate (see that
   function's doc comment). guesswho.js fetches this once per page load
   instead of independently re-fetching all 32 team rosters itself —
   the real fix for a real bug (2026-08-19): firing 32 parallel roster
   requests routinely got some 429'd by the NHL API, silently shrinking
   the pool, so the client's own pick and the server's frozen pick came
   from different-sized pools and landed on DIFFERENT players — real
   solves got marked "not solved" server-side. Serving one server-
   frozen pool to everyone eliminates that by construction: every
   client runs pickMysteryPlayer() against the literal same array the
   server used. This doesn't leak anything new — the picking algorithm
   was already public in guesswho.js's own source, same as before.

   POST — session required.
   Body: { date: "YYYY-MM-DD", guesses: number[], gameOver, won }
   (gameOver/won accepted but NOT trusted — solved/attempts are always
   recomputed server-side from `guesses` vs. the frozen DailyPlayer.)

   Fire-and-forget from guesswho.js after every local guess. Sends the
   FULL current guesses array each time (not a delta) and always upserts
   the DailyGuess row wholesale — trivially idempotent even if this
   fires more than once or arrives out of order.

   Also where the daily-guesser side of the credits system lives: the
   FIRST sync of a given date+user that turns up solved (wasSolved false
   -> solved true) grants DAILY_GUESS_REWARD credits via a
   CreditTransaction row. Every later sync for that same solved day is a
   no-op credits-wise, since guesses only ever grow and wasSolved would
   already be true. Response echoes `creditsAwarded` (0 or
   DAILY_GUESS_REWARD) so guesswho.js can show a "+25 credits" toast
   without a second round trip. */
module.exports = async function handler(req, res) {
  if (req.method === 'GET') return handleGetPool(req, res);
  if (req.method === 'POST') return handleSync(req, res);
  res.status(405).json({ ok: false, error: 'method_not_allowed' });
};

async function handleGetPool(req, res) {
  try {
    const prisma = getPrisma();
    const url = new URL(req.url, 'http://localhost');
    const date = url.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ ok: false, error: 'invalid_input' });
      return;
    }

    const dailyPlayer = await getOrFreezeDailyPlayer(prisma, date);
    res.status(200).json({ ok: true, date, pool: dailyPlayer.pool });
  } catch (err) {
    console.error('fantasy/guesswho-sync (GET) error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

async function handleSync(req, res) {
  try {
    const prisma = getPrisma();
    const user = await getSessionUser(req, prisma);
    if (!user) {
      res.status(401).json({ ok: false, error: 'unauthenticated' });
      return;
    }

    const body = await readJsonBody(req);
    const date = typeof body.date === 'string' ? body.date : '';
    const guesses = Array.isArray(body.guesses) ? body.guesses.filter((n) => Number.isInteger(n)) : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !guesses || guesses.length > MAX_GUESSES) {
      res.status(400).json({ ok: false, error: 'invalid_input' });
      return;
    }

    const dailyPlayer = await getOrFreezeDailyPlayer(prisma, date);

    const solved = guesses.includes(dailyPlayer.nhlPlayerId);
    const attempts = guesses.length;

    // Read the prior state BEFORE upserting so we can tell a fresh solve
    // (wasSolved false -> solved true, award credits) apart from a
    // resync of an already-solved day (wasSolved already true, guesses
    // only ever grow — never award twice for the same date+user).
    const existing = await prisma.dailyGuess.findUnique({
      where: { date_userId: { date, userId: user.id } },
      select: { solved: true },
    });
    const wasSolved = existing?.solved ?? false;

    const dailyGuess = await prisma.dailyGuess.upsert({
      where: { date_userId: { date, userId: user.id } },
      create: { date, userId: user.id, guesses, solved, attempts },
      update: { guesses, solved, attempts },
    });

    let creditsAwarded = 0;
    if (solved && !wasSolved) {
      await prisma.creditTransaction.create({
        data: {
          userId: user.id,
          amount: DAILY_GUESS_REWARD,
          reason: 'daily_reward',
          refType: 'DailyGuess',
          refId: dailyGuess.id,
        },
      });
      creditsAwarded = DAILY_GUESS_REWARD;
    }

    res.status(200).json({ ok: true, solved, attempts, creditsAwarded });
  } catch (err) {
    console.error('fantasy/guesswho-sync (POST) error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}
