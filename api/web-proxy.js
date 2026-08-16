const { proxyRequest } = require('./_lib/proxy');

// Reached via the /api/web/:path* rewrite in vercel.json.
// Serves /api/web/* -> https://api-web.nhle.com/*
module.exports = function handler(req, res) {
  return proxyRequest(req, res, 'https://api-web.nhle.com/');
};
