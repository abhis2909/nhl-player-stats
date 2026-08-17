'use strict';

const { buildAdminClearCookie } = require('../_lib/fantasyAuth');

/* POST /api/fantasy/admin-logout — clears the admin session cookie
   unconditionally. No auth required to call. */
module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  res.setHeader('Set-Cookie', buildAdminClearCookie());
  res.status(200).json({ ok: true });
};
