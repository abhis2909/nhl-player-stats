'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionUser, readJsonBody } = require('../_lib/fantasyAuth');
const { pickMysteryPlayer, loadServerPlayerBioPool } = require('../_lib/guessWhoPool');

const MAX_GUESSES = 8;

// Cheap same-invocation-lifetime cache — the roster pool doesn't change
// meaningfully within a warm function instance's life, and this avoids
// 32 roster fetches on every single guess sync.
let cachedPool = null;
async function getPoolCached() {
  if (cachedPool) return cachedPool;
  cachedPool = await loadServerPlayerBioPool();
  return cachedPool;
}

/* POST /api/fantasy/guesswho-sync — session required.
   Body: { date: "YYYY-MM-DD", guesses: number[], gameOver, won }
   (gameOver/won accepted but NOT trusted — solved/attempts are always
   recomputed server-side from `guesses` vs. the frozen DailyPlayer.)

   Fire-and-forget from guesswho.js after every local guess. Sends the
   FULL current guesses array each time (not a delta) and always upserts
   the DailyGuess row wholesale — trivially idempotent even if this
   fires more than once or arrives out of order. */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

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

    // Get-or-create the frozen mystery player for this date. First sync
    // of the day (from anyone) computes and freezes it; every request
    // after just reads the frozen row, guaranteeing every player (and
    // every anonymous client computing the same thing independently)
    // agrees on the same answer for a given date.
    let dailyPlayer = await prisma.dailyPlayer.findUnique({ where: { date } });
    if (!dailyPlayer) {
      const pool = await getPoolCached();
      const mystery = pickMysteryPlayer(pool, date);
      dailyPlayer = await prisma.dailyPlayer.upsert({
        where: { date },
        create: { date, nhlPlayerId: mystery.playerId, attributes: mystery },
        update: {}, // someone else's concurrent request may have beaten us to it — just read theirs
      });
    }

    const solved = guesses.includes(dailyPlayer.nhlPlayerId);
    const attempts = guesses.length;

    await prisma.dailyGuess.upsert({
      where: { date_userId: { date, userId: user.id } },
      create: { date, userId: user.id, guesses, solved, attempts },
      update: { guesses, solved, attempts },
    });

    res.status(200).json({ ok: true, solved, attempts });
  } catch (err) {
    console.error('fantasy/guesswho-sync error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
