'use strict';

/* ======================================================================
   Commissioner's local CLI — creates a new Fantasy Hub account (or
   resets one). Usage:

     npm run create-user -- <username> [displayName]
     npm run create-user -- --reset <username>

   (or directly: node --env-file=.env fantasy-hub/scripts/create-user.js ...)

   Prints the one-time claim code to hand to that person out-of-band
   (text, Discord, whatever) — this is the ONLY place it's ever shown in
   plaintext, and it's never logged or stored anywhere except as a hash.
   Requires a real DATABASE_URL (Neon) in .env — see
   fantasy-hub/README.md.
   ====================================================================== */

const crypto = require('crypto');
const { getPrisma } = require('../../api/_lib/db');
const { hashSecret } = require('../../api/_lib/fantasyAuth');

// 8 uppercase alphanumeric chars, human-typeable — excludes visually
// ambiguous characters (0/O, 1/I/L).
const CLAIM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CLAIM_CODE_LENGTH = 8;

function generateClaimCode() {
  const bytes = crypto.randomBytes(CLAIM_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CLAIM_CODE_LENGTH; i++) {
    code += CLAIM_CODE_ALPHABET[bytes[i] % CLAIM_CODE_ALPHABET.length];
  }
  return code;
}

async function createUser(username, displayName) {
  const prisma = getPrisma();
  const claimCode = generateClaimCode();
  const claimCodeHash = await hashSecret(claimCode);

  const user = await prisma.user.create({
    data: { username, displayName: displayName || null, claimCodeHash },
  });

  console.log('\nAccount created:');
  console.log(`  Username:   ${user.username}`);
  console.log(`  Claim code: ${claimCode}`);
  console.log('\nHand BOTH of these to the league member out-of-band (text, Discord, etc).');
  console.log('This claim code will not be shown again — if it’s lost, run:');
  console.log(`  npm run create-user -- --reset ${user.username}\n`);
}

async function resetUser(username) {
  const prisma = getPrisma();
  const claimCode = generateClaimCode();
  const claimCodeHash = await hashSecret(claimCode);

  const user = await prisma.user.update({
    where: { username },
    data: {
      passwordHash: null,
      claimCodeHash,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  console.log('\nAccount reset:');
  console.log(`  Username:       ${user.username}`);
  console.log(`  New claim code: ${claimCode}`);
  console.log('\nHand this to the league member out-of-band — their old password no longer works.\n');
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--reset') {
    const username = args[1];
    if (!username) {
      console.error('Usage: npm run create-user -- --reset <username>');
      process.exitCode = 1;
      return;
    }
    await resetUser(username);
    return;
  }

  const [username, displayName] = args;
  if (!username) {
    console.error('Usage: npm run create-user -- <username> [displayName]');
    process.exitCode = 1;
    return;
  }
  await createUser(username, displayName);
}

main()
  .catch((err) => {
    console.error('Error:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    // getPrisma() caches a shared client (fine for serverless reuse,
    // but this is a one-shot CLI process) — disconnect explicitly so
    // the script actually exits instead of hanging on an open handle.
    try { require('../../api/_lib/db').getPrisma().$disconnect(); } catch { /* already failed above */ }
  });
