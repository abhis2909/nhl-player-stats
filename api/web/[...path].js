const { proxyRequest } = require('../_lib/proxy');

// Serves /api/web/* -> https://api-web.nhle.com/*
module.exports = function handler(req, res) {
  return proxyRequest(req, res, 'https://api-web.nhle.com/');
};
