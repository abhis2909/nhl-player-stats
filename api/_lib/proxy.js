// Shared proxy logic for the Vercel API routes in ../web and ../stats.
// Anything under api/_lib is *not* deployed as a route by Vercel (folders
// and files starting with "_" are treated as private/importable code, not
// endpoints) — it's just shared code the two route handlers both call.
//
// Why this exists at all: api-web.nhle.com and api.nhle.com/stats/rest
// don't send CORS headers, so the browser can't call them directly. This
// runs server-side (no CORS involved) and hands the JSON back same-origin.

async function proxyRequest(req, res, upstreamBase) {
  const { path } = req.query;
  const upstreamPath = Array.isArray(path) ? path.join('/') : (path || '');

  // Reuse the exact incoming query string (everything after the first "?")
  // rather than rebuilding it from req.query, so values like cayenneExp
  // that contain spaces/quotes/"=" round-trip byte-for-byte.
  const qIndex = req.url.indexOf('?');
  const qs = qIndex >= 0 ? req.url.slice(qIndex) : '';
  const upstreamUrl = `${upstreamBase}${upstreamPath}${qs}`;

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      headers: { 'User-Agent': 'nhl-stats-site/1.0' },
    });
    const body = await upstreamRes.text();
    res.status(upstreamRes.status);
    res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8');
    // Let Vercel's edge cache repeat requests (e.g. every visitor's initial
    // league-wide stat pull) instead of re-hitting the NHL API each time.
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: 'Upstream fetch failed', detail: String(err) });
  }
}

module.exports = { proxyRequest };
