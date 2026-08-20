# Jersey pack images

Static image files for the Player Jersey Packs mini-game (`packs.html`/
`packs.js`) — plain files served directly by Vercel (and `server.js`
locally) at `/jerseys/<filename>`, same convention as `/avatars` for
Fantasy Hub avatars.

Jersey art renders as a plain rectangular photo card (rounded corners +
tier glow) in the pack-opening game — there's no need to cut the
background out. Upload the photo as-is; whatever's in frame is what
players will see.

## Getting a new jersey image in here

**Preferred: Admin → Jerseys.** Two tools live on that tab:

- **Single jersey.** Upload a photo, pick the team, give it a name.
  The photo is used as-is by default — background removal is an
  optional checkbox for the rare case you actually want a cutout (e.g.
  the photo has a distracting background you'd rather lose).
- **Split a grid image.** For a sheet with several players laid out in
  a grid (e.g. a batch of AI-generated portraits), upload it once, set
  rows/columns and trim margins, and use the live gridline preview to
  line it up before slicing. Each resulting cell gets its own
  team/name fields and the same download/stage/publish actions as the
  single-jersey tool.

Either way, **Publish to GitHub** commits the file straight into this
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

Publish is **image-only** — it does not touch `packs.js`. Each tool
still gives you a ready-to-copy `JERSEY_ART` snippet ("Stage" keeps a
running list of them, this browser only, shared between both tools);
paste that into `packs.js` yourself, or hand it to Claude, to actually
put the published jersey in the game.

**No token configured, or you'd rather push originals yourself?** Drop
files here directly via GitHub's own web UI or a normal git push, tell
Claude the filename, and it wires the `JERSEY_ART` entry into
`packs.js` for you. Both admin tools also have a "load an existing
file from jerseys/" option right below the upload field — type the
filename already in this folder and hit Load, and it runs through the
same crop/background-removal/preview pipeline as a fresh upload. That
fetch is same-origin, so it works with no token at all; only Publish
needs one, and Download always works, so this is the way to touch up
something you already pushed by hand (recrop it, try background
removal on it) without ever needing GITHUB_TOKEN configured.

Keep filenames lowercase, hyphenated, descriptive (e.g.
`<team>-<detail>.png`) — no spaces. The admin tool's downloaded/
published filenames already follow this (team + name, slugified).
