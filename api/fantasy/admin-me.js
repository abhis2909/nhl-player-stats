'use strict';

const { getPrisma } = require('../_lib/db');
const { getSessionAdmin } = require('../_lib/fantasyAuth');

/* GET /api/fantasy/admin-me — always 200. { admin: null } means "not
   logged in as admin," a normal state, not an error. */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  try {
    const prisma = getPrisma();
    const admin = await getSessionAdmin(req, prisma);
    res.status(200).json({ ok: true, admin: admin ? { email: admin.email } : null });
  } catch (err) {
    console.error('fantasy/admin-me error:', err);
    res.status(200).json({ ok: true, admin: null });
  }
};
