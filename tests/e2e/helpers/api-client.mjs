import assert from 'node:assert/strict';

export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  capture(res) {
    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie')]
          : [];

    for (const raw of setCookies) {
      const firstPart = raw.split(';')[0] || '';
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx <= 0) continue;
      const name = firstPart.slice(0, eqIdx).trim();
      const value = firstPart.slice(eqIdx + 1).trim();
      if (!value || /max-age=0/i.test(raw)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  header() {
    if (this.cookies.size === 0) return '';
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export async function apiRequest(baseUrl, pathAndQuery, options = {}) {
  const { method = 'GET', body, headers = {}, jar } = options;
  const reqHeaders = { ...headers };
  if (jar) {
    const cookieHeader = jar.header();
    if (cookieHeader) reqHeaders.Cookie = cookieHeader;
  }

  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') {
      payload = body;
      if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
    } else {
      payload = JSON.stringify(body);
      if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(`${baseUrl}${pathAndQuery}`, {
    method,
    headers: reqHeaders,
    body: payload,
    redirect: options.redirect ?? 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 8000)
  });

  if (jar) jar.capture(res);

  const rawText = await res.text();
  let json = null;
  try {
    json = JSON.parse(rawText);
  } catch {
    // Non-JSON response
  }

  return {
    status: res.status,
    headers: res.headers,
    text: rawText,
    json
  };
}

export async function loginAdminApi(baseUrl, password) {
  const jar = new CookieJar();
  const res = await apiRequest(baseUrl, '/api/admin/login', {
    method: 'POST',
    body: { password },
    jar
  });
  assert.equal(res.status, 200, `Admin login failed: HTTP ${res.status} ${res.text}`);
  assert.equal(res.json?.authenticated, true);
  return jar;
}

export function buildValidOrderPayload(overrides = {}) {
  return {
    customer: {
      name: 'Thabo Mokoena',
      email: 'thabo.mokoena@example.co.za',
      phone: '+27 82 555 0142',
      ...(overrides.customer || {})
    },
    fulfillment: overrides.fulfillment ?? 'collection',
    ...(overrides.shippingAddress ? { shippingAddress: overrides.shippingAddress } : {}),
    paymentMethod: overrides.paymentMethod ?? 'eft',
    notes: overrides.notes ?? 'Please test on arrival',
    items: overrides.items ?? [{ id: 'marantz-twenty-nine', quantity: 1 }]
  };
}
