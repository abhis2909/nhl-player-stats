'use strict';

/* ======================================================================
   Cached Prisma client (Neon serverless adapter) — reused across warm
   Vercel function invocations so a burst of concurrent requests doesn't
   each open a fresh Postgres connection and exhaust Neon's connection
   cap. Uses Prisma's Neon driver adapter (HTTP/WebSocket, not raw TCP),
   the standard pattern for Prisma-on-serverless with Neon. Requires
   Neon's POOLED connection string as DATABASE_URL (the "-pooler"
   variant) once that's set up — see fantasy-hub/README.md.
   ====================================================================== */

const { PrismaClient } = require('@prisma/client');
const { PrismaNeon } = require('@prisma/adapter-neon');

function getPrisma() {
  if (global.__fhPrisma) return global.__fhPrisma;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const adapter = new PrismaNeon({ connectionString });
  global.__fhPrisma = new PrismaClient({ adapter });
  return global.__fhPrisma;
}

module.exports = { getPrisma };
