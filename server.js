// Zero-dependency local server for the NHL Stats site.
// Serves the static front-end AND proxies NHL's JSON APIs (which don't send
// CORS headers, so the browser can't call them directly from a page).
// Also locally routes /api/fantasy/* to the Fantasy Hub serverless
// functions in api/fantasy/ (see handleFantasyApi() below) — those need
// DATABASE_URL/SESSION_SECRET, loaded from .env if present.
//
// Usage: node server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.argv[2] || 5173;
const root = __dirname;

// Minimal, dependency-free .env loader — a silent no-op if .env doesn't
// exist, so the main site (which needs none of this) still runs with
// zero setup. Only the Fantasy Hub routes actually need these vars.
function loadEnvFile() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// Upstream NHL API hosts we're allowed to proxy to, keyed by the local prefix.
// Same prefixes as the Vercel serverless functions in /api, so app.js works
// unchanged whether it's talking to this local server or a Vercel deployment.
const UPSTREAMS = {
  '/api/web/': 'https://api-web.nhle.com/',
  '/api/stats/': 'https://api.nhle.com/stats/rest/',
};

// Simple in-memory response cache to keep repeated page loads (e.g. re-fetching
// all 32 rosters for the search index) fast and go easier on the upstream API.
const cache = new Map(); // url -> { body, contentType, expires }
const CACHE_MS = 5 * 60 * 1000;

function proxy(req, res, prefix, upstreamBase) {
  const rest = req.url.slice(prefix.length);
  const upstreamUrl = upstreamBase + rest;

  const hit = cache.get(upstreamUrl);
  if (hit && hit.expires > Date.now()) {
    res.writeHead(200, { 'Content-Type': hit.contentType, 'X-Cache': 'HIT' });
    res.end(hit.body);
    return;
  }

  fetch(upstreamUrl, { headers: { 'User-Agent': 'nhl-stats-site/1.0' } })
    .then(async (upstreamRes) => {
      const contentType = upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8';
      const body = Buffer.from(await upstreamRes.arrayBuffer());
      if (upstreamRes.ok) {
        cache.set(upstreamUrl, { body, contentType, expires: Date.now() + CACHE_MS });
      }
      res.writeHead(upstreamRes.status, { 'Content-Type': contentType, 'X-Cache': 'MISS' });
      res.end(body);
    })
    .catch((err) => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Upstream fetch failed', detail: String(err) }));
    });
}

// ---- Fantasy Hub API (local dev) ----
// Routes /api/fantasy/<name> to api/fantasy/<name>.js's handler
// UNMODIFIED — same file Vercel deploys. Node's raw http.ServerResponse
// doesn't have Vercel's res.status()/res.json() helpers, so this adds
// just enough of a shim to reproduce them locally (same spirit as the
// NHL API proxy above: local dev and Vercel share identical route
// shapes and handler code).
function augmentResponse(res) {
  res.status = function (code) {
    res.statusCode = code;
    return res;
  };
  res.json = function (body) {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
    return res;
  };
  return res;
}

async function handleFantasyApi(req, res, name) {
  augmentResponse(res);
  // Vercel's Node runtime parses the URL's query string onto req.query
  // for us; Node's raw http.IncomingMessage doesn't, so this reproduces
  // just that piece locally (same spirit as augmentResponse() above) —
  // needed by anything using ?param= dispatch (admin-settings.js,
  // admin-users.js's per-user detail view).
  const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
  req.query = Object.fromEntries(new URLSearchParams(queryString));
  let handler;
  try {
    // Fresh require each time (bypass the module cache) so edits to a
    // handler file take effect without restarting this dev server.
    const modPath = require.resolve(`./api/fantasy/${name}.js`);
    delete require.cache[modPath];
    handler = require(modPath);
  } catch {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  try {
    await handler(req, res);
  } catch (err) {
    console.error(`api/fantasy/${name} error:`, err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'server_error' });
  }
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(root, urlPath);

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  for (const [prefix, upstreamBase] of Object.entries(UPSTREAMS)) {
    if (req.url.startsWith(prefix)) {
      proxy(req, res, prefix, upstreamBase);
      return;
    }
  }
  const fantasyMatch = req.url.split('?')[0].match(/^\/api\/fantasy\/([a-zA-Z0-9_-]+)$/);
  if (fantasyMatch) {
    handleFantasyApi(req, res, fantasyMatch[1]);
    return;
  }
  serveStatic(req, res);
});

server.listen(port, () => {
  console.log(`NHL Stats site running at http://localhost:${port}/`);
});
