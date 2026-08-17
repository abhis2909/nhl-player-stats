# Fantasy Hub

**Status: design spec only — no working code yet.** `schema.prisma` in
this folder is the accepted data model; nothing else exists (no
`package.json`, no `prisma` install, no database, no pages). This
document is meant to be read before any of that gets built.

A shared-credits fantasy hub for the league: everyone starts each season
with a pool of play-money credits and spends/earns them across 5 games —
betting on matchups, 1-on-1 draft faceoffs, a daily player-guesser, an
immaculate-grid board, and collectible player packs. Unlike the rest of
this site (static pages, no accounts, per-visitor `localStorage`), this
needs real user accounts and a real database, since credits and
standings have to be shared and persistent across everyone in the league.

## The credits ledger

A user's balance is never stored as a number on their row — it's
`SUM(amount)` over their `CreditTransaction` rows (see `schema.prisma`).
Every stake, payout, and reward is its own transaction, positive or
negative, tagged with a `reason` and an optional `refType`/`refId`
pointing back at whatever game action caused it. That gives a full audit
trail for free and means no game logic ever needs to read-modify-write a
"balance" field — it just writes transactions and lets the ledger be the
single source of truth for all 5 games at once.

## The 5 games

1. **Betting** (`Bet`/`BetEntry`) — wager credits on a matchup winner, a
   stat-category winner, or an over/under line. Locks at matchup start.
2. **Draft faceoff** (`Faceoff`) — challenge another user head-to-head on
   a specific hard number (e.g. season fantasy points); winner takes the
   stake.
3. **Daily guesser** (`DailyPlayer`/`DailyGuess`) — a Poeltl-style daily
   player-guessing game, same idea as the site's existing
   `guesswho.html`/`guesswho.js` but backed by real accounts instead of
   `localStorage` (see Open Questions below — this needs a decision).
4. **Immaculate grid** (`GridBoard`/`GridEntry`) — a 3×3 board of
   row/column constraints (team, nationality, stat milestone, etc.);
   guess a player satisfying both for each cell.
5. **Player packs** (`Card`/`Pack`/`UserCard`/`PackOpening`) — spend
   credits to open a pack of randomized player cards by rarity; a
   purchase is just a `CreditTransaction` with reason `"pack_purchase"`,
   same ledger as everything else.

Plus `YahooMatchupCache`, populated by a scheduled job using **one**
commissioner-level Yahoo OAuth token (Yahoo's access model is
league-membership-based, so a single token can read the whole league —
no per-user Yahoo auth needed).

## Decisions made so far

- **Lives in this repo**, under this `fantasy-hub/` folder — not a
  separate project/repo.
- **Postgres via [Neon](https://neon.tech)** — a Neon MCP connector is
  already available in this environment but not yet authorized.

## Open questions (resolve before writing code)

- **User onboarding**: how does someone actually get a `User` row with a
  verified `yahooTeamKey`? Self-serve magic-link signup where they paste
  in their own team key, or a commissioner-seeded list up front?
- **Yahoo OAuth mechanics**: registering an app in Yahoo's developer
  console, where the commissioner's token + refresh token get stored
  (Vercel env vars?) and rotated (a scheduled job — Vercel Cron?).
- **Hosting shape for the backend**: Vercel serverless functions, in the
  same zero-framework style as the site's existing `api/*-proxy.js`
  (using Prisma's Neon-serverless/HTTP driver so a burst of concurrent
  function invocations doesn't exhaust Postgres connections), or a real
  framework (e.g. Next.js) scoped to just this subfolder?
- **Front-end architecture**: every page shipped on this site so far is
  a static HTML file + vanilla JS + `localStorage`, with no login. This
  needs real sessions/auth across 5 interconnected games — does it stay
  in that same style, or is this the point where a framework makes more
  sense?
- **Migration workflow**: `prisma migrate dev` locally against a Neon
  branch, `prisma migrate deploy` in the Vercel build step; Neon
  supports per-branch databases, which pairs well with preview deploys.
- **Relationship to the existing "Guess the Player" mini-game**
  (`guesswho.html`/`guesswho.js`, already live) — its game logic is
  almost exactly `DailyPlayer`/`DailyGuess` reimplemented client-side
  with no accounts. Does the DB-backed version here **replace** it, or
  do both coexist (anonymous local play for anyone, plus an
  authenticated "official" leaderboard version for league members)?
- **Build order**: given the scope, a sensible first slice is `User` +
  `CreditTransaction` + `YahooMatchupCache` + `Bet`/`BetEntry` — that
  proves out the ledger pattern every other game then reuses, before
  building the other 4 games on top of it.
- **Framing**: confirming this is a private-league play-money credits
  system for friends, not real-money gambling — not a legal ruling, just
  worth being explicit about before building betting mechanics.

## Files

| File | Purpose |
|---|---|
| `schema.prisma` | The accepted Prisma data model — datasource, generator, and all 12 models described above |

## Next steps (once the open questions above are answered)

Not done yet — recorded here as the expected sequence when this moves
from spec to implementation:

1. `npm init` inside `fantasy-hub/` + install `prisma` and
   `@prisma/client`.
2. Connect a Neon project (via the MCP connector, once authorized) and
   set `DATABASE_URL`.
3. `npx prisma migrate dev --name init` to create the first migration
   from this schema.
4. Add `.env`/`.env.local` handling (already excluded in the root
   `.gitignore`) and a Vercel env var for `DATABASE_URL` in production.
5. Build the first vertical slice (see "Build order" above) end-to-end
   — schema → API route(s) → a real page — before starting the other 4
   games.
