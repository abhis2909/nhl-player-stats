'use strict';

const { getPrisma } = require('../_lib/db');
const { verifySecret, hashSecret, signSession, buildSessionCookie, readJsonBody } = require('../_lib/fantasyAuth');

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

/* POST /api/fantasy/login — unified claim-or-login.
   Body: { username, password, claimCode? }

   - Unknown username                          -> 404 unknown_username
   - Locked out (too many recent failures)     -> 423 locked
   - Unclaimed account (passwordHash is null):
       - no claimCode sent                     -> 409 needs_claim_code
         (lets the UI progressively reveal that field — normal logins
         to already-claimed accounts never see it)
       - wrong claimCode                       -> 401 invalid_claim_code
       - right claimCode                       -> sets passwordHash to
         this request's password (single-use claim), 200 + session
   - Claimed account (passwordHash set):
       - wrong password                        -> 401 invalid_password
       - right password                        -> 200 + session

   Every failure path increments failedLoginAttempts and locks the
   account for LOCKOUT_MINUTES past MAX_FAILED_ATTEMPTS — the only
   rate-limiting layer in front of this endpoint, so it has to live in
   the DB (an in-memory limiter is useless across serverless
   invocations, which may each be a different instance). */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const claimCode = typeof body.claimCode === 'string' ? body.claimCode.trim() : '';

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

    // Unclaimed account: passwordHash is null.
    if (!user.passwordHash) {
      if (!claimCode) {
        res.status(409).json({
          ok: false,
          error: 'needs_claim_code',
          message: "This account hasn't been claimed yet — enter the claim code your commissioner gave you.",
        });
        return;
      }
      const validCode = await verifySecret(claimCode, user.claimCodeHash);
      if (!validCode) {
        await recordFailure();
        res.status(401).json({ ok: false, error: 'invalid_claim_code' });
        return;
      }
      // Claim: set the password, clear the claim code (single-use).
      const passwordHash = await hashSecret(password);
      await succeed({ passwordHash, claimCodeHash: null });
      return;
    }

    // Claimed account: normal password login.
    const validPassword = await verifySecret(password, user.passwordHash);
    if (!validPassword) {
      await recordFailure();
      res.status(401).json({ ok: false, error: 'invalid_password' });
      return;
    }
    await succeed({});
  } catch (err) {
    console.error('fantasy/login error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
