'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionAdmin } = require('../_lib/fantasyAuth');

/* GET /api/fantasy/admin-users — admin-only list of every league-member
   account, for the Users sub-tab on admin.html. Requires an active
   admin session (same gate as everything else on that page) — this is
   account metadata (usernames, login activity), not for public/
   anonymous eyes. Never returns passwordHash itself, just a derived
   "setUp" boolean (whether the person has logged in and picked a
   password yet). */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  try {
    const prisma = getPrisma();
    const admin = await getSessionAdmin(req, prisma);
    if (!admin) {
      res.status(401).json({ ok: false, error: 'not_authenticated' });
      return;
    }

    const users = await prisma.user.findMany({
      orderBy: { username: 'asc' },
      select: {
        username: true,
        displayName: true,
        createdAt: true,
        lastLoginAt: true,
        lockedUntil: true,
        passwordHash: true,
      },
    });

    res.status(200).json({
      ok: true,
      users: users.map((u) => ({
        username: u.username,
        displayName: u.displayName,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        lockedUntil: u.lockedUntil,
        setUp: Boolean(u.passwordHash),
      })),
    });
  } catch (err) {
    console.error('fantasy/admin-users error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
