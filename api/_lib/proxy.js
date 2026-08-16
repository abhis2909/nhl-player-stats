// Shared proxy logic for the Vercel API routes in ../web-proxy.js and
// ../stats-proxy.js. Not deployed as a route itself (Vercel skips
// files/folders starting with "_") — just shared code both handlers call.
//
// Why this exists at all: api-web.nhle.com and api.nhle.com/stats/rest
// don't send CORS headers, so the browser can't call them directly. This
// runs server-side (no CORS involved) and hands the JSON back same-origin.
//
// vercel.json rewrites /api/web/:path* (and /api/stats/:path*) to this
// function with the matched sub-path passed as an `upstreamPath` query
// param, merging in the request's real query string (limit, cayenneExp,
// etc). We reconstruct from req.query rather than parsing req.url
// ourselves, since req.query is what Vercel's Node runtime guarantees is
// correctly parsed post-rewrite.

async function proxyRequest(req, res, upstreamBase) {
  const { upstreamPath, ...rest } = req.query || {};
  const path = Array.isArray(upstreamPath) ? upstreamPath.join('/') : (upstreamPath || '');

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(rest)) {
    if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
    else if (value != null) params.append(key, value);
  }
  const qs = params.toString();
  const upstreamUrl = `${upstreamBase}${path}${qs ? '?' + qs : ''}`;

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
