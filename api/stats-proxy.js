const { proxyRequest } = require('./_lib/proxy');

// Reached via the /api/stats/:path* rewrite in vercel.json.
// Serves /api/stats/* -> https://api.nhle.com/stats/rest/*
module.exports = function handler(req, res) {
  return proxyRequest(req, res, 'https://api.nhle.com/stats/rest/');
};
