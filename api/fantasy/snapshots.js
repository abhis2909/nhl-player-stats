'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionAdmin } = require('../_lib/fantasyAuth');
const { fetchCurrentSeasonSnapshot } = require('../_lib/snapshotFetch');
const { getOrFreezeDailyPlayer } = require('../_lib/guessWhoPool');

const MAX_SNAPSHOTS_RETURNED = 120; // ~4 months of daily snapshots — more than a full season needs

function todayISO() {
  // UTC, matching the cron's own clock — "which day is this" for a
  // server-side snapshot doesn't have the browser-local-date subtlety
  // guesswho.js's daily puzzle has to worry about (see
  // api/_lib/guessWhoPool.js's header comment); a snapshot just needs
  // ONE consistent date per real day, not agreement with any specific
  // visitor's calendar.
  return new Date().toISOString().slice(0, 10);
}

async function upsertTodaySnapshot(prisma, source) {
  const data = await fetchCurrentSeasonSnapshot(); // api/_lib/snapshotFetch.js
  const date = todayISO();
  return prisma.statsSnapshot.upsert({
    where: { date },
    create: { date, seasonId: data.seasonId, data, source },
    update: { seasonId: data.seasonId, data, source },
  });
}

/** Proactively freezes today's guesswho.js roster/bio pool + mystery
 *  pick (api/_lib/guessWhoPool.js) alongside the season-stats snapshot
 *  above — same daily cron run, same "fetch once, everyone reads the
 *  stored copy" idea, just two separate stores (StatsSnapshot vs.
 *  DailyPlayer) since they hold genuinely different NHL API data (stat
 *  totals vs. roster/bio) that different pages need — see this
 *  session's chat for why merging them into one blob was considered
 *  and rejected (would bloat the season-stats payload, which already
 *  syncs to every page via snapshots.js, with bio fields ~99% of
 *  visitors never touch). Best-effort: uses UTC "today", which won't
 *  always match a given visitor's browser-local date (guesswho.js's
 *  known, accepted trade-off) — getOrFreezeDailyPlayer() in
 *  guesswho-sync.js's own GET/POST still falls back to freezing
 *  on-demand for whatever date a visitor's browser actually asks for.
 *  Failure here is swallowed (logged, not thrown) so a bad NHL API day
 *  for ROSTER data doesn't take down the STATS snapshot cron run. */
async function freezeTodaysGuessWhoPool(prisma) {
  try {
    await getOrFreezeDailyPlayer(prisma, todayISO());
  } catch (err) {
    console.error('fantasy/snapshots: guesswho pool pre-freeze failed (non-fatal):', err.message);
  }
}

/* /api/fantasy/snapshots — the database-backed replacement for what
   used to be a purely-manual, per-browser localStorage snapshot (see
   snapshots.js's syncServerSnapshots(), which pulls this down into the
   same localStorage shape every other snapshot consumer already reads
   from, so nothing else had to change to benefit from this).

   GET, no auth        -> just returns saved snapshots (most recent
                           MAX_SNAPSHOTS_RETURNED), for the client sync.
   GET ?date=YYYY-MM-DD, no auth -> lightweight existence check for ONE
                           date ({ ok, exists }), select:{date:true} only
                           — never pulls that date's full stats blob.
                           Fantasy Hub's Team of the Week box badge uses
                           this to check "did today's snapshot land yet"
                           without downloading everyone's season stats
                           just to show a NEW pill.
   GET, cron-authenticated (Authorization: Bearer $CRON_SECRET — Vercel
   auto-attaches this to its own cron invocations, see vercel.json's
   crons entry) -> ALSO fetches + upserts today's snapshot first
                   (source "cron"), then returns the list. Cron always
                   sends a plain GET, so triggering-on-authenticated-GET
                   is the standard shape for a Vercel-cron-driven write,
                   not a REST wart. ALSO proactively freezes today's
                   guesswho.js roster pool (freezeTodaysGuessWhoPool()) —
                   same daily run, a second store (DailyPlayer, not
                   StatsSnapshot — see that function's doc comment for
                   why they're kept separate), best-effort/non-fatal.
   POST, admin-gated    -> same fetch + upsert (source "admin") — the
                           manual "Retrieve Latest Stats" button under
                           Admin -> Range Ratings. Same upsert-by-date as
                           the cron path, so retrieving mid-day updates
                           today's row rather than duplicating it. Also
                           re-attempts the guesswho pool freeze, same as
                           the cron path — the admin's manual retry path
                           if that ever needs a nudge. */
module.exports = async function handler(req, res) {
  try {
    const prisma = getPrisma();

    if (req.method === 'GET') {
      const dateParam = typeof req.query?.date === 'string' ? req.query.date.trim() : '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        const row = await prisma.statsSnapshot.findUnique({ where: { date: dateParam }, select: { date: true } });
        res.status(200).json({ ok: true, exists: Boolean(row) });
        return;
      }

      const cronSecret = process.env.CRON_SECRET;
      const authHeader = req.headers.authorization || '';
      const isCronCall = cronSecret && authHeader === `Bearer ${cronSecret}`;

      if (isCronCall) {
        await upsertTodaySnapshot(prisma, 'cron');
        await freezeTodaysGuessWhoPool(prisma);
      }

      const rows = await prisma.statsSnapshot.findMany({
        orderBy: { date: 'desc' },
        take: MAX_SNAPSHOTS_RETURNED,
      });
      res.status(200).json({ ok: true, snapshots: rows });
      return;
    }

    if (req.method === 'POST') {
      const admin = await getSessionAdmin(req, prisma);
      if (!admin) {
        res.status(401).json({ ok: false, error: 'not_authenticated' });
        return;
      }
      const row = await upsertTodaySnapshot(prisma, 'admin');
      await freezeTodaysGuessWhoPool(prisma);
      res.status(200).json({ ok: true, snapshot: row });
      return;
    }

    res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (err) {
    console.error('fantasy/snapshots error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
