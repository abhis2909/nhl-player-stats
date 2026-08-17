'use strict';

/* ======================================================================
   Fantasy Hub — auth toolkit shared by every api/fantasy/*.js endpoint
   AND fantasy-hub/scripts/create-user.js (the commissioner's CLI) —
   single source of truth for the hash format, so a password/claim-code
   hashed by the CLI script verifies correctly against a login request,
   and vice versa.

   - Passwords + claim codes: Node's built-in crypto.scrypt (no new
     dependency, no native-module bundling risk on Vercel), stored as a
     self-describing string so the format is versionable later without
     a migration: "scrypt:N:r:p:<saltHex>:<hashHex>".
   - Sessions: a stateless HMAC-SHA256-signed cookie, NOT a DB-backed
     session table — {uid, iat, exp} signed with SESSION_SECRET.
     Trade-off: no instant server-side revocation (a stolen/leaked
     cookie is valid until it expires), accepted for now since nothing
     credit-bearing is at stake yet — revisit with a real Session table
     if that ever changes. See fantasy-hub/README.md.
   ====================================================================== */

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const SCRYPT_N = 16384; // 2^14 — scrypt cost parameter, ~16.7MB memory per hash at r=8
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

const SESSION_COOKIE_NAME = 'fh_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return secret;
}

/** Hashes a password or claim code. Returns a self-describing string —
 *  never store the plaintext. */
async function hashSecret(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(plain, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Verifies a plaintext password/claim code against a stored hash from
 *  hashSecret(). Returns false (never throws) for a malformed/missing
 *  stored value, so callers can always just check the boolean. */
async function verifySecret(plain, stored) {
  if (!plain || !stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(plain, salt, expected.length, { N, r, p });
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/** Signs a session token for `uid`, valid for SESSION_MAX_AGE_SECONDS. */
function signSession(uid) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { uid, iat: now, exp: now + SESSION_MAX_AGE_SECONDS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/** Verifies + decodes a session token. Returns { uid } or null (never
 *  throws) — expired/tampered/malformed tokens all just fail closed. */
function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', sessionSecret()).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now || !payload.uid) return null;
  return { uid: payload.uid };
}

/** Parses the Cookie header into a plain object. */
function parseCookies(req) {
  const header = req.headers?.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function buildSessionCookie(token) {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function buildClearCookie() {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Reads the session cookie (if any), verifies it, and loads the
 *  matching User row via Prisma. Returns the User or null — never
 *  throws, so route handlers can always just check truthiness. */
async function getSessionUser(req, prisma) {
  const cookies = parseCookies(req);
  const session = verifySessionToken(cookies[SESSION_COOKIE_NAME]);
  if (!session) return null;
  try {
    return await prisma.user.findUnique({ where: { id: session.uid } });
  } catch {
    return null;
  }
}

/** Reads + parses a JSON request body. Vercel's Node runtime usually
 *  already parses `req.body` for JSON content-types, but this falls
 *  back to reading the raw stream if it hasn't, so this works
 *  regardless of exactly how the runtime's body-parsing behaves. */
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

module.exports = {
  hashSecret,
  verifySecret,
  signSession,
  verifySessionToken,
  parseCookies,
  buildSessionCookie,
  buildClearCookie,
  getSessionUser,
  readJsonBody,
  SESSION_COOKIE_NAME,
};
