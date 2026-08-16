# NHL Player Stats

A website with current-season stats for every NHL skater and goalie —
searchable, filterable by team, sortable by column, and with the exact set
of stat columns configurable from an admin page. Click any player to see
their bio and full **game log** (regular season or playoffs, any season of
their career).

Data comes from the unofficial NHL API, mapped from
[Zmalski/NHL-API-Reference](https://github.com/Zmalski/NHL-API-Reference).
Runs either as a local Node server or deployed to Vercel — both use the
same frontend code and the same `/api/web/*` and `/api/stats/*` proxy
routes (see "Why there's a proxy" below).

## Running it locally

Requires [Node.js](https://nodejs.org) (already on this machine: v24).

```bash
node server.js
```

Then open **http://localhost:5173/**. Leave the terminal running while you
use the site. (Double-clicking `index.html` directly will **not** work —
see below.)

## Deploying to Vercel

No build step needed — Vercel serves `index.html`/`admin.html` etc. as
static files and auto-deploys everything under `api/` as serverless
functions. Once the repo is on GitHub:

1. [vercel.com/new](https://vercel.com/new) → Import the GitHub repo.
2. Leave all settings at their defaults (Framework Preset: "Other", no
   build command needed) → Deploy.

That's it — `api/web/[...path].js` and `api/stats/[...path].js` become
serverless functions that do the same proxying `server.js` does locally.

## What's shown

**Skaters** (forwards & defensemen together, tagged F/D) and **Goalies**,
each in their own sortable table — team, headshot, and whichever stat
columns are enabled in **⚙ Columns** (top right of the main page). Defaults:

- Skaters: Goals, Assists, Power-Play Points, Shorthanded Points, PIM,
  Hits, Blocked Shots, Shots on Goal
- Goalies: Wins, GAA, Saves, Shutouts

The admin page (`admin.html`) has ~19 skater stats and ~11 goalie stats to
choose from (points, +/-, faceoff %, giveaways/takeaways, save %, etc.).
Selections are saved in the browser (`localStorage`) and take effect next
time the stats page loads. The same page shows/accepts the selection as
JSON, for reuse elsewhere.

Click a player for headshot, bio, draft info, and a game log browsable by
season and by regular season / playoffs.

## Why there's a proxy

`api-web.nhle.com` doesn't send CORS headers, so a browser can't call it
directly from a page (confirmed — it fails with a CORS error). Both
`server.js` (local) and `api/web-proxy.js` + `api/stats-proxy.js` (Vercel,
reached via the rewrites in `vercel.json`) exist purely to work around
that: they forward `/api/web/*` to `https://api-web.nhle.com/*` and
`/api/stats/*` to `https://api.nhle.com/stats/rest/*` server-side, where
CORS doesn't apply.

(An earlier version used Vercel's filesystem-based catch-all routes —
`api/web/[...path].js` — but Vercel wasn't building those into functions
for this non-framework project, so it's an explicit `vercel.json` rewrite
to fixed-name function files instead, which is unambiguous.)

## Files

| File | Purpose |
|---|---|
| `index.html` / `app.js` | Main stats page |
| `admin.html` / `admin.js` | Column picker (which stats are shown) |
| `columns.js` | Shared stat catalog + localStorage read/write — used by both pages |
| `style.css` | Styling for both pages |
| `server.js` | Local static file server + API proxy |
| `api/web-proxy.js`, `api/stats-proxy.js`, `api/_lib/proxy.js` | Same proxy, as Vercel serverless functions |
| `vercel.json` | Rewrites `/api/web/*` and `/api/stats/*` to the functions above |
| `package.json` | No dependencies — just lets Vercel/npm recognize the project |

## Notes

- Unofficial API — not affiliated with or endorsed by the NHL. For personal
  / educational use.
- The season shown auto-advances each year (read from the NHL's live
  standings, not hardcoded).
- Responses are cached for 5 minutes (in-memory locally, at Vercel's edge
  when deployed), so switching filters/teams/players doesn't re-hit the
  NHL API every time.
