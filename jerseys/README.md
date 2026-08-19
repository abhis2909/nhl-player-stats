# Jersey pack images

Static image files for the Player Jersey Packs mini-game (`packs.html`/
`packs.js`) — plain files served directly by Vercel (and `server.js`
locally) at `/jerseys/<filename>`, same convention as `/avatars` for
Fantasy Hub avatars. Not a live upload feature.

**Workflow**: drop the image file(s) here (e.g. `jerseys/bruins-orr.png`),
tell Claude the filename, and it wires the path into `packs.js` in
place of (or alongside) the CSS-drawn jersey template — resizing/
recoloring/positioning it to match the site's dark theme, tier-colored
glow, and the pack-opening stage around it.

Keep filenames lowercase, hyphenated, descriptive (e.g.
`<team>-<detail>.png`) — no spaces.
