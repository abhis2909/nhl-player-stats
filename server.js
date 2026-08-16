// Zero-dependency local server for the NHL Stats site.
// Serves the static front-end AND proxies NHL's JSON APIs (which don't send
// CORS headers, so the browser can't call them directly from a page).
//
// Usage: node server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.argv[2] || 5173;
const root = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
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
  serveStatic(req, res);
});

server.listen(port, () => {
  console.log(`NHL Stats site running at http://localhost:${port}/`);
});
