'use strict';

const { getPrisma } = require('../_lib/db');
const {
  verifySecret, hashSecret, signSession, buildSessionCookie, buildClearCookie,
  getSessionUser, readJsonBody,
} = require('../_lib/fantasyAuth');

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

/* /api/fantasy/session — the league-member session lifecycle, merged
   into one file (was login.js + logout.js + me.js) to stay under
   Vercel Hobby's 12-serverless-function cap. Dispatched by HTTP
   method; each branch below is otherwise byte-for-byte what its old
   standalone file did:

   GET    -> "am I logged in" check (was me.js)
   POST   -> unified first-time-setup-or-login (was login.js)
   DELETE -> logout (was logout.js) */
module.exports = async function handler(req, res) {
  if (req.method === 'GET') return handleMe(req, res);
  if (req.method === 'POST') return handleLogin(req, res);
  if (req.method === 'DELETE') return handleLogout(req, res);
  res.status(405).json({ ok: false, error: 'method_not_allowed' });
};

/* GET — always 200. { user: null } means "logged out," a normal
   state, not an error. Drives the login-UI's initial render. */
async function handleMe(req, res) {
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
    console.error('fantasy/session (GET) error:', err);
    res.status(200).json({ ok: true, user: null });
  }
}

/* DELETE — clears the session cookie unconditionally. No auth
   required to call (calling it while already logged out is a
   harmless no-op). */
function handleLogout(req, res) {
  res.setHeader('Set-Cookie', buildClearCookie());
  res.status(200).json({ ok: true });
}

/* POST — unified first-time-setup-or-login.
   Body: { username, password, displayName? }

   - Unknown username                          -> 404 unknown_username
   - Locked out (too many recent failures)     -> 423 locked
   - Not set up yet (passwordHash is null):
       - no displayName sent                   -> 409 needs_name
         (lets the UI progressively reveal a "your name" field — normal
         logins to already-set-up accounts never see it)
       - displayName sent                      -> sets passwordHash to
         this request's password + displayName, 200 + session
   - Already set up (passwordHash set):
       - wrong password                        -> 401 invalid_password
       - right password                        -> 200 + session */
async function handleLogin(req, res) {
  try {
    const body = await readJsonBody(req);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';

    if (!username || !password) {
      res.status(400).json({ ok: false, error: 'invalid_input', message: 'Username and password are required.' });
      return;
    }

    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { username } });

    if (!user) {
      res.status(404).json({ ok: false, error: 'unknown_username', message: 'No account with that username — ask your commissioner for one.' });
      return;
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      res.status(423).json({ ok: false, error: 'locked', message: 'Too many attempts — try again in a few minutes.' });
      return;
    }

    async function recordFailure() {
      const attempts = user.failedLoginAttempts + 1;
      const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: shouldLock ? 0 : attempts,
          lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : user.lockedUntil,
        },
      });
    }

    async function succeed(extraData) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), ...extraData },
      });
      const token = signSession(user.id);
      res.setHeader('Set-Cookie', buildSessionCookie(token));
      res.status(200).json({
        ok: true,
        user: { username: user.username, displayName: user.displayName || user.username },
      });
    }

    // Not set up yet: passwordHash is null.
    if (!user.passwordHash) {
      if (!displayName) {
        res.status(409).json({
          ok: false,
          error: 'needs_name',
          message: "Looks like this is your first time — what's your name?",
        });
        return;
      }
      const passwordHash = await hashSecret(password);
      await succeed({ passwordHash, displayName });
      return;
    }

    // Already set up: normal password login.
    const validPassword = await verifySecret(password, user.passwordHash);
    if (!validPassword) {
      await recordFailure();
      res.status(401).json({ ok: false, error: 'invalid_password' });
      return;
    }
    await succeed({});
  } catch (err) {
    console.error('fantasy/session (POST) error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}
