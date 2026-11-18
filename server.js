'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./lib/store');
const { SECURITY_HEADERS, HttpError, sendError } = require('./lib/http');
const { createPublicRouter } = require('./lib/routes/public');
const { createOrdersRouter } = require('./lib/routes/orders');
const { createAdminRouter } = require('./lib/routes/admin');
const { createSupabaseStore, getSupabaseConfig } = require('./lib/supabase-store');
const { createPasswordAuthProvider, createSupabaseAuthProvider } = require('./lib/auth-providers');

const DEFAULT_ROOT = path.join(__dirname, 'site', 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4'
};

function sendText(res, status, text, extraHeaders = {}) {
  const body = String(text || '');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    ...extraHeaders
  });
  if (res.req && res.req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

function streamFile(req, res, filePath, stat, cacheControl = 'no-cache') {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cacheControl
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      sendText(res, 500, 'Error reading file');
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

function isSafeRelative(baseDir, targetPath) {
  const rel = path.relative(baseDir, targetPath);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function createApp(options = {}) {
  const rootDir = path.resolve(options.rootDir || DEFAULT_ROOT);
  const supabaseConfig = options.store ? null : (options.supabaseConfig || getSupabaseConfig());
  const store = options.store || (supabaseConfig
    ? createSupabaseStore({ config: supabaseConfig, seedPath: options.seedPath })
    : createStore({ dataDir: options.dataDir, seedPath: options.seedPath }));
  store.ensureStoreSync();

  const authProvider = options.authProvider || (store.kind === 'supabase'
    ? createSupabaseAuthProvider({ config: store.config })
    : createPasswordAuthProvider());

  const routers = [
    createPublicRouter({ store }),
    createOrdersRouter({ store }),
    createAdminRouter({ store, authProvider })
  ];

  async function sendCatalogScript(req, res) {
    const data = await store.getCatalog();
    const payload = {
      links: data.links,
      address: data.address,
      followers: data.followers,
      posts: data.posts,
      categories: data.categories,
      stats: data.stats,
      products: data.products
    };
    const serialized = JSON.stringify(payload).replace(/</g, '\\u003c');
    const body = `window.RETROMOD = ${serialized};\n`;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body, 'utf8')
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
  }

  return async function app(req, res) {
    let url;
    let pathname;
    try {
      url = new URL(req.url || '/', 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }

    if (pathname.includes('\0')) {
      sendText(res, 400, 'Bad request');
      return;
    }

    // 1. API routes
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      try {
        if (pathname === '/api/catalog-script' || pathname === '/api/catalog.js') {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendError(res, 405, 'Method not allowed', {}, { Allow: 'GET, HEAD' });
            return;
          }
          await sendCatalogScript(req, res);
          return;
        }
        for (const router of routers) {
          const handled = await router.handle(req, res, url);
          if (handled) return;
        }
        sendError(res, 404, 'API route not found');
      } catch (err) {
        if (err instanceof HttpError) {
          sendError(res, err.status, err.message, err.extra);
          return;
        }
        console.error('Unhandled API error:', err);
        if (!res.headersSent) {
          sendError(res, 500, 'Internal server error');
        } else {
          res.end();
        }
      }
      return;
    }

    // Only GET / HEAD for media and static assets
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    // Reject backslashes or dotfile segments across media and static paths
    const segments = pathname.split('/').filter(Boolean);
    if (pathname.includes('\\') || segments.some(seg => seg.startsWith('.'))) {
      sendText(res, 403, 'Forbidden');
      return;
    }

    // 2. Uploaded/imported media routes (/media/* -> RETROMOD_DATA_DIR/media/*)
    if (pathname === '/media' || pathname.startsWith('/media/')) {
      const rel = pathname.slice('/media/'.length);
      if (!rel || pathname === '/media') {
        sendText(res, 404, 'Not found');
        return;
      }
      if (typeof store.getMediaPublicUrl === 'function') {
        if (rel.includes('/')) {
          sendText(res, 404, 'Not found');
          return;
        }
        res.writeHead(302, { ...SECURITY_HEADERS, Location: store.getMediaPublicUrl(rel), 'Cache-Control': 'no-cache' });
        res.end();
        return;
      }
      const mediaDir = path.resolve(store.getMediaDir());
      const target = path.resolve(mediaDir, rel);
      if (!isSafeRelative(mediaDir, target)) {
        sendText(res, 403, 'Forbidden');
        return;
      }
      fs.stat(target, (err, stat) => {
        if (err || !stat.isFile()) {
          sendText(res, 404, 'Not found');
          return;
        }
        streamFile(req, res, target, stat, 'no-cache');
      });
      return;
    }

    // 3. Dynamic /assets/js/products.js (legacy path) synced with the live store
    if (pathname === '/assets/js/products.js') {
      try {
        await sendCatalogScript(req, res);
        return;
      } catch (err) {
        console.error('Error rendering dynamic products.js:', err);
        // Fall through to static file if store read fails unexpectedly
      }
    }

    // 4. Static files with clean URLs
    const candidates = [];
    if (pathname === '/') {
      candidates.push('/index.html');
    } else if (pathname.endsWith('/')) {
      candidates.push(`${pathname}index.html`, `${pathname.slice(0, -1)}.html`);
    } else if (!path.extname(pathname)) {
      candidates.push(`${pathname}.html`, `${pathname}/index.html`);
    } else {
      candidates.push(pathname);
    }

    const resolvedCandidates = [];
    for (const cand of candidates) {
      const target = path.resolve(rootDir, '.' + cand);
      if (!isSafeRelative(rootDir, target)) {
        sendText(res, 403, 'Forbidden');
        return;
      }
      resolvedCandidates.push(target);
    }

    const tryNext = idx => {
      if (idx >= resolvedCandidates.length) {
        sendText(res, 404, 'Not found');
        return;
      }
      const filePath = resolvedCandidates[idx];
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          tryNext(idx + 1);
          return;
        }
        streamFile(req, res, filePath, stat, 'no-cache');
      });
    };

    tryNext(0);
  };
}

function startServer(options = {}) {
  const port = options.port !== undefined
    ? Number(options.port)
    : (Number(process.env.PORT) || 3000);

  const server = http.createServer(createApp(options));
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;

  return new Promise((resolve, reject) => {
    const onError = err => reject(err);
    server.once('error', onError);
    server.listen(port, () => {
      server.removeListener('error', onError);
      resolve(server);
    });
  });
}

function loadLocalEnvFiles(baseDir = __dirname) {
  for (const name of ['.env.local', '.env']) {
    const filePath = path.join(baseDir, name);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key && val !== '' && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    } catch {
      // Ignore optional env file read errors
    }
  }
}

if (require.main === module) {
  loadLocalEnvFiles();
  startServer()
    .then(server => {
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : (Number(process.env.PORT) || 3000);
      console.log(`RETROMOD running at http://localhost:${actualPort}`);

      const shutdown = () => {
        server.close(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch(err => {
      console.error('Failed to start RETROMOD server:', err);
      process.exit(1);
    });
}

module.exports = {
  createApp,
  loadLocalEnvFiles,
  startServer,
  TYPES
};
