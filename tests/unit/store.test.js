'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const storeModule = require('../../lib/store');
const { startServer } = require('../../server');

function makeTempDir(prefix = 'retromod-m1-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function assertSecurityHeaders(res) {
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
}

describe('Store seeding, isolation & atomic persistence', () => {
  it('auto-seeds 5 products, orders.json, import-logs.json, and media/ in an empty dataDir', async (t) => {
    const tmpDir = makeTempDir();
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const store = storeModule.createStore({ dataDir: tmpDir });
    const catalog = store.getCatalog();

    assert.equal(catalog.products.length, 5);
    assert.equal(catalog.posts, 471);
    assert.equal(catalog.followers, 55.3);
    assert.equal(catalog.stats.total, 5);
    assert.equal(catalog.stats.availableCount, 5);
    assert.equal(catalog.stats.soldCount, 0);

    for (const p of catalog.products) {
      assert.equal(p.quantity, 1);
      assert.equal(p.status, 'available');
      assert.ok(Array.isArray(p.body) && p.body.length > 0);
      assert.ok(Array.isArray(p.specs) && p.specs.length > 0);
      assert.ok(p.instagramUrl.includes(p.instagramShortcode));
      assert.equal(p.image, `assets/stock/${p.id}.jpg`);
    }

    assert.ok(fs.existsSync(path.join(tmpDir, 'catalog.json')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'orders.json')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'import-logs.json')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'media')));
  });

  it('respects dynamic RETROMOD_DATA_DIR isolation without stale module state', async (t) => {
    const dirA = makeTempDir('retromod-a-');
    const dirB = makeTempDir('retromod-b-');
    const prevEnv = process.env.RETROMOD_DATA_DIR;
    t.after(() => {
      if (prevEnv === undefined) delete process.env.RETROMOD_DATA_DIR;
      else process.env.RETROMOD_DATA_DIR = prevEnv;
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    });

    process.env.RETROMOD_DATA_DIR = dirA;
    await storeModule.patchProduct('marantz-twenty-nine', { price: 7500 });
    assert.equal(storeModule.getProductById('marantz-twenty-nine').price, 7500);

    process.env.RETROMOD_DATA_DIR = dirB;
    assert.equal(storeModule.getProductById('marantz-twenty-nine').price, 6950);
  });

  it('persists mutations across store reloads and does not overwrite existing catalog.json', async (t) => {
    const tmpDir = makeTempDir();
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const store1 = storeModule.createStore({ dataDir: tmpDir });
    await store1.patchProduct('nad-3020i', { price: 4200, quantity: 0 });

    const store2 = storeModule.createStore({ dataDir: tmpDir });
    const nad = store2.getProductById('nad-3020i');
    assert.equal(nad.price, 4200);
    assert.equal(nad.quantity, 0);
    assert.equal(nad.status, 'sold');
  });

  it('enforces hard quantity/status invariants', async (t) => {
    const tmpDir = makeTempDir();
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const n1 = storeModule.normalizeProduct({ id: 'test-1', quantity: 0, status: 'available' });
    assert.equal(n1.quantity, 0);
    assert.equal(n1.status, 'sold');

    const n2 = storeModule.normalizeProduct({ id: 'test-2', quantity: -5, status: 'reserved' });
    assert.equal(n2.quantity, 0);
    assert.equal(n2.status, 'sold');

    const n3 = storeModule.normalizeProduct({ id: 'test-3', quantity: 3, status: 'sold' });
    assert.equal(n3.quantity, 0);
    assert.equal(n3.status, 'sold');

    const store = storeModule.createStore({ dataDir: tmpDir });
    const sold = await store.patchProduct('pioneer-sa-6300', { status: 'sold', quantity: 5 });
    assert.equal(sold.quantity, 0);
    assert.equal(sold.status, 'sold');

    const restocked = await store.patchProduct('pioneer-sa-6300', { quantity: 2 });
    assert.equal(restocked.quantity, 2);
    assert.equal(restocked.status, 'available');
  });

  it('serializes concurrent mutex transactions with zero oversell and zero .tmp leftovers', async (t) => {
    const tmpDir = makeTempDir();
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const store = storeModule.createStore({ dataDir: tmpDir });
    store.ensureStoreSync();

    const attempts = Array.from({ length: 20 }, () =>
      store.withTransaction(({ catalog }) => {
        const item = catalog.products.find(p => p.id === 'kartell-taj-lamp');
        if (!item || item.status === 'sold' || item.quantity < 1) {
          return { result: false };
        }
        item.quantity -= 1;
        if (item.quantity <= 0) {
          item.quantity = 0;
          item.status = 'sold';
        }
        return { saveCatalog: true, result: true };
      })
    );

    const results = await Promise.all(attempts);
    const successes = results.filter(Boolean).length;
    assert.equal(successes, 1);

    const lamp = store.getProductById('kartell-taj-lamp');
    assert.equal(lamp.quantity, 0);
    assert.equal(lamp.status, 'sold');

    const leftoverTmp = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(leftoverTmp, []);
  });
});

describe('HTTP Server, Public API, Media, Static & Security', () => {
  it('serves API endpoints, filtering, 501 stubs, static clean URLs, media, and security protections', async (t) => {
    const tmpDir = makeTempDir();
    const store = storeModule.createStore({ dataDir: tmpDir });
    store.ensureStoreSync();
    const sampleImg = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'public', 'assets', 'stock', 'kartell-taj-lamp.jpg'));
    fs.writeFileSync(path.join(tmpDir, 'media', 'sample.jpg'), sampleImg);

    const server = await startServer({ port: 0, dataDir: tmpDir });
    t.after(async () => {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    // /api/health GET & HEAD
    const healthRes = await fetch(`${base}/api/health`);
    assert.equal(healthRes.status, 200);
    assertSecurityHeaders(healthRes);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.status, 'ok');
    assert.equal(health.productCount, 5);
    assert.ok(typeof health.timestamp === 'string');

    const healthHead = await fetch(`${base}/api/health`, { method: 'HEAD' });
    assert.equal(healthHead.status, 200);
    assert.equal(await healthHead.text(), '');

    const healthPost = await fetch(`${base}/api/health`, { method: 'POST' });
    assert.equal(healthPost.status, 405);
    assert.equal(healthPost.headers.get('allow'), 'GET, HEAD');

    // /api/products filtering
    const allRes = await fetch(`${base}/api/products`);
    assert.equal(allRes.status, 200);
    const allJson = await allRes.json();
    assert.equal(allJson.products.length, 5);
    assert.equal(allJson.categories.length, 6);
    assert.ok(allJson.links.instagram);
    assert.equal(allJson.stats.total, 5);

    const audioJson = await (await fetch(`${base}/api/products?category=audio`)).json();
    assert.equal(audioJson.products.length, 3);

    const qJson = await (await fetch(`${base}/api/products?q=marantz`)).json();
    assert.equal(qJson.products.length, 1);
    assert.equal(qJson.products[0].id, 'marantz-twenty-nine');

    // apostrophe/diacritic/body/specs normalized search
    const searchCases = [
      ['Taj', ['kartell-taj-lamp']],
      ['\'Taj\'', ['kartell-taj-lamp']],
      ['\u2018Marantz\u2019', ['marantz-twenty-nine']],
      ['NAD\u2019s', ['nad-3020i']],
      ['NAD\'s', ['nad-3020i']],
      ['Fujifilm\u2019s', ['fujifilm-x100v']],
      ['philosophy', ['nad-3020i']],
      ['350mm', ['kartell-taj-lamp']]
    ];
    for (const [q, expectedIds] of searchCases) {
      const searchJson = await (await fetch(`${base}/api/products?q=${encodeURIComponent(q)}`)).json();
      assert.deepEqual(
        searchJson.products.map(p => p.id),
        expectedIds,
        `Unexpected search results for ?q=${q}`
      );
    }

    await store.patchProduct('fujifilm-x100v', { status: 'sold' });
    const soldJson = await (await fetch(`${base}/api/products?status=sold`)).json();
    assert.equal(soldJson.products.length, 1);
    assert.equal(soldJson.products[0].id, 'fujifilm-x100v');
    const availJson = await (await fetch(`${base}/api/products?status=available`)).json();
    assert.equal(availJson.products.length, 4);

    // /api/products/:id
    const oneRes = await fetch(`${base}/api/products/marantz-twenty-nine`);
    assert.equal(oneRes.status, 200);
    const oneJson = await oneRes.json();
    assert.equal(oneJson.product.id, 'marantz-twenty-nine');

    const missRes = await fetch(`${base}/api/products/does-not-exist`);
    assert.equal(missRes.status, 404);

    // Orders & Admin routes + unknown API route
    const orderEmpty = await fetch(`${base}/api/orders`, { method: 'POST' });
    assert.equal(orderEmpty.status, 400);
    const adminSess = await fetch(`${base}/api/admin/session`);
    assert.equal(adminSess.status, 200);
    const unknownApi = await fetch(`${base}/api/unknown-route`);
    assert.equal(unknownApi.status, 404);

    // Dynamic /assets/js/products.js reflects live catalog state
    const prodJsRes = await fetch(`${base}/assets/js/products.js`);
    assert.equal(prodJsRes.status, 200);
    assert.equal(prodJsRes.headers.get('cache-control'), 'no-store');
    const prodJsText = await prodJsRes.text();
    assert.ok(prodJsText.includes('window.RETROMOD ='));
    assert.ok(prodJsText.includes('"id":"fujifilm-x100v"') && prodJsText.includes('"status":"sold"'));

    // Static pages + clean URLs + security headers
    for (const route of ['/', '/shop', '/about', '/contact', '/product?id=marantz-twenty-nine']) {
      const pageRes = await fetch(`${base}${route}`);
      assert.equal(pageRes.status, 200, `Expected 200 for ${route}`);
      assertSecurityHeaders(pageRes);
      assert.ok(pageRes.headers.get('content-type').includes('text/html'));
    }

    // _frame.html must NOT be served
    const frameRes = await fetch(`${base}/_frame.html`);
    assert.equal(frameRes.status, 404);

    // All 5 stock images served locally as image/jpeg
    for (const id of ['marantz-twenty-nine', 'pioneer-sa-6300', 'nad-3020i', 'kartell-taj-lamp', 'fujifilm-x100v']) {
      const imgRes = await fetch(`${base}/assets/stock/${id}.jpg`);
      assert.equal(imgRes.status, 200, `Missing stock image ${id}`);
      assert.equal(imgRes.headers.get('content-type'), 'image/jpeg');
    }

    // All 8 local avatars served locally with 200
    const avatars = [
      '300f41b1-3de5-4153-afde-06e15e753ad0.webp',
      'bfff4cdf-4fda-4491-ada6-62f3b6236492.webp',
      '943b121e-fe72-479f-93ae-aa8cd1650f69.webp',
      'c673306f-2b81-4c3d-a7d2-3df61d481abb.webp',
      '2e4fcf11-d0fc-4f31-8f7a-dfe751777141.webp',
      'collector-8.svg',
      'c1fcd833-5ac9-41e9-9352-fead7e64fa24.webp',
      '4c2b3307-e555-4633-949c-efd3b7e09d82.webp'
    ];
    for (const av of avatars) {
      const avRes = await fetch(`${base}/assets/img/avatars/${av}`);
      assert.equal(avRes.status, 200, `Missing avatar ${av}`);
    }

    // /media/* serving
    const mediaRes = await fetch(`${base}/media/sample.jpg`);
    assert.equal(mediaRes.status, 200);
    assert.equal(mediaRes.headers.get('content-type'), 'image/jpeg');

    // Traversal & dotfile protection
    for (const badPath of [
      '/../../../package.json',
      '/%2e%2e/%2e%2e/package.json',
      '/media/%2e%2e/catalog.json',
      '/.env.local',
      '/.git/config'
    ]) {
      const r = await fetch(`${base}${badPath}`);
      assert.ok(r.status === 403 || r.status === 404, `Expected 403/404 for ${badPath}, got ${r.status}`);
    }
  });

  it('boots cleanly as a child process on PORT=4107 with isolated RETROMOD_DATA_DIR', async (t) => {
    const tmpDir = makeTempDir('retromod-cli-');
    const serverPath = path.resolve(__dirname, '..', '..', 'server.js');
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: '4107',
        RETROMOD_DATA_DIR: tmpDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    t.after(async () => {
      if (!child.killed) {
        child.kill('SIGTERM');
        await new Promise(resolve => child.once('exit', resolve));
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server boot timeout')), 5000);
      let out = '';
      child.stdout.on('data', chunk => {
        out += chunk.toString();
        if (out.includes('4107')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on('data', chunk => {
        out += chunk.toString();
      });
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`Server exited early (${code}): ${out}`));
      });
    });

    const res = await fetch('http://127.0.0.1:4107/api/health');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.productCount, 5);
    assertSecurityHeaders(res);
  });

  it('escapes < as \\u003c in dynamic /assets/js/products.js while preserving parsed JS data', async (t) => {
    const tmpDir = makeTempDir('retromod-xss-');
    const store = storeModule.createStore({ dataDir: tmpDir });
    const injection = 'NAD 3020i </script><script>alert(1)</script>';
    await store.patchProduct('nad-3020i', { title: injection });

    const server = await startServer({ port: 0, dataDir: tmpDir });
    t.after(async () => {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/assets/js/products.js`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text.includes('<'), false, 'Dynamic products.js must escape < as \\u003c');
    assert.ok(text.includes('\\u003c/script>'));

    const ctx = { window: {} };
    vm.runInNewContext(text, ctx);
    const nad = ctx.window.RETROMOD.products.find(p => p.id === 'nad-3020i');
    assert.equal(nad.title, injection);
  });
});
