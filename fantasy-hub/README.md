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

Plus the Yahoo Fantasy import (`YahooToken`, `YahooMatchupCache`,
`YahooStandingsCache`, `YahooRosterCache`, `YahooTransactionCache`,
`YahooDraftCache`) — **ACTIVE**, picked up ahead of everything else on
the list above. One commissioner-level OAuth connection (Yahoo's
access rules are based on league membership, so one token can read the
whole league — no per-user OAuth) pulls standings, current-week
matchups, every team's roster, transactions, and draft results into
those cache tables, once via a manual "Sync now" and automatically
every day via a Vercel cron. See "Yahoo Fantasy import" below for
setup and how it all fits together.

## Accounts: username assigned, everything else self-serve

Usernames are **assigned by the commissioner**; the password AND name
are set by the league member themselves, first time they log in — no
code to send:

1. The commissioner runs `node fantasy-hub/scripts/create-user.js
   <username>` locally. This creates a `User` row with just that
   username, `passwordHash` left `null`.
2. The commissioner hands the username to that person, out-of-band
   (text, Discord, whatever).
3. That person visits the site and enters the username + a password
   they choose. Since the account hasn't been set up yet, the login
   form also asks for their name (see the API contract below) —
   submitting that sets their password and name in one step. From then
   on it's a normal username + password login.

`--reset <username>` on the same script (nulls the password, clears any
lockout) is the account-recovery path — next login just asks them to
set a new password and name again, no email/forgot-password flow
needed since the commissioner already has an out-of-band channel to
every member.

**Trade-off, explicit**: since there's no separate secret gating
first-time setup, anyone who knows (or guesses) a username before its
real owner logs in could set its password themselves. Accepted for a
small private friend league where usernames aren't secret and nothing
credit-bearing is at stake yet — revisit (e.g. bring back a one-time
code) if that ever stops being true.

Auth mechanics: passwords are hashed with Node's built-in
`crypto.scrypt` (no new dependency); sessions are a stateless
HMAC-signed cookie (`SESSION_SECRET` env var), not a DB-backed session
table — accepted trade-off (no instant server-side revocation) given
there's nothing credit-bearing at stake yet.

## Site admin login (separate from league-member accounts)

A completely separate, single-account login for configuring the site
itself — gates `admin.html` (the stat-column picker), and is the
natural home for any future site-configuration controls. Deliberately
**not** the same thing as a `User` above: this is you, the site owner,
not a league member playing games, and being logged in as one has no
bearing on the other (separate DB table, separate session cookie).

- Gated to **one specific email**, set via the `ADMIN_EMAIL` env var —
  not a row anyone could create by guessing, since the login endpoint
  checks the submitted email against `ADMIN_EMAIL` before it ever
  touches the `Admin` table.
- **Self-serve, no separate signup step**: the first successful login
  attempt with the right email — whatever password you type — becomes
  the permanent password from then on. Every login after that is a
  normal email + password check.
- Same `crypto.scrypt` hashing and stateless-HMAC-cookie session
  approach as the league-member accounts (see `signAdminSession`/
  `getSessionAdmin` in `api/_lib/fantasyAuth.js`), just under its own
  `fh_admin_session` cookie and `Admin` table so the two logins can
  never be confused for one another.
- `admin.html` shows a login gate (`admin-auth.js`) until you're
  authenticated, then reveals the actual column-picker UI (unchanged —
  still `localStorage`-based, per-browser; the admin login controls WHO
  can reach that UI, not (yet) where the resulting config is stored).

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
- **Yahoo OAuth**: ACTIVE — see "Yahoo Fantasy import" below.
- **Auth**: username (commissioner-assigned) + password + name
  (self-chosen, set together on first login) — see above. Not
  magic-link, not Yahoo-linked, no separate code to hand over.
- **Existing "Guess the Player" game**: coexists with the new
  account-linked version — anonymous `localStorage` play stays exactly
  as-is, login adds synced progress on top. Not a replacement.

## Yahoo Fantasy import

One commissioner connects their own Yahoo login once (Admin → Yahoo
League → Connect to Yahoo); from then on, standings/matchups/rosters/
transactions/draft results for whichever league they pick show up on
`fantasy-hub.html`'s League panel for every visitor, no login required
on their end — Yahoo's access rules are based on league membership, so
one OAuth token can read the whole league.

**Setup, in order:**

1. **Register a Yahoo app** (if not done already) at
   [Yahoo's developer console](https://developer.yahoo.com/apps/) —
   needs Fantasy Sports read permission. Note the **Client ID
   (Consumer Key)** and **Client Secret (Consumer Secret)**.
2. **Set three env vars in Vercel** (Project → Settings → Environment
   Variables), and redeploy after adding them:
   - `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` — from step 1.
   - `YAHOO_REDIRECT_URI` — the exact callback URL, e.g.
     `https://<your-domain>/api/yahoo/callback`. Must be a fixed value
     (not derived from the request), since Yahoo requires an exact
     match and Vercel serves the same deployment from multiple
     hostnames.
   - `CRON_SECRET` — any random string; enables the daily auto-sync
     (Vercel injects it as a bearer token on cron-triggered requests
     automatically once it's set — see `vercel.json`'s `crons` entry
     and `handleYahooSync()`'s cron branch in `admin-settings.js`).
     Without it, the daily cron 401s harmlessly and only manual "Sync
     now" clicks work.
3. **Register that exact `YAHOO_REDIRECT_URI` value** as an allowed
   redirect URI in the Yahoo app's own settings too — both sides need
   to match exactly, or Yahoo rejects the callback.
4. **Run the migration** against the real database (`npx prisma
   migrate deploy`, or `migrate dev` in a dev environment) — adds
   `YahooToken` and the four `Yahoo*Cache` tables. Not wired into the
   Vercel build (see the warning below), so this is a manual, one-time
   step after setting `DATABASE_URL`.
5. **Admin → Yahoo League → Connect to Yahoo**, approve on Yahoo's
   consent screen, then **Find my leagues** → pick the right one →
   **Sync now**. The League panel appears on `fantasy-hub.html`
   automatically once there's cached data.

**How it fits together**: `api/_lib/yahoo.js` is the OAuth + Fantasy
API client (token exchange/refresh, `discoverLeagues()`,
`syncLeague()`); `api/fantasy/admin-settings.js`'s `yahoo-*` types are
the dispatch (folded in rather than a dedicated endpoint, same
Hobby-plan 12-function-cap reason as the jersey-image publish); the
public read is `api/fantasy/public-config.js?type=yahoo`; the display
is `league.js` on `fantasy-hub.html`; the admin control panel is
`admin-yahoo.js` (Admin → Yahoo League tab).

**A note on Yahoo's JSON shape**: Yahoo's Fantasy API is XML-first —
its `?format=json` output is a fairly direct transliteration, not a
clean REST shape (collections come back as `{"0":x,"1":y,"count":2}`
instead of a real array; one resource comes back as an array of
single-key fragments needing merging). `yArr()`/`yMerge()` in
`api/_lib/yahoo.js` (and their client-side equivalents in `league.js`)
are the generic helpers for navigating that, written against Yahoo's
documented/community-reverse-engineered format with no live account
available to test against while building this. Every cache table
stores the untouched original response (`rawData`) alongside whatever
got parsed out of it, so if a field turns out to live in a slightly
different spot than expected, fixing the parser never needs another
Yahoo round trip — just re-render from what's already cached.

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
| `scripts/create-user.js` | Commissioner's local CLI — creates a username (or resets one) |
| `../api/fantasy/*.js` | Vercel serverless functions — user login/logout/me, admin login/logout/me, Guess the Player sync |
| `../api/_lib/db.js` | Cached Prisma client (Neon adapter) |
| `../api/_lib/fantasyAuth.js` | Password hashing, session sign/verify (both User and Admin sessions), cookie helpers |
| `../api/_lib/guessWhoPool.js` | Server-side mirror of `guesswho.js`'s deterministic daily-pick algorithm |
| `../fantasy-auth.js` | Client-side league-member login-UI module (currently wired into `guesswho.html` only) |
| `../admin-auth.js` | Client-side site-admin login gate, wired into `admin.html` |
| `../api/_lib/yahoo.js` | Yahoo OAuth + Fantasy Sports API client (token exchange/refresh, league discovery, sync) |
| `../admin-yahoo.js` | Admin → Yahoo League tab — connect/pick league/sync-now control panel |
| `../league.js` | `fantasy-hub.html`'s League panel — renders the cached Yahoo data |

## Next steps (once Neon is authorized)

1. Set the real `DATABASE_URL` (Neon's **pooled** connection string), a
   generated `SESSION_SECRET`, and `ADMIN_EMAIL` (the one email allowed
   to log into `admin.html`) in Vercel's project env vars, and locally
   in `.env` (already gitignored).
2. `npx prisma migrate dev --name init` against a Neon dev branch.
3. Run the commissioner CLI script for real to create the first
   account, log in end-to-end (setting a password + name), and confirm
   a `DailyGuess` row shows up after playing.
4. Only then, add `prisma migrate deploy` as a Vercel build step (see
   the warning above).
5. Later phases: the credits ledger + betting first (proves the pattern
   every other game reuses), then faceoffs / grid / packs, Yahoo sync
   picked up whenever it's actually wanted.
