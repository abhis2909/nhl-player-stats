'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionUser } = require('../_lib/fantasyAuth');

/* GET /api/fantasy/me — always 200. { user: null } means "logged out,"
   a normal state, not an error. Drives the login-UI's initial render. */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  try {
    const prisma = getPrisma();
    const user = await getSessionUser(req, prisma);
    res.status(200).json({
      ok: true,
      user: user ? { username: user.username, displayName: user.displayName || user.username } : null,
    });
  } catch (err) {
    // Fail open to "logged out" rather than error the page — this is
    // just a UI-state check, not a security gate (guesswho-sync.js
    // separately re-validates the session and fails closed there).
    console.error('fantasy/me error:', err);
    res.status(200).json({ ok: true, user: null });
  }
};
