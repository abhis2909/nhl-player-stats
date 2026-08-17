'use strict';

/* Canary — deployed and verified alone (before anything else depends on
   the api/fantasy/ nested-folder pattern) given this repo's documented
   history of a Vercel routing pitfall with catch-all dynamic routes
   under api/ (see api/_lib/proxy.js's history / README.md's "Why
   there's a proxy" section). Fixed filenames like this one are a
   different, standard Vercel zero-config pattern — this just confirms
   it in practice on this specific project before anything real is
   built on top of it. */
module.exports = function handler(req, res) {
  res.status(200).json({ ok: true });
};
