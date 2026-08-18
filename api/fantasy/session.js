'use strict';

const { getPrisma } = require('../_lib/db');
const {
  verifySecret, hashSecret, signSession, buildSessionCookie, buildClearCookie,
  getSessionUser, readJsonBody,
} = require('../_lib/fantasyAuth');

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

// Sanity cap on a submitted avatar request's data: URI — well under
// Vercel's default ~4.5MB request-body limit, and fantasy-hub.js
// resizes/recompresses to a few hundred KB before ever sending one, so
// hitting this in normal use would mean something's gone wrong client-side.
const MAX_AVATAR_REQUEST_LENGTH = 2_000_000;

/* /api/fantasy/session — the league-member session lifecycle, merged
   into one file (was login.js + logout.js + me.js) to stay under
   Vercel Hobby's 12-serverless-function cap. Dispatched by HTTP
   method; each branch below is otherwise byte-for-byte what its old
   standalone file did:

   GET    -> "am I logged in" check (was me.js)
   POST   -> unified first-time-setup-or-login (was login.js)
   PATCH  -> submit an avatar change request (see handlePatch's doc
             comment) -- new, not part of the original 3-file merge
   DELETE -> logout (was logout.js) */
module.exports = async function handler(req, res) {
  if (req.method === 'GET') return handleMe(req, res);
  if (req.method === 'POST') return handleLogin(req, res);
  if (req.method === 'PATCH') return handlePatch(req, res);
  if (req.method === 'DELETE') return handleLogout(req, res);
  res.status(405).json({ ok: false, error: 'method_not_allowed' });
};

function toUserPayload(user) {
  return {
    username: user.username,
    displayName: user.displayName || user.username,
    // The CURRENT, admin-approved avatar (fantasy-hub/scripts/set-avatar.js
    // or an approved request below) — null renders as a placeholder
    // (avatar.js's buildAvatarImg()) until one's been assigned.
    avatarUrl: user.avatarUrl || null,
    // Whether this user has a pending, not-yet-reviewed avatar request
    // in flight — the client only needs to know THAT one exists (to show
    // "pending review"), never the request image/note itself over this
    // endpoint; those are for Admin -> Users only (admin-users.js).
    avatarRequestPending: Boolean(user.avatarRequestedAt),
  };
}

/* GET — always 200. { user: null } means "logged out," a normal
   state, not an error. Drives the login-UI's initial render. */
async function handleMe(req, res) {
  try {
    const prisma = getPrisma();
    const user = await getSessionUser(req, prisma);
    res.status(200).json({ ok: true, user: user ? toUserPayload(user) : null });
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

/* PATCH — session required. Body: { avatarRequestUrl, avatarRequestNote? }.
   Submits (or replaces) a pending avatar-change request — this does NOT
   touch avatarUrl itself, it only stages a request for the commissioner
   to review and approve/reject from Admin -> Users
   (api/fantasy/admin-users.js's POST). avatarRequestUrl is expected to
   be a data: URI (fantasy-hub.js resizes/compresses the picked file to
   one client-side before ever sending it) — there's no file-upload/CDN
   infra here, so the request image is just stored as text on the row
   until approved, at which point it's copied straight to avatarUrl
   (also just a string the <img> tag points at, data: URIs render fine
   as-is). Submitting again while a request is already pending simply
   replaces it (no queue, last request wins) — that's normal and
   expected, not an error. */
async function handlePatch(req, res) {
  try {
    const prisma = getPrisma();
    const user = await getSessionUser(req, prisma);
    if (!user) {
      res.status(401).json({ ok: false, error: 'unauthenticated' });
      return;
    }

    const body = await readJsonBody(req);
    const avatarRequestUrl = typeof body.avatarRequestUrl === 'string' ? body.avatarRequestUrl.trim() : '';
    const avatarRequestNote = typeof body.avatarRequestNote === 'string' ? body.avatarRequestNote.trim().slice(0, 500) : null;

    if (!avatarRequestUrl || !avatarRequestUrl.startsWith('data:image/')) {
      res.status(400).json({ ok: false, error: 'invalid_input', message: 'Pick an image to submit.' });
      return;
    }
    if (avatarRequestUrl.length > MAX_AVATAR_REQUEST_LENGTH) {
      res.status(400).json({ ok: false, error: 'invalid_input', message: 'That image is too large — try a smaller one.' });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { avatarRequestUrl, avatarRequestNote, avatarRequestedAt: new Date() },
    });
    res.status(200).json({ ok: true, user: toUserPayload(updated) });
  } catch (err) {
    console.error('fantasy/session (PATCH) error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
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
      res.status(200).json({ ok: true, user: toUserPayload({ ...user, ...extraData }) });
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
