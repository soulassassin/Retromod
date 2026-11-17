'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const auth = require('../../lib/auth');
const storeModule = require('../../lib/store');
const { startServer } = require('../../server');

function makeTempDir(prefix = 'retromod-m3-auth-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function assertSecurityHeaders(res) {
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
}

function extractCookiePair(res) {
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'Expected Set-Cookie header');
  const firstSemi = setCookie.indexOf(';');
  return firstSemi === -1 ? setCookie : setCookie.slice(0, firstSemi);
}

describe('lib/auth primitives & fail-closed security', () => {
  it('fails closed when RETROMOD_ADMIN_PASSWORD is unset or empty', (t) => {
    const prevPw = process.env.RETROMOD_ADMIN_PASSWORD;
    t.after(() => {
      if (prevPw === undefined) delete process.env.RETROMOD_ADMIN_PASSWORD;
      else process.env.RETROMOD_ADMIN_PASSWORD = prevPw;
    });

    delete process.env.RETROMOD_ADMIN_PASSWORD;
    assert.equal(auth.isPasswordConfigured(), false);
    assert.deepEqual(auth.verifyAdminPassword('change-me-in-production'), { ok: false, configured: false });
    assert.throws(() => auth.signToken(), /not configured/i);

    process.env.RETROMOD_ADMIN_PASSWORD = '   ';
    assert.equal(auth.isPasswordConfigured(), false);
    assert.deepEqual(auth.verifyAdminPassword('   '), { ok: false, configured: false });
  });

  it('signs and verifies HMAC tokens, invalidating on tamper, expiry, secret change, or password rotation', (t) => {
    const prevPw = process.env.RETROMOD_ADMIN_PASSWORD;
    const prevSec = process.env.RETROMOD_SESSION_SECRET;
    t.after(() => {
      if (prevPw === undefined) delete process.env.RETROMOD_ADMIN_PASSWORD;
      else process.env.RETROMOD_ADMIN_PASSWORD = prevPw;
      if (prevSec === undefined) delete process.env.RETROMOD_SESSION_SECRET;
      else process.env.RETROMOD_SESSION_SECRET = prevSec;
    });

    process.env.RETROMOD_ADMIN_PASSWORD = 'correct-horse-battery-staple';
    process.env.RETROMOD_SESSION_SECRET = 'test-hmac-secret-1';

    assert.equal(auth.verifyAdminPassword('short').ok, false);
    assert.equal(auth.verifyAdminPassword('very-long-wrong-password-123456').ok, false);
    assert.equal(auth.verifyAdminPassword('correct-horse-battery-staple').ok, true);

    const { token } = auth.signToken({ ttlSeconds: 600 });
    const verified = auth.verifyToken(token);
    assert.ok(verified);
    assert.equal(verified.sub, 'admin');

    // Tampered signature / payload rejected
    const [p, s] = token.split('.');
    const flippedSig = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    assert.equal(auth.verifyToken(`${p}.${flippedSig}`), null);
    assert.equal(auth.verifyToken('not.a.valid.token'), null);
    assert.equal(auth.verifyToken(''), null);

    // Expired token rejected
    const expiredPayload = Buffer.from(JSON.stringify({
      sub: 'admin',
      iat: 1000,
      exp: 1001,
      jti: '1234',
      pwv: auth.getPasswordVersion(process.env.RETROMOD_ADMIN_PASSWORD)
    })).toString('base64url');
    assert.equal(auth.verifyToken(`${expiredPayload}.${s}`), null);

    // Password rotation immediately invalidates existing token via pwv
    process.env.RETROMOD_ADMIN_PASSWORD = 'rotated-new-password';
    assert.equal(auth.verifyToken(token), null);

    // Restoring password restores validity unless secret changes
    process.env.RETROMOD_ADMIN_PASSWORD = 'correct-horse-battery-staple';
    assert.ok(auth.verifyToken(token));
    process.env.RETROMOD_SESSION_SECRET = 'test-hmac-secret-2';
    assert.equal(auth.verifyToken(token), null);
  });

  it('sets conditional Secure attribute based on HTTPS / X-Forwarded-Proto', (t) => {
    const prevPw = process.env.RETROMOD_ADMIN_PASSWORD;
    t.after(() => {
      if (prevPw === undefined) delete process.env.RETROMOD_ADMIN_PASSWORD;
      else process.env.RETROMOD_ADMIN_PASSWORD = prevPw;
    });
    process.env.RETROMOD_ADMIN_PASSWORD = 'pw-cookie-check';

    const httpReq = { headers: {}, socket: { encrypted: false } };
    const httpCookie = auth.createSessionCookie(httpReq).cookie;
    assert.match(httpCookie, /HttpOnly/);
    assert.match(httpCookie, /SameSite=Lax/);
    assert.match(httpCookie, /Path=\//);
    assert.doesNotMatch(httpCookie, /;\s*Secure\b/);

    const proxiedHttpsReq = { headers: { 'x-forwarded-proto': 'https' }, socket: { encrypted: false } };
    const httpsCookie = auth.createSessionCookie(proxiedHttpsReq).cookie;
    assert.match(httpsCookie, /;\s*Secure\b/);

    const tlsReq = { headers: {}, socket: { encrypted: true } };
    assert.match(auth.createSessionCookie(tlsReq).cookie, /;\s*Secure\b/);
  });
});

describe('Admin API auth, catalog, orders & console integration', () => {
  it('returns 503 on login when RETROMOD_ADMIN_PASSWORD is unconfigured', async (t) => {
    const tmpDir = makeTempDir();
    const prevPw = process.env.RETROMOD_ADMIN_PASSWORD;
    delete process.env.RETROMOD_ADMIN_PASSWORD;
    const server = await startServer({ port: 0, dataDir: tmpDir });
    t.after(() => {
      server.close();
      if (prevPw === undefined) delete process.env.RETROMOD_ADMIN_PASSWORD;
      else process.env.RETROMOD_ADMIN_PASSWORD = prevPw;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'change-me-in-production' })
    });
    assert.equal(res.status, 503);
    assertSecurityHeaders(res);
  });

  it('enforces login/session/logout, 401 gates, 405 methods, and admin static page contracts', async (t) => {
    const tmpDir = makeTempDir();
    const prevPw = process.env.RETROMOD_ADMIN_PASSWORD;
    const prevSec = process.env.RETROMOD_SESSION_SECRET;
    process.env.RETROMOD_ADMIN_PASSWORD = 'studio-secret-password';
    process.env.RETROMOD_SESSION_SECRET = 'unit-test-secret';

    const server = await startServer({ port: 0, dataDir: tmpDir });
    t.after(() => {
      server.close();
      if (prevPw === undefined) delete process.env.RETROMOD_ADMIN_PASSWORD;
      else process.env.RETROMOD_ADMIN_PASSWORD = prevPw;
      if (prevSec === undefined) delete process.env.RETROMOD_SESSION_SECRET;
      else process.env.RETROMOD_SESSION_SECRET = prevSec;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const base = `http://127.0.0.1:${server.address().port}`;

    // Unauthenticated session check
    const s0 = await fetch(`${base}/api/admin/session`);
    assert.equal(s0.status, 200);
    assert.deepEqual(await s0.json(), { authenticated: false });

    // Protected routes gate at 401 when unauthenticated or with forged cookie
    const protectedProbes = [
      ['GET', '/api/admin/catalog'],
      ['PATCH', '/api/admin/products/marantz-twenty-nine'],
      ['GET', '/api/admin/orders'],
      ['PATCH', '/api/admin/orders/RM-123'],
      ['POST', '/api/admin/import/preview'],
      ['POST', '/api/admin/import/commit']
    ];
    for (const [method, endpoint] of protectedProbes) {
      const r1 = await fetch(`${base}${endpoint}`, { method });
      assert.equal(r1.status, 401, `Expected 401 on ${method} ${endpoint}`);

      const r2 = await fetch(`${base}${endpoint}`, {
        method,
        headers: { Cookie: 'retromod_admin=forged.signature' }
      });
      assert.equal(r2.status, 401, `Expected 401 on forged cookie for ${method} ${endpoint}`);
    }

    // Wrong password -> 401
    const badLogin = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' })
    });
    assert.equal(badLogin.status, 401);

    // Wrong method on login -> 405
    const getLogin = await fetch(`${base}/api/admin/login`);
    assert.equal(getLogin.status, 405);
    assert.equal(getLogin.headers.get('allow'), 'POST');

    // Valid login
    const okLogin = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'studio-secret-password' })
    });
    assert.equal(okLogin.status, 200);
    assert.deepEqual(await okLogin.json(), { authenticated: true });
    const cookie = extractCookiePair(okLogin);
    assert.ok(cookie.startsWith('retromod_admin='));

    // Authenticated session check
    const s1 = await fetch(`${base}/api/admin/session`, { headers: { Cookie: cookie } });
    assert.equal(s1.status, 200);
    assert.deepEqual(await s1.json(), { authenticated: true });

    // Wrong method on authenticated catalog -> 405
    const postCatalog = await fetch(`${base}/api/admin/catalog`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(postCatalog.status, 405);
    assert.equal(postCatalog.headers.get('allow'), 'GET, HEAD');

    // Admin static UI assets
    const adminHtmlRes = await fetch(`${base}/admin`);
    assert.equal(adminHtmlRes.status, 200);
    assertSecurityHeaders(adminHtmlRes);
    const adminHtml = await adminHtmlRes.text();
    assert.match(adminHtml, /<script src="assets\/js\/admin\.js"><\/script>/);
    assert.doesNotMatch(adminHtml, /assets\/js\/site\.js/);
    assert.doesNotMatch(adminHtml, /assets\/js\/products\.js/);
    assert.match(adminHtml, /role="alert"/);
    assert.match(adminHtml, /aria-live="polite"/);
    assert.match(adminHtml, /label for="adminPassword"/);

    const adminCssRes = await fetch(`${base}/assets/css/admin.css`);
    assert.equal(adminCssRes.status, 200);
    const adminJsRes = await fetch(`${base}/assets/js/admin.js`);
    assert.equal(adminJsRes.status, 200);

    // Logout clears cookie
    const logoutRes = await fetch(`${base}/api/admin/logout`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(logoutRes.status, 200);
    assert.deepEqual(await logoutRes.json(), { authenticated: false });
    const cleared = logoutRes.headers.get('set-cookie');
    assert.match(cleared, /Max-Age=0/);
  });

  it('supports product inline patching with stock/status invariants and order cancellation stock restore', async (t) => {
    const tmpDir = makeTempDir();
    const prevPw = process.env.RETROMOD_ADMIN_PASSWORD;
    const prevSec = process.env.RETROMOD_SESSION_SECRET;
    process.env.RETROMOD_ADMIN_PASSWORD = 'admin-ops-password';
    process.env.RETROMOD_SESSION_SECRET = 'admin-ops-secret';

    const store = storeModule.createStore({ dataDir: tmpDir });
    const server = await startServer({ port: 0, store });
    t.after(() => {
      server.close();
      if (prevPw === undefined) delete process.env.RETROMOD_ADMIN_PASSWORD;
      else process.env.RETROMOD_ADMIN_PASSWORD = prevPw;
      if (prevSec === undefined) delete process.env.RETROMOD_SESSION_SECRET;
      else process.env.RETROMOD_SESSION_SECRET = prevSec;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const base = `http://127.0.0.1:${server.address().port}`;
    const loginRes = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin-ops-password' })
    });
    const cookie = extractCookiePair(loginRes);

    // GET /api/admin/catalog
    const catRes = await fetch(`${base}/api/admin/catalog`, { headers: { Cookie: cookie } });
    assert.equal(catRes.status, 200);
    const catData = await catRes.json();
    assert.equal(catData.products.length, 5);
    assert.equal(catData.stats.availableCount, 5);

    // PATCH product valid update
    const patchOk = await fetch(`${base}/api/admin/products/nad-3020i`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ price: 4100, quantity: 2, status: 'reserved' })
    });
    assert.equal(patchOk.status, 200);
    const patchedBody = await patchOk.json();
    assert.equal(patchedBody.product.price, 4100);
    assert.equal(patchedBody.product.quantity, 2);
    assert.equal(patchedBody.product.status, 'reserved');

    // Coerce quantity: 0 + status: 'available' to sold invariant
    const patchZero = await fetch(`${base}/api/admin/products/nad-3020i`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ quantity: 0, status: 'available' })
    });
    assert.equal(patchZero.status, 200);
    const patchZeroBody = await patchZero.json();
    assert.equal(patchZeroBody.product.quantity, 0);
    assert.equal(patchZeroBody.product.status, 'sold');

    // Reject unsafe image path
    const patchBadImg = await fetch(`${base}/api/admin/products/nad-3020i`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ image: 'javascript:alert(1)' })
    });
    assert.equal(patchBadImg.status, 400);

    // Unknown product -> 404
    const patch404 = await fetch(`${base}/api/admin/products/does-not-exist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ price: 100 })
    });
    assert.equal(patch404.status, 404);

    // Create a real customer order via POST /api/orders for marantz-twenty-nine (qty 1 -> 0, status -> sold)
    const orderRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { name: 'Thabo Mokoena', email: 'thabo@example.com', phone: '082 555 1234' },
        fulfillment: 'collection',
        paymentMethod: 'eft',
        items: [{ id: 'marantz-twenty-nine', quantity: 1 }]
      })
    });
    assert.equal(orderRes.status, 201);
    const createdOrder = (await orderRes.json()).order;
    assert.equal(store.getProductById('marantz-twenty-nine').quantity, 0);
    assert.equal(store.getProductById('marantz-twenty-nine').status, 'sold');

    // List orders
    const ordersListRes = await fetch(`${base}/api/admin/orders`, { headers: { Cookie: cookie } });
    assert.equal(ordersListRes.status, 200);
    const ordersList = (await ordersListRes.json()).orders;
    assert.equal(ordersList.length, 1);
    assert.equal(ordersList[0].orderRef, createdOrder.orderRef);

    // Transition order -> confirmed
    const confirmRes = await fetch(`${base}/api/admin/orders/${createdOrder.orderRef}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ status: 'confirmed' })
    });
    assert.equal(confirmRes.status, 200);
    assert.equal((await confirmRes.json()).order.status, 'confirmed');

    // Invalid status -> 400
    const badOrderStatus = await fetch(`${base}/api/admin/orders/${createdOrder.orderRef}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ status: 'bogus_status' })
    });
    assert.equal(badOrderStatus.status, 400);

    // Cancel order -> restores stock atomically!
    const cancelRes1 = await fetch(`${base}/api/admin/orders/${createdOrder.orderRef}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ status: 'cancelled' })
    });
    assert.equal(cancelRes1.status, 200);
    const cancelled1 = (await cancelRes1.json()).order;
    assert.equal(cancelled1.status, 'cancelled');
    assert.ok(cancelled1.stockRestoredAt);
    assert.equal(store.getProductById('marantz-twenty-nine').quantity, 1);
    assert.equal(store.getProductById('marantz-twenty-nine').status, 'available');

    // Repeating cancelled PATCH does NOT double-restore stock
    const cancelRes2 = await fetch(`${base}/api/admin/orders/${createdOrder.orderRef}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ status: 'cancelled' })
    });
    assert.equal(cancelRes2.status, 200);
    assert.equal(store.getProductById('marantz-twenty-nine').quantity, 1);

    // Cannot reopen a cancelled order
    const reopenRes = await fetch(`${base}/api/admin/orders/${createdOrder.orderRef}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ status: 'confirmed' })
    });
    assert.equal(reopenRes.status, 409);
  });
});
