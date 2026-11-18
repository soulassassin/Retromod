'use strict';

// Two interchangeable admin auth providers used by lib/routes/admin.js:
//  - password: the original single shared password (RETROMOD_ADMIN_PASSWORD), used locally/tests.
//  - supabase: per-staff email + password via Supabase Auth, gated by the public.staff allowlist.
// Each provider exposes: mode, login(req, body), logout(req), getSession(req).
// All return { cookies: [...] } so the router can attach Set-Cookie headers.

const auth = require('./auth');
const { parseCookies } = require('./http');

const AT_COOKIE = 'retromod_at';
const RT_COOKIE = 'retromod_rt';
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_CACHE_MS = 60 * 1000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function createPasswordAuthProvider() {
  return {
    mode: 'password',
    async login(req, body) {
      const check = auth.verifyAdminPassword(body.password);
      if (!check.configured) return { ok: false, status: 503, error: 'Admin password is not configured', cookies: [] };
      if (!check.ok) return { ok: false, status: 401, error: 'Invalid password', cookies: [] };
      return { ok: true, user: { email: '' }, cookies: [auth.createSessionCookie(req).cookie] };
    },
    async logout(req) {
      return { cookies: [auth.clearSessionCookie(req)] };
    },
    async getSession(req) {
      const session = auth.verifySession(req);
      if (!session) return { session: null, cookies: [] };
      const cookies = auth.shouldRotate(session) ? [auth.createSessionCookie(req).cookie] : [];
      return { session: { user: { email: '' } }, cookies };
    }
  };
}

function cookie(req, name, value, maxAgeSeconds) {
  const maxAge = Math.max(0, Math.floor(Number(maxAgeSeconds) || 0));
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/api',
    `Max-Age=${maxAge}`
  ];
  if (maxAge <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (auth.isHttpsRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function createSupabaseAuthProvider({ config, fetchImpl = fetch } = {}) {
  if (!config || !config.url || !config.serviceKey) {
    throw new Error('Supabase auth requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  const publicKey = config.anonKey || config.serviceKey;
  const cache = new Map(); // access token -> { user, until }

  async function authFetch(pathname, { method = 'GET', body, bearer } = {}) {
    const res = await fetchImpl(`${config.url}${pathname}`, {
      method,
      headers: {
        apikey: publicKey,
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { ok: res.ok, status: res.status, json };
  }

  async function isStaff(userId) {
    const res = await fetchImpl(
      `${config.url}/rest/v1/staff?select=user_id&user_id=eq.${encodeURIComponent(userId)}`,
      {
        headers: {
          apikey: config.serviceKey,
          ...(config.serviceKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${config.serviceKey}` })
        }
      }
    );
    if (!res.ok) throw new Error(`Staff lookup failed (${res.status})`);
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  }

  function sessionCookies(req, tokens) {
    return [
      cookie(req, AT_COOKIE, tokens.access_token, Number(tokens.expires_in) || 3600),
      cookie(req, RT_COOKIE, tokens.refresh_token, REFRESH_TTL_SECONDS)
    ];
  }

  function clearCookies(req) {
    return [cookie(req, AT_COOKIE, '', 0), cookie(req, RT_COOKIE, '', 0)];
  }

  async function userForAccessToken(accessToken) {
    const hit = cache.get(accessToken);
    if (hit && hit.until > Date.now()) return hit.user;
    const res = await authFetch('/auth/v1/user', { bearer: accessToken });
    if (!res.ok || !res.json || !res.json.id) return null;
    const user = { id: res.json.id, email: res.json.email || '' };
    if (!(await isStaff(user.id))) return null;
    cache.set(accessToken, { user, until: Date.now() + SESSION_CACHE_MS });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return user;
  }

  return {
    mode: 'supabase',

    async login(req, body) {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!EMAIL_RE.test(email) || !password) {
        return { ok: false, status: 400, error: 'Enter your email and password', cookies: [] };
      }
      const res = await authFetch('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: { email, password }
      });
      if (res.status === 429) {
        return { ok: false, status: 429, error: 'Too many attempts. Wait a minute and try again.', cookies: [] };
      }
      if (!res.ok || !res.json || !res.json.access_token) {
        return { ok: false, status: 401, error: 'Incorrect email or password', cookies: [] };
      }
      const user = res.json.user || {};
      if (!user.id || !(await isStaff(user.id))) {
        return { ok: false, status: 403, error: 'This account does not have stock manager access', cookies: [] };
      }
      return { ok: true, user: { email: user.email || email }, cookies: sessionCookies(req, res.json) };
    },

    async logout(req) {
      const cookies = parseCookies(req);
      const at = cookies[AT_COOKIE];
      if (at) {
        cache.delete(at);
        try { await authFetch('/auth/v1/logout', { method: 'POST', bearer: at }); } catch { /* best effort */ }
      }
      return { cookies: clearCookies(req) };
    },

    async getSession(req) {
      const cookies = parseCookies(req);
      const at = cookies[AT_COOKIE];
      const rt = cookies[RT_COOKIE];

      if (at) {
        const user = await userForAccessToken(at);
        if (user) return { session: { user }, cookies: [] };
      }
      if (!rt) return { session: null, cookies: at ? clearCookies(req) : [] };

      const res = await authFetch('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: rt }
      });
      if (!res.ok || !res.json || !res.json.access_token) {
        return { session: null, cookies: clearCookies(req) };
      }
      const user = await userForAccessToken(res.json.access_token);
      if (!user) return { session: null, cookies: clearCookies(req) };
      return { session: { user }, cookies: sessionCookies(req, res.json) };
    }
  };
}

module.exports = {
  AT_COOKIE,
  RT_COOKIE,
  createPasswordAuthProvider,
  createSupabaseAuthProvider
};
