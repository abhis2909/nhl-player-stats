'use strict';

/* ======================================================================
   Commissioner's local CLI — creates a new Fantasy Hub account (or
   resets one). Usage:

     npm run create-user -- <username>
     npm run create-user -- --reset <username>

   (or directly: node --env-file=.env fantasy-hub/scripts/create-user.js ...)

   Hand the username to the league member out-of-band (text, Discord,
   whatever). The first time they log in with it, they'll be asked to
   choose a password and enter their own name — that's what actually
   "claims" the account, no code needed from you. Requires a real
   DATABASE_URL (Neon) in .env — see fantasy-hub/README.md.
   ====================================================================== */

const { getPrisma } = require('../../api/_lib/db');

async function createUser(username) {
  const prisma = getPrisma();
  const user = await prisma.user.create({ data: { username } });

  console.log('\nAccount created:');
  console.log(`  Username: ${user.username}`);
  console.log('\nHand this to the league member out-of-band (text, Discord, etc).');
  console.log("They'll choose their own password and name the first time they log in.\n");
}

async function resetUser(username) {
  const prisma = getPrisma();
  const user = await prisma.user.update({
    where: { username },
    data: {
      passwordHash: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  console.log('\nAccount reset:');
  console.log(`  Username: ${user.username}`);
  console.log('\nTheir old password no longer works — next login will ask them to set a new one.\n');
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

  const [username] = args;
  if (!username) {
    console.error('Usage: npm run create-user -- <username>');
    process.exitCode = 1;
    return;
  }
  await createUser(username);
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
