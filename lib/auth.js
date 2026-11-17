'use strict';

const crypto = require('crypto');
const { parseCookies } = require('./http');

const COOKIE_NAME = 'retromod_admin';
const DEFAULT_TTL_SECONDS = 12 * 60 * 60; // 12 hours

// Ephemeral per-process fallback secret if RETROMOD_SESSION_SECRET is not set.
// Never a hardcoded constant.
const EPHEMERAL_SECRET = crypto.randomBytes(32);

function getConfiguredPassword() {
  const raw = process.env.RETROMOD_ADMIN_PASSWORD;
  if (typeof raw !== 'string') return '';
  if (!raw || !raw.trim()) return '';
  return raw;
}

function isPasswordConfigured() {
  return Boolean(getConfiguredPassword());
}

function getSessionSecret() {
  const raw = process.env.RETROMOD_SESSION_SECRET;
  if (typeof raw === 'string' && raw.length > 0) {
    return Buffer.from(raw, 'utf8');
  }
  return EPHEMERAL_SECRET;
}

function safeEqualStrings(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getPasswordVersion(password) {
  return crypto
    .createHash('sha256')
    .update(String(password), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function verifyAdminPassword(candidatePassword) {
  const configured = getConfiguredPassword();
  if (!configured) {
    return { ok: false, configured: false };
  }
  if (typeof candidatePassword !== 'string' || !candidatePassword) {
    return { ok: false, configured: true };
  }
  return {
    ok: safeEqualStrings(candidatePassword, configured),
    configured: true
  };
}

function signToken({ ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const configured = getConfiguredPassword();
  if (!configured) {
    throw new Error('Admin password is not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? Math.floor(ttlSeconds)
    : DEFAULT_TTL_SECONDS;

  const payload = {
    sub: 'admin',
    iat: now,
    exp: now + ttl,
    jti: crypto.randomBytes(8).toString('hex'),
    pwv: getPasswordVersion(configured)
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sigB64 = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payloadB64)
    .digest('base64url');

  return {
    token: `${payloadB64}.${sigB64}`,
    payload,
    ttlSeconds: ttl
  };
}

function verifyToken(token) {
  const configured = getConfiguredPassword();
  if (!configured) return null;
  if (typeof token !== 'string' || !token) return null;

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const [payloadB64, sigB64] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payloadB64)
    .digest();

  let actualSig;
  try {
    actualSig = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }

  if (
    actualSig.length !== expectedSig.length ||
    actualSig.toString('base64url') !== sigB64 ||
    !crypto.timingSafeEqual(actualSig, expectedSig)
  ) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    payload.sub !== 'admin' ||
    !Number.isFinite(payload.iat) ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= now
  ) {
    return null;
  }

  if (
    typeof payload.pwv !== 'string' ||
    !safeEqualStrings(payload.pwv, getPasswordVersion(configured))
  ) {
    return null;
  }

  return payload;
}

function isHttpsRequest(req) {
  if (req && req.socket && req.socket.encrypted) {
    return true;
  }
  const xfProto = req && req.headers && req.headers['x-forwarded-proto'];
  if (!xfProto) return false;
  return String(xfProto).split(',')[0].trim().toLowerCase() === 'https';
}

function formatCookie(req, value, maxAgeSeconds) {
  const maxAge = Math.max(0, Math.floor(Number(maxAgeSeconds) || 0));
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`
  ];
  if (maxAge <= 0) {
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  if (isHttpsRequest(req)) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function createSessionCookie(req, opts = {}) {
  const { token, payload, ttlSeconds } = signToken(opts);
  return {
    token,
    payload,
    cookie: formatCookie(req, token, ttlSeconds)
  };
}

function clearSessionCookie(req) {
  return formatCookie(req, '', 0);
}

function verifySession(req) {
  const cookies = parseCookies(req);
  const raw = cookies[COOKIE_NAME];
  return verifyToken(raw);
}

function shouldRotate(payload) {
  if (!payload || !Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  const lifespan = payload.exp - payload.iat;
  if (lifespan <= 0) return false;
  return (payload.exp - now) < Math.floor(lifespan / 2);
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_TTL_SECONDS,
  getConfiguredPassword,
  isPasswordConfigured,
  getSessionSecret,
  safeEqualStrings,
  getPasswordVersion,
  verifyAdminPassword,
  signToken,
  verifyToken,
  isHttpsRequest,
  formatCookie,
  createSessionCookie,
  clearSessionCookie,
  verifySession,
  shouldRotate
};
