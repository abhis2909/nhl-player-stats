'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionAdmin, readJsonBody } = require('../_lib/fantasyAuth');

/* POST /api/fantasy/admin-create-user — admin-only. The browser
   equivalent of fantasy-hub/scripts/create-user.js (same two actions,
   same underlying Prisma calls) — issuing a username here is exactly
   as good as running the CLI script; either path works interchangeably.
   Body: { username, action?: 'create' | 'reset' } (default 'create')

   - create: makes a new User row with passwordHash null — the
     league member sets their own password + name on first login.
     409 username_taken if it already exists.
   - reset: clears an existing user's password + lockout — their next
     login will ask them to set a new password + name again, same as
     the CLI's `--reset`. 404 unknown_username if it doesn't exist. */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
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

    const body = await readJsonBody(req);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const action = body.action === 'reset' ? 'reset' : 'create';
    if (!username) {
      res.status(400).json({ ok: false, error: 'invalid_input', message: 'Username is required.' });
      return;
    }

    if (action === 'reset') {
      try {
        const user = await prisma.user.update({
          where: { username },
          data: { passwordHash: null, failedLoginAttempts: 0, lockedUntil: null },
        });
        res.status(200).json({ ok: true, user: { username: user.username } });
      } catch (err) {
        if (err.code === 'P2025') {
          res.status(404).json({ ok: false, error: 'unknown_username', message: 'No account with that username.' });
          return;
        }
        throw err;
      }
      return;
    }

    try {
      const user = await prisma.user.create({ data: { username } });
      res.status(200).json({ ok: true, user: { username: user.username } });
    } catch (err) {
      if (err.code === 'P2002') {
        res.status(409).json({ ok: false, error: 'username_taken', message: 'That username is already in use.' });
        return;
      }
      throw err;
    }
  } catch (err) {
    console.error('fantasy/admin-create-user error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
