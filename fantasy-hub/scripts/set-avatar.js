'use strict';

/* ======================================================================
   Commissioner's local CLI — assigns (or clears) a Fantasy Hub user's
   avatar image. Usage:

     npm run set-avatar -- <username> <url>
     npm run set-avatar -- --clear <username>

   (or directly: node --env-file=.env fantasy-hub/scripts/set-avatar.js ...)

   Avatars here are commissioner-managed, not a self-serve upload
   feature (no upload endpoint exists, and the site's already at
   Vercel Hobby's 12-function cap) — the workflow is: the site owner
   sends Claude a photo/PNG per manager in chat, Claude saves it under
   /avatars (served as a plain static file, same as any other image on
   the site) and runs this script to point that manager's account at
   it. Swappable any time during the season by just running it again
   with a new URL. <url> can be a site-relative path (e.g.
   "/avatars/username.png") or a full external URL — avatar.js's
   buildAvatarImg() just renders whatever string is stored as an <img
   src>, no validation of where it points to. Requires a real
   DATABASE_URL (Neon) in .env — see fantasy-hub/README.md. */

const { getPrisma } = require('../../api/_lib/db');

async function setAvatar(username, url) {
  const prisma = getPrisma();
  const user = await prisma.user.update({ where: { username }, data: { avatarUrl: url } });

  console.log('\nAvatar set:');
  console.log(`  Username:   ${user.username}`);
  console.log(`  Avatar URL: ${user.avatarUrl}\n`);
}

async function clearAvatar(username) {
  const prisma = getPrisma();
  const user = await prisma.user.update({ where: { username }, data: { avatarUrl: null } });

  console.log('\nAvatar cleared:');
  console.log(`  Username: ${user.username}`);
  console.log('  Renders as the placeholder silhouette until a new one is set.\n');
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--clear') {
    const username = args[1];
    if (!username) {
      console.error('Usage: npm run set-avatar -- --clear <username>');
      process.exitCode = 1;
      return;
    }
    await clearAvatar(username);
    return;
  }

  const [username, url] = args;
  if (!username || !url) {
    console.error('Usage: npm run set-avatar -- <username> <url>');
    process.exitCode = 1;
    return;
  }
  await setAvatar(username, url);
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
