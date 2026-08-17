'use strict';

const { buildClearCookie } = require('../_lib/fantasyAuth');

/* POST /api/fantasy/logout — clears the session cookie unconditionally.
   No auth required to call (calling it while already logged out is a
   harmless no-op). */
module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  res.setHeader('Set-Cookie', buildClearCookie());
  res.status(200).json({ ok: true });
};
