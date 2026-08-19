# Jersey pack images

Static image files for the Player Jersey Packs mini-game (`packs.html`/
`packs.js`) — plain files served directly by Vercel (and `server.js`
locally) at `/jerseys/<filename>`, same convention as `/avatars` for
Fantasy Hub avatars.

## Getting a new jersey image in here

**Preferred: Admin → Jerseys.** Upload a photo, pick the team, give it
a name — background removal (or, if the PNG is already cut out
elsewhere, a trim-only pass) runs right there in the browser, then
**Publish to GitHub** commits the processed file straight into this
folder via `POST /api/fantasy/admin-settings` (`type: 'jersey-image'`,
handled in `handleJerseyImagePublish()` there, using
`api/_lib/github.js`'s GitHub Contents API client). That call needs a
`GITHUB_TOKEN` env var — a fine-grained Personal Access Token scoped to
just this repo with **Contents: Read and write** permission, set in
Vercel's project settings (and locally in `.env` if testing against a
real repo). Two more env vars are optional, defaulting to this repo's
real values — only set them if either ever changes:
`GITHUB_REPO` (`"owner/repo"`, default `abhis2909/nhl-player-stats`)
and `GITHUB_TARGET_BRANCH` (default `main`).

Publish is **image-only** — it does not touch `packs.js`. The tab still
gives you a ready-to-copy `JERSEY_ART` snippet ("Add to staged list"
keeps a running list of them, this browser only); paste that into
`packs.js` yourself, or hand it to Claude, to actually put the
published jersey in the game.

**Fallback, no token configured (or you already have a processed PNG
some other way)**: drop the file here directly via GitHub's own web UI
or a normal git push, tell Claude the filename, and it wires the
`JERSEY_ART` entry into `packs.js` for you.

Keep filenames lowercase, hyphenated, descriptive (e.g.
`<team>-<detail>.png`) — no spaces. The admin tool's downloaded/
published filenames already follow this (team + name, slugified).
