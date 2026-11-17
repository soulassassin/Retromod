'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createStore } = require('../../lib/store');
const { startServer } = require('../../server');
const { SHIPPING_RATES, validateOrderInput } = require('../../lib/orders');

function makeTempDir(prefix = 'retromod-m2-orders-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function validCollectionOrder(items = [{ id: 'marantz-twenty-nine', quantity: 1 }]) {
  return {
    customer: {
      name: 'Thandi Mokoena',
      email: 'thandi@example.co.za',
      phone: '+27 82 555 0199'
    },
    fulfillment: 'collection',
    paymentMethod: 'eft',
    notes: 'Will collect Saturday morning.',
    items
  };
}

function validDeliveryOrder(items = [{ id: 'nad-3020i', quantity: 1 }]) {
  return {
    customer: {
      name: 'Liam van der Berg',
      email: 'liam@example.com',
      phone: '0831234567'
    },
    fulfillment: 'delivery',
    shippingAddress: {
      street: '14 Kloof Street',
      suburb: 'Gardens',
      city: 'Cape Town',
      province: 'Western Cape',
      postalCode: '8001'
    },
    paymentMethod: 'card_order_request',
    items
  };
}

async function setupServer(t) {
  const tmpDir = makeTempDir();
  const store = createStore({ dataDir: tmpDir });
  store.ensureStoreSync();
  const server = await startServer({ port: 0, dataDir: tmpDir });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const { port } = server.address();
  return { tmpDir, store, server, base: `http://127.0.0.1:${port}` };
}

describe('Orders API & Atomic Stock Transactions (M2)', () => {
  it('creates a Norwood collection order (R0 shipping), decrements stock, marks sold at 0, and retrieves receipt', async (t) => {
    const { store, base } = await setupServer(t);

    const res = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCollectionOrder())
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    const order = json.order;

    assert.ok(order);
    assert.match(order.orderRef, /^RM-\d{8}-[A-F0-9]{6,}$/);
    assert.match(order.accessToken, /^[a-f0-9]{48}$/);
    assert.equal(order.status, 'pending');
    assert.equal(order.fulfillment, 'collection');
    assert.equal(order.shippingAddress, null);
    assert.equal(order.paymentMethod, 'eft');
    assert.equal(order.subtotalZar, 6950);
    assert.equal(order.shippingZar, SHIPPING_RATES.collection);
    assert.equal(order.totalZar, 6950);
    assert.equal(order.items.length, 1);
    assert.deepEqual(order.items[0], {
      id: 'marantz-twenty-nine',
      title: 'Marantz Model Twenty Nine Stereo Receiver',
      price: 6950,
      quantity: 1,
      lineTotalZar: 6950,
      image: 'assets/stock/marantz-twenty-nine.jpg'
    });

    // Catalog persisted & invariant applied
    const updated = store.getProductById('marantz-twenty-nine');
    assert.equal(updated.quantity, 0);
    assert.equal(updated.status, 'sold');

    // Public catalog reflects sold state
    const prodRes = await fetch(`${base}/api/products/marantz-twenty-nine`);
    assert.equal(prodRes.status, 200);
    const prodJson = await prodRes.json();
    assert.equal(prodJson.product.status, 'sold');
    assert.equal(prodJson.product.quantity, 0);

    // Receipt lookup with valid token (GET & HEAD)
    const getRes = await fetch(`${base}/api/orders/${encodeURIComponent(order.orderRef)}?token=${order.accessToken}`);
    assert.equal(getRes.status, 200);
    const getJson = await getRes.json();
    assert.equal(getJson.order.orderRef, order.orderRef);
    assert.equal(getJson.order.totalZar, 6950);

    const headRes = await fetch(`${base}/api/orders/${encodeURIComponent(order.orderRef)}?token=${order.accessToken}`, {
      method: 'HEAD'
    });
    assert.equal(headRes.status, 200);
    assert.equal(await headRes.text(), '');
  });

  it('creates a nationwide SA delivery order (R250 shipping) and ignores tampered client prices/totals', async (t) => {
    const { store, base } = await setupServer(t);

    const payload = {
      ...validDeliveryOrder([{ id: 'nad-3020i', quantity: 1, price: 1, lineTotalZar: 1 }]),
      subtotalZar: 1,
      shippingZar: 0,
      totalZar: 1
    };

    const res = await fetch(`${base}/api/orders/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.equal(res.status, 201);
    const { order } = await res.json();

    assert.equal(order.fulfillment, 'delivery');
    assert.deepEqual(order.shippingAddress, {
      street: '14 Kloof Street',
      suburb: 'Gardens',
      city: 'Cape Town',
      province: 'Western Cape',
      postalCode: '8001'
    });
    assert.equal(order.subtotalZar, 3750);
    assert.equal(order.shippingZar, 250);
    assert.equal(order.totalZar, 4000);
    assert.equal(order.items[0].price, 3750);
    assert.equal(order.items[0].lineTotalZar, 3750);
    assert.equal(store.getProductById('nad-3020i').status, 'sold');
  });

  it('validates input fields with 400 { error, fields } without touching stock', async (t) => {
    const { store, base } = await setupServer(t);

    const badCases = [
      { label: 'empty object', body: {}, expectedFields: ['customer', 'fulfillment', 'paymentMethod', 'items'] },
      {
        label: 'invalid customer fields',
        body: {
          ...validCollectionOrder(),
          customer: { name: 'A', email: 'not-an-email', phone: '123' }
        },
        expectedFields: ['customer.name', 'customer.email', 'customer.phone']
      },
      {
        label: 'delivery without shippingAddress',
        body: {
          ...validCollectionOrder(),
          fulfillment: 'delivery'
        },
        expectedFields: ['shippingAddress']
      },
      {
        label: 'delivery with non-4-digit SA postal code and blank street',
        body: {
          ...validDeliveryOrder(),
          shippingAddress: { street: 'ab', suburb: '', city: 'C', province: '', postalCode: '80001' }
        },
        expectedFields: ['shippingAddress.street', 'shippingAddress.suburb', 'shippingAddress.city', 'shippingAddress.province', 'shippingAddress.postalCode']
      },
      {
        label: 'invalid paymentMethod',
        body: { ...validCollectionOrder(), paymentMethod: 'crypto' },
        expectedFields: ['paymentMethod']
      },
      {
        label: 'empty items',
        body: { ...validCollectionOrder([]) },
        expectedFields: ['items']
      },
      {
        label: 'zero and fractional item quantities',
        body: {
          ...validCollectionOrder([
            { id: 'marantz-twenty-nine', quantity: 0 },
            { id: 'nad-3020i', quantity: 1.5 }
          ])
        },
        expectedFields: ['items[0].quantity', 'items[1].quantity']
      }
    ];

    for (const tc of badCases) {
      const res = await fetch(`${base}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tc.body)
      });
      assert.equal(res.status, 400, `Expected 400 for ${tc.label}`);
      const json = await res.json();
      assert.ok(json.error);
      assert.ok(json.fields && typeof json.fields === 'object');
      for (const f of tc.expectedFields) {
        assert.ok(json.fields[f], `Missing field error ${f} for ${tc.label}`);
      }
    }

    // Invalid JSON and non-object JSON
    const badJson = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json'
    });
    assert.equal(badJson.status, 400);

    const arrJson = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]'
    });
    assert.equal(arrJson.status, 400);

    // No orders created, stock intact
    assert.equal(store.getOrders().length, 0);
    assert.equal(store.getProductById('marantz-twenty-nine').quantity, 1);
  });

  it('aggregates duplicate product IDs in items and rejects oversell with 409', async (t) => {
    const { store, base } = await setupServer(t);

    // Unit validation check for aggregation
    const parsed = validateOrderInput(validCollectionOrder([
      { id: 'nad-3020i', quantity: 1 },
      { id: 'nad-3020i', quantity: 2 }
    ]));
    assert.deepEqual(parsed.items, [{ id: 'nad-3020i', quantity: 3 }]);

    const res = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCollectionOrder([
        { id: 'marantz-twenty-nine', quantity: 1 },
        { id: 'marantz-twenty-nine', quantity: 1 }
      ]))
    });
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.itemId, 'marantz-twenty-nine');
    assert.equal(json.availableQuantity, 1);
    assert.equal(store.getProductById('marantz-twenty-nine').quantity, 1);
    assert.equal(store.getOrders().length, 0);
  });

  it('returns 404 for unknown item and 409 for sold/reserved items with all-or-nothing multi-item rollback', async (t) => {
    const { store, base } = await setupServer(t);

    // Unknown item -> 404
    const missRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCollectionOrder([{ id: 'nonexistent-piece', quantity: 1 }]))
    });
    assert.equal(missRes.status, 404);

    // Reserved item -> 409
    await store.patchProduct('pioneer-sa-6300', { status: 'reserved', quantity: 1 });
    const resvdRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCollectionOrder([{ id: 'pioneer-sa-6300', quantity: 1 }]))
    });
    assert.equal(resvdRes.status, 409);
    const resvdJson = await resvdRes.json();
    assert.equal(resvdJson.itemId, 'pioneer-sa-6300');
    assert.equal(resvdJson.availableQuantity, 0);

    // Multi-item rollback: first item available (quantity 2), second item sold -> 409 and first item untouched
    await store.patchProduct('kartell-taj-lamp', { status: 'available', quantity: 2 });
    await store.patchProduct('fujifilm-x100v', { status: 'sold' });

    const multiRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCollectionOrder([
        { id: 'kartell-taj-lamp', quantity: 1 },
        { id: 'fujifilm-x100v', quantity: 1 }
      ]))
    });
    assert.equal(multiRes.status, 409);
    const multiJson = await multiRes.json();
    assert.equal(multiJson.itemId, 'fujifilm-x100v');
    assert.equal(multiJson.availableQuantity, 0);

    // Rollback verified: kartell-taj-lamp still has quantity 2 and available status
    const lamp = store.getProductById('kartell-taj-lamp');
    assert.equal(lamp.quantity, 2);
    assert.equal(lamp.status, 'available');
    assert.equal(store.getOrders().length, 0);
  });

  it('prevents concurrent double-buy race across 15 parallel requests for a 1-of-1 piece', async (t) => {
    const { tmpDir, store, base } = await setupServer(t);

    const requests = Array.from({ length: 15 }, (_, idx) =>
      fetch(`${base}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validCollectionOrder([{ id: 'kartell-taj-lamp', quantity: 1 }]),
          customer: {
            name: `Buyer ${idx}`,
            email: `buyer${idx}@example.co.za`,
            phone: `08200000${String(idx).padStart(2, '0')}`
          }
        })
      })
    );

    const responses = await Promise.all(requests);
    const statuses = responses.map(r => r.status);
    assert.equal(statuses.filter(s => s === 201).length, 1);
    assert.equal(statuses.filter(s => s === 409).length, 14);

    const lamp = store.getProductById('kartell-taj-lamp');
    assert.equal(lamp.quantity, 0);
    assert.equal(lamp.status, 'sold');
    assert.equal(store.getOrders().length, 1);

    const leftoverTmp = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(leftoverTmp, []);
  });

  it('enforces method checks (405 Allow), path rules (404), receipt access tokens (403/404), and 413 payload limit', async (t) => {
    const { base } = await setupServer(t);

    // 405 on /api/orders
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      const r = await fetch(`${base}/api/orders`, { method });
      assert.equal(r.status, 405, `Expected 405 for ${method} /api/orders`);
      assert.equal(r.headers.get('allow'), 'POST');
    }

    // Create a real order first
    const createRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCollectionOrder())
    });
    assert.equal(createRes.status, 201);
    const { order } = await createRes.json();

    // 405 on /api/orders/:orderRef
    const postRef = await fetch(`${base}/api/orders/${order.orderRef}`, { method: 'POST' });
    assert.equal(postRef.status, 405);
    assert.equal(postRef.headers.get('allow'), 'GET, HEAD');

    // 404 on extra segments & unknown ref & malformed encoding
    assert.equal((await fetch(`${base}/api/orders/a/b`)).status, 404);
    assert.equal((await fetch(`${base}/api/orders/RM-99999999-AAAAAA?token=${order.accessToken}`)).status, 404);
    assert.equal((await fetch(`${base}/api/orders/%E0%A4%A`)).status, 400);

    // 403 on missing, wrong-length, or wrong-content token
    assert.equal((await fetch(`${base}/api/orders/${order.orderRef}`)).status, 403);
    assert.equal((await fetch(`${base}/api/orders/${order.orderRef}?token=short`)).status, 403);
    const flipped = (order.accessToken[0] === 'a' ? 'b' : 'a') + order.accessToken.slice(1);
    assert.equal((await fetch(`${base}/api/orders/${order.orderRef}?token=${flipped}`)).status, 403);

    // 413 oversized payload (> 64KB)
    const bigPayload = JSON.stringify({
      ...validCollectionOrder(),
      notes: 'x'.repeat(80 * 1024)
    });
    const oversizedOutcome = await new Promise((resolve, reject) => {
      const parsed = new URL(`${base}/api/orders`);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bigPayload, 'utf8')
        }
      }, res => {
        res.resume();
        resolve({ status: res.statusCode });
      });
      req.on('error', err => {
        // lib/http.js calls req.destroy() immediately on >64KB; either 413 response or socket teardown is valid
        if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
          resolve({ status: 413, destroyed: true });
        } else {
          reject(err);
        }
      });
      req.end(bigPayload);
    });
    assert.equal(oversizedOutcome.status, 413);
  });
});
