# Fantasy Hub

**Status: Phase 1 in progress — accounts + linking "Guess the Player" to
accounts.** The data model lives at [`../prisma/schema.prisma`](../prisma/schema.prisma)
(moved there from this folder — Prisma's own convention, so every
`prisma` CLI command works with no `--schema` flag). This document is
the human-readable design doc; keep it in sync with the schema if either
one changes.

A shared-credits fantasy hub for the league: everyone starts each season
with a pool of play-money credits and spends/earns them across 5 games —
betting on matchups, 1-on-1 draft faceoffs, a daily player-guesser, an
immaculate-grid board, and collectible player packs. Unlike the rest of
this site (static pages, no accounts, per-visitor `localStorage`), this
needs real user accounts and a real database, since credits and
standings have to be shared and persistent across everyone in the league.

**Phase 1 scope** (this round): real accounts (username + password, see
below) and linking the already-live "Guess the Player" mini-game to
those accounts, so progress can sync server-side. The credits ledger and
the other 4 games are **not** built yet — "initially just track
progress, eventually introduce the credits" was the explicit call.

## The credits ledger (not active yet)

A user's balance is never stored as a number on their row — it's
`SUM(amount)` over their `CreditTransaction` rows (see the schema).
Every stake, payout, and reward is its own transaction, positive or
negative, tagged with a `reason` and an optional `refType`/`refId`
pointing back at whatever game action caused it. That gives a full audit
trail for free and means no game logic ever needs to read-modify-write a
"balance" field. The table exists from the first migration on; nothing
writes to it yet.

## The 5 games

1. **Betting** (`Bet`/`BetEntry`) — wager credits on a matchup winner, a
   stat-category winner, or an over/under line. Locks at matchup start.
   *Not built yet.*
2. **Draft faceoff** (`Faceoff`) — challenge another user head-to-head on
   a specific hard number (e.g. season fantasy points); winner takes the
   stake. *Not built yet.*
3. **Daily guesser** (`DailyPlayer`/`DailyGuess`) — **this is Phase 1.**
   Links the already-live `guesswho.html`/`guesswho.js` game to
   accounts. Anonymous play keeps working exactly as it does today
   (`localStorage`, no login required) — logging in additionally
   fire-and-forget syncs that day's progress server-side. See "How the
   daily guesser links to accounts" below for the exact mechanism.
4. **Immaculate grid** (`GridBoard`/`GridEntry`) — a 3×3 board of
   row/column constraints (team, nationality, stat milestone, etc.);
   guess a player satisfying both for each cell. *Not built yet.*
5. **Player packs** (`Card`/`Pack`/`UserCard`/`PackOpening`) — spend
   credits to open a pack of randomized player cards by rarity. *Not
   built yet.*

Plus `YahooMatchupCache` — **deferred indefinitely**, not part of any
current phase. The schema keeps the table and `User.yahooTeamKey` for
when it's picked back up, but no OAuth app is registered and no token
handling exists.

## Accounts: the "claim your account" flow

Usernames are **assigned by the commissioner**, passwords are **chosen
by the league member themselves**:

1. The commissioner runs `node fantasy-hub/scripts/create-user.js
   <username> [displayName]` locally. This creates a `User` row with
   that username and a freshly generated **one-time claim code**
   (printed to the console — the only place it's ever shown in
   plaintext), `passwordHash` left `null`.
2. The commissioner hands the username + claim code to that person,
   out-of-band (text, Discord, whatever).
3. That person visits the site, enters the username + password they
   want. Since the account is unclaimed, the login form asks for the
   claim code too (see the API contract below) — entering it correctly
   sets their password and clears the claim code (single-use). From then
   on it's a normal username + password login.

The claim code exists specifically so a stranger can't squat a username
before its real owner claims it — knowing the username alone isn't
enough. `--reset <username>` on the same script (nulls the password,
issues a fresh claim code, clears any lockout) is the account-recovery
path — no email/forgot-password flow needed since the commissioner
already has an out-of-band channel to every member.

Auth mechanics: passwords and claim codes are hashed with Node's
built-in `crypto.scrypt` (no new dependency); sessions are a stateless
HMAC-signed cookie (`SESSION_SECRET` env var), not a DB-backed session
table — accepted trade-off (no instant server-side revocation) given
there's nothing credit-bearing at stake yet.

## How the daily guesser links to accounts

The tricky part: `guesswho.js`'s mystery-player pick is a **pure,
deterministic function of the browser's local calendar date**
(`pickMysteryPlayer(pool, dateKey)` — djb2-hash the date string, mod the
pool size, pool sorted by `playerId`). The server must NOT compute its
own idea of "today" (e.g. from UTC) — it would disagree with clients
right at midnight. Instead, `api/fantasy/guesswho-sync.js` is a pure
function of whatever `date` string the CLIENT sends, and
`api/_lib/guessWhoPool.js` replicates `guesswho.js`'s exact algorithm
byte-for-byte (same hash, same sort, same
`p.birthDate && p.heightInInches` pool filter) — so anonymous and
logged-in players always see the identical daily answer. `DailyPlayer`
is get-or-create per date (first sync of the day for that date freezes
it; everyone after just reads the frozen row). `DailyGuess.guesses` is
replaced wholesale on every sync (not appended), which makes the
fire-and-forget sync call trivially safe to fire more than once.

## Decisions made so far

- **Lives in this repo** — backend code in `api/fantasy/*.js` (Vercel
  serverless functions, same zero-framework style as the existing
  `api/*-proxy.js`), schema in `prisma/schema.prisma`, this folder for
  docs + the commissioner CLI script.
- **Postgres via [Neon](https://neon.tech)** — a Neon MCP connector is
  available in this environment but **not yet authorized**. Everything
  that doesn't need a live database (schema, `prisma generate`, all the
  `_lib` auth/hashing logic, the login UI) can be built and tested now;
  actual migrations and DB reads/writes are blocked until Neon is
  connected.
- **Yahoo OAuth**: deferred entirely, not part of any current phase.
- **Auth**: username (commissioner-assigned) + password (self-chosen),
  claim-code-gated — see above. Not magic-link, not Yahoo-linked.
- **Existing "Guess the Player" game**: coexists with the new
  account-linked version — anonymous `localStorage` play stays exactly
  as-is, login adds synced progress on top. Not a replacement.

## ⚠️ Do not wire `prisma migrate deploy` into the Vercel build yet

The site currently deploys with **no build step at all**. `"postinstall":
"prisma generate"` IS already wired into `package.json` — confirmed
empirically safe to run with zero `DATABASE_URL` set anywhere (`prisma
generate` only validates the schema shape, it never needs to resolve or
reach the datasource at generate time; tested by removing `.env`
entirely and running it clean). `@prisma/client`'s own install process
also runs a postinstall of its own regardless, so this isn't optional
in practice anyway.

`prisma migrate deploy` is a **different story** — it actually connects
and applies migrations, so it needs a real, working `DATABASE_URL`. If
that gets added as a Vercel build step before `DATABASE_URL` points at
a real, migrated Neon database, **every deployment breaks, including
the live static site**. Land and verify everything locally first
(`prisma migrate dev` against a real Neon dev branch), confirm `prisma
migrate deploy` succeeds by hand, set the real env vars in Vercel, and
only then add it as a build step.

**Note on Prisma major version**: pinned to Prisma **6.x**
(`^6.19.3`), not the newer 7.x that npm resolves to by default as of
this writing. Prisma 7 removed the classic
`url = env("DATABASE_URL")` datasource syntax this schema uses,
requiring a new `prisma.config.ts` file instead — a very recent,
less-documented change. 6.x is what every current Vercel+Prisma+Neon
guide assumes and is what this schema is written against; revisit the
pin deliberately later if there's a reason to.

## Files

| File | Purpose |
|---|---|
| `../prisma/schema.prisma` | The Prisma data model (moved out of this folder — see top of this doc) |
| `scripts/create-user.js` | Commissioner's local CLI — creates a username + one-time claim code |
| `../api/fantasy/*.js` | Vercel serverless functions — login, logout, session check, Guess the Player sync |
| `../api/_lib/db.js` | Cached Prisma client (Neon adapter) |
| `../api/_lib/fantasyAuth.js` | Password/claim-code hashing, session sign/verify, cookie helpers |
| `../api/_lib/guessWhoPool.js` | Server-side mirror of `guesswho.js`'s deterministic daily-pick algorithm |
| `../fantasy-auth.js` | Client-side login-UI module (currently wired into `guesswho.html` only) |

## Next steps (once Neon is authorized)

1. Set the real `DATABASE_URL` (Neon's **pooled** connection string) and
   a generated `SESSION_SECRET` in Vercel's project env vars, and
   locally in `.env` (already gitignored).
2. `npx prisma migrate dev --name init` against a Neon dev branch.
3. Run the commissioner CLI script for real to create the first account,
   claim it end-to-end, and confirm a `DailyGuess` row shows up after
   playing.
4. Only then, add `prisma migrate deploy` as a Vercel build step (see
   the warning above).
5. Later phases: the credits ledger + betting first (proves the pattern
   every other game reuses), then faceoffs / grid / packs, Yahoo sync
   picked up whenever it's actually wanted.
