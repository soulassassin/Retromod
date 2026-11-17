'use strict';

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
});

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    ...extraHeaders
  };
  res.writeHead(status, headers);
  if (res.req && res.req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

function sendError(res, status, message, extra = {}, extraHeaders = {}) {
  sendJson(res, status, { error: message, ...extra }, extraHeaders);
}

function readJsonBody(req, { maxBytes = 1024 * 1024, requireObject = true } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on('data', chunk => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.resume();
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        if (requireObject) {
          reject(new HttpError(400, 'Request body is required'));
          return;
        }
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
        return;
      }
      if (requireObject && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
        reject(new HttpError(400, 'JSON body must be an object'));
        return;
      }
      resolve(parsed);
    });

    req.on('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function parseCookies(req) {
  const header = req && req.headers && req.headers.cookie;
  const cookies = {};
  if (!header || typeof header !== 'string') return cookies;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }
  return cookies;
}

module.exports = {
  SECURITY_HEADERS,
  HttpError,
  sendJson,
  sendError,
  readJsonBody,
  parseCookies
};
