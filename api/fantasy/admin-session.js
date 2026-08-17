'use strict';

const { getPrisma } = require('../_lib/db');
const {
  verifySecret, hashSecret, signAdminSession, buildAdminSessionCookie, buildAdminClearCookie,
  getSessionAdmin, readJsonBody,
} = require('../_lib/fantasyAuth');

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

/* /api/fantasy/admin-session — the site-admin session lifecycle,
   merged into one file (was admin-login.js + admin-logout.js +
   admin-me.js) to stay under Vercel Hobby's 12-serverless-function
   cap. Dispatched by HTTP method; each branch below is otherwise
   byte-for-byte what its old standalone file did:

   GET    -> "am I logged in as admin" check (was admin-me.js)
   POST   -> sign-up-or-login for the SINGLE admin account, gated to
             whatever ADMIN_EMAIL is set to (was admin-login.js)
   DELETE -> logout (was admin-logout.js) */
module.exports = async function handler(req, res) {
  if (req.method === 'GET') return handleMe(req, res);
  if (req.method === 'POST') return handleLogin(req, res);
  if (req.method === 'DELETE') return handleLogout(req, res);
  res.status(405).json({ ok: false, error: 'method_not_allowed' });
};

/* GET — always 200. { admin: null } means "not logged in as admin," a
   normal state, not an error. */
async function handleMe(req, res) {
  try {
    const prisma = getPrisma();
    const admin = await getSessionAdmin(req, prisma);
    res.status(200).json({ ok: true, admin: admin ? { email: admin.email } : null });
  } catch (err) {
    console.error('fantasy/admin-session (GET) error:', err);
    res.status(200).json({ ok: true, admin: null });
  }
}

/* DELETE — clears the admin session cookie unconditionally. No auth
   required to call. */
function handleLogout(req, res) {
  res.setHeader('Set-Cookie', buildAdminClearCookie());
  res.status(200).json({ ok: true });
}

/* POST — Body: { email, password }
   - Email doesn't match ADMIN_EMAIL      -> 403 not_admin
   - Locked out                           -> 423 locked
   - No Admin row yet for this email      -> creates it with THIS
     password (the first successful login attempt with the right
     email IS the signup — no separate signup step), 200 + session
   - Admin row exists:
       - wrong password                   -> 401 invalid_password
       - right password                   -> 200 + session */
async function handleLogin(req, res) {
  try {
    const body = await readJsonBody(req);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      res.status(400).json({ ok: false, error: 'invalid_input', message: 'Email and password are required.' });
      return;
    }

    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (!adminEmail || email !== adminEmail) {
      res.status(403).json({ ok: false, error: 'not_admin', message: 'That email is not authorized for admin access.' });
      return;
    }

    const prisma = getPrisma();
    let admin = await prisma.admin.findUnique({ where: { email } });

    if (admin?.lockedUntil && admin.lockedUntil > new Date()) {
      res.status(423).json({ ok: false, error: 'locked', message: 'Too many attempts — try again in a few minutes.' });
      return;
    }

    async function succeed(adminRow, extraData) {
      const updated = await prisma.admin.update({
        where: { id: adminRow.id },
        data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), ...extraData },
      });
      const token = signAdminSession(updated.id);
      res.setHeader('Set-Cookie', buildAdminSessionCookie(token));
      res.status(200).json({ ok: true, admin: { email: updated.email } });
    }

    // No account yet for this (already-verified-authorized) email —
    // this attempt's password becomes the permanent one.
    if (!admin) {
      const passwordHash = await hashSecret(password);
      admin = await prisma.admin.create({ data: { email, passwordHash } });
      await succeed(admin, {});
      return;
    }

    // Defensive: shouldn't normally happen since create() above always
    // sets a password, but handle a null passwordHash the same way.
    if (!admin.passwordHash) {
      const passwordHash = await hashSecret(password);
      await succeed(admin, { passwordHash });
      return;
    }

    const validPassword = await verifySecret(password, admin.passwordHash);
    if (!validPassword) {
      const attempts = admin.failedLoginAttempts + 1;
      const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
      await prisma.admin.update({
        where: { id: admin.id },
        data: {
          failedLoginAttempts: shouldLock ? 0 : attempts,
          lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : admin.lockedUntil,
        },
      });
      res.status(401).json({ ok: false, error: 'invalid_password' });
      return;
    }

    await succeed(admin, {});
  } catch (err) {
    console.error('fantasy/admin-session (POST) error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}
