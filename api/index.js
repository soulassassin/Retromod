'use strict';

// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json)
// and handled by the same app as `npm start`, backed by Supabase.
const { createApp } = require('../server');
const { getSupabaseConfig } = require('../lib/supabase-store');

let app = null;

module.exports = async function handler(req, res) {
  if (!getSupabaseConfig()) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Stock database is not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).' }));
    return;
  }
  if (!app) app = createApp();
  return app(req, res);
};
