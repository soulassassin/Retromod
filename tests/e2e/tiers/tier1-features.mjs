import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apiRequest, loginAdminApi, buildValidOrderPayload } from '../helpers/api-client.mjs';
import {
  normText,
  attachErrorCollectors,
  waitForCatalogHydration,
  assertProductImagesHealthy
} from '../helpers/browser.mjs';
import { REPO_ROOT } from '../helpers/server.mjs';

const SEEDED_IDS = [
  'marantz-twenty-nine',
  'pioneer-sa-6300',
  'nad-3020i',
  'kartell-taj-lamp',
  'fujifilm-x100v'
];

export function getTier1Tests() {
  return [
    // ================= F1: Persistent Catalog Data Layer (5) =================
    {
      id: 'T1-F1-01',
      feature: 'F1',
      req: 'R1/AC1',
      name: 'Fresh RETROMOD_DATA_DIR seeds 5 products with required schema fields',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const res = await apiRequest(srv.baseUrl, '/api/products');
          assert.equal(res.status, 200);
          const products = res.json?.products;
          assert.ok(Array.isArray(products));
          assert.equal(products.length, 5);
          for (const id of SEEDED_IDS) {
            const p = products.find((x) => x.id === id);
            assert.ok(p, `Missing seeded product ${id}`);
            assert.ok(Number.isInteger(p.quantity) && p.quantity >= 1, `${id} quantity >= 1`);
            assert.equal(p.status, 'available');
            assert.ok(p.instagramUrl && p.instagramUrl.includes('instagram.com'), `${id} instagramUrl`);
            assert.ok(p.instagramShortcode, `${id} instagramShortcode`);
            assert.ok(p.image, `${id} image`);
            assert.ok(Array.isArray(p.specs) && p.specs.length > 0, `${id} specs`);
          }
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F1-02',
      feature: 'F1',
      req: 'R1/AC1',
      name: 'RETROMOD_DATA_DIR isolates mutations across separate server instances',
      async fn(ctx) {
        const srvA = await ctx.spawnServer();
        const srvB = await ctx.spawnServer();
        try {
          const orderRes = await apiRequest(srvA.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({ items: [{ id: 'marantz-twenty-nine', quantity: 1 }] })
          });
          assert.equal(orderRes.status, 201);

          const prodA = await apiRequest(srvA.baseUrl, '/api/products/marantz-twenty-nine');
          assert.equal(prodA.json.product.status, 'sold');
          assert.equal(prodA.json.product.quantity, 0);

          const prodB = await apiRequest(srvB.baseUrl, '/api/products/marantz-twenty-nine');
          assert.equal(prodB.json.product.status, 'available');
          assert.equal(prodB.json.product.quantity, 1);
        } finally {
          await Promise.all([srvA.stop(), srvB.stop()]);
        }
      }
    },
    {
      id: 'T1-F1-03',
      feature: 'F1',
      req: 'R1/AC1',
      name: 'GET /api/products returns accurate stats and categories matching catalog',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const res = await apiRequest(srv.baseUrl, '/api/products');
          assert.equal(res.status, 200);
          assert.ok(Array.isArray(res.json.categories));
          const catIds = res.json.categories.map((c) => (typeof c === 'string' ? c : c?.id));
          assert.ok(catIds.includes('audio'));
          assert.ok(catIds.includes('lighting'));
          assert.ok(catIds.includes('cameras'));
          assert.equal(res.json.stats.total, 5);
          assert.equal(res.json.stats.available, 5);
          assert.equal(res.json.stats.sold, 0);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F1-04',
      feature: 'F1',
      req: 'R1/AC1',
      name: 'Catalog mutations persist across server restart on same RETROMOD_DATA_DIR',
      async fn(ctx) {
        const srv1 = await ctx.spawnServer({ cleanupDataDir: false });
        const sharedDataDir = srv1.dataDir;
        try {
          const jar = await loginAdminApi(srv1.baseUrl, srv1.adminPassword);
          const patch = await apiRequest(srv1.baseUrl, '/api/admin/products/nad-3020i', {
            method: 'PATCH',
            body: { price: 4100 },
            jar
          });
          assert.equal(patch.status, 200);
          assert.equal(patch.json.product.price, 4100);
        } finally {
          await srv1.stop({ removeDataDir: false });
        }

        const srv2 = await ctx.spawnServer({ dataDir: sharedDataDir, cleanupDataDir: true });
        try {
          const res = await apiRequest(srv2.baseUrl, '/api/products/nad-3020i');
          assert.equal(res.status, 200);
          assert.equal(res.json.product.price, 4100);
        } finally {
          await srv2.stop({ removeDataDir: true });
        }
      }
    },
    {
      id: 'T1-F1-05',
      feature: 'F1',
      req: 'R1/AC1',
      name: 'Product schema invariant: available items have quantity > 0 and ISO updatedAt',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const res = await apiRequest(srv.baseUrl, '/api/products');
          assert.equal(res.status, 200);
          for (const p of res.json.products) {
            if (p.status === 'available') {
              assert.ok(p.quantity > 0, `${p.id} must have quantity > 0`);
            }
            assert.ok(!Number.isNaN(Date.parse(p.updatedAt)), `${p.id} invalid updatedAt: ${p.updatedAt}`);
          }
        } finally {
          await srv.stop();
        }
      }
    },

    // ================= F2: @retromod.za Product Images (6) =================
    {
      id: 'T1-F2-01',
      feature: 'F2',
      req: 'R3/AC4',
      name: 'Home page product and hero images load HTTP 200 with naturalWidth > 0',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.locator('main a[href*="product"]').first().waitFor({ state: 'visible', timeout: 8000 });
          await assertProductImagesHealthy(page, srv.baseUrl, { minCount: 3 });
          collector.assertClean('home');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F2-02',
      feature: 'F2',
      req: 'R3/AC4',
      name: 'Shop page renders all 5 products with non-broken local stock images',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.locator('main a[href*="product"]').first().waitFor({ state: 'visible', timeout: 8000 });
          const imgs = await assertProductImagesHealthy(page, srv.baseUrl, {
            selector: 'main a[href*="product"] img',
            minCount: 5
          });
          for (const img of imgs) {
            assert.ok(img.src.includes('assets/stock/'), `Expected local stock image, got ${img.src}`);
          }
          collector.assertClean('shop');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F2-03',
      feature: 'F2',
      req: 'R3/AC4',
      name: 'Product detail page renders healthy image for all 5 seeded products',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          for (const id of SEEDED_IDS) {
            await page.goto(`${srv.baseUrl}/product.html?id=${encodeURIComponent(id)}`, {
              waitUntil: 'domcontentloaded'
            });
            await waitForCatalogHydration(page);
            await page.locator('main h1').waitFor({ state: 'visible', timeout: 8000 });
            await assertProductImagesHealthy(page, srv.baseUrl, {
              selector: 'main article img, #pdImg img',
              minCount: 1
            });
          }
          collector.assertClean('product-all-5');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F2-04',
      feature: 'F2',
      req: 'R3/AC4',
      name: 'All 5 stock JPG endpoints serve HTTP 200 image/jpeg with > 10KB payload',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          for (const id of SEEDED_IDS) {
            const res = await fetch(`${srv.baseUrl}/assets/stock/${id}.jpg`);
            assert.equal(res.status, 200, `Stock JPG missing for ${id}`);
            const ctype = res.headers.get('content-type') || '';
            assert.ok(ctype.startsWith('image/jpeg'), `Expected image/jpeg for ${id}, got ${ctype}`);
            const buf = Buffer.from(await res.arrayBuffer());
            assert.ok(buf.length > 10 * 1024, `Expected >10KB JPG for ${id}, got ${buf.length}`);
          }
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F2-05',
      feature: 'F2',
      req: 'R3/AC4',
      name: 'product.html uses product.image contract supporting imported /media/ images',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const preview = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: { mode: 'urls', urls: [ctx.mockIg.urls.newAudio] },
            jar
          });
          assert.equal(preview.status, 200);
          const commit = await apiRequest(srv.baseUrl, '/api/admin/import/commit', {
            method: 'POST',
            body: { items: preview.json.items, downloadImages: true },
            jar
          });
          assert.equal(commit.status, 200);
          const imported = commit.json.products.find((p) => p.instagramShortcode === 'DfnNewAudio1');
          assert.ok(imported, 'Imported product not found');
          assert.ok(imported.image.includes('/media/'), `Expected /media/ image path, got ${imported.image}`);

          await page.goto(`${srv.baseUrl}/product.html?id=${encodeURIComponent(imported.id)}`, {
            waitUntil: 'domcontentloaded'
          });
          await waitForCatalogHydration(page);
          await page.locator('main h1').waitFor({ state: 'visible', timeout: 8000 });
          const imgs = await assertProductImagesHealthy(page, srv.baseUrl, {
            selector: 'main article img, #pdImg img',
            minCount: 1
          });
          assert.ok(imgs[0].src.includes('/media/'), `product.html ignored product.image: ${imgs[0].src}`);
          collector.assertClean('product-media-image');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F2-06',
      feature: 'F2',
      req: 'R3/AC4',
      name: 'About page reflects live catalog count and renders healthy showroom image',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/about`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await assertProductImagesHealthy(page, srv.baseUrl, { selector: 'main img', minCount: 1 });
          const bodyText = normText(await page.locator('main').innerText());
          assert.ok(bodyText.includes('5'), `Expected live count 5 on /about, got: ${bodyText}`);
          collector.assertClean('about');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },

    // ================= F3: Node Server & API Foundation (6) =================
    {
      id: 'T1-F3-01',
      feature: 'F3',
      req: 'R1/AC2',
      name: 'Server starts on custom PORT, /api/health returns 200, and package scripts exist',
      async fn(ctx) {
        if (!ctx.isContractMock) {
          const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
          assert.ok(pkg.scripts?.build, 'Expected build script in root package.json');
          assert.ok(pkg.scripts?.lint, 'Expected lint script in root package.json');
          assert.ok(pkg.scripts?.test, 'Expected test script in root package.json');
        }
        const srv = await ctx.spawnServer();
        try {
          const res = await apiRequest(srv.baseUrl, '/api/health');
          assert.equal(res.status, 200);
          assert.equal(res.json?.ok, true);
          assert.equal(res.json?.status, 'ok');
          assert.equal(res.json?.productCount, 5);
          assert.ok(!Number.isNaN(Date.parse(res.json?.timestamp)));
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F3-02',
      feature: 'F3',
      req: 'R1/AC1',
      name: 'All storefront and console HTML routes serve HTTP 200 text/html',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const routes = [
            '/',
            '/shop',
            '/shop.html',
            '/product.html?id=marantz-twenty-nine',
            '/about',
            '/contact',
            '/checkout',
            '/admin'
          ];
          for (const route of routes) {
            const res = await apiRequest(srv.baseUrl, route);
            assert.equal(res.status, 200, `Route ${route} returned ${res.status}`);
            const ctype = res.headers.get('content-type') || '';
            assert.ok(ctype.includes('text/html'), `Route ${route} Content-Type: ${ctype}`);
          }
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F3-03',
      feature: 'F3',
      req: 'R1/AC1',
      name: 'GET /api/products filters by category, q search, and status',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const audio = await apiRequest(srv.baseUrl, '/api/products?category=audio');
          assert.equal(audio.status, 200);
          assert.equal(audio.json.products.length, 3);
          assert.ok(audio.json.products.every((p) => p.category === 'audio'));

          const qRes = await apiRequest(srv.baseUrl, '/api/products?q=Marantz');
          assert.equal(qRes.status, 200);
          assert.equal(qRes.json.products.length, 1);
          assert.equal(qRes.json.products[0].id, 'marantz-twenty-nine');

          const avail = await apiRequest(srv.baseUrl, '/api/products?status=available');
          assert.equal(avail.status, 200);
          assert.equal(avail.json.products.length, 5);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F3-04',
      feature: 'F3',
      req: 'R1/AC1',
      name: 'GET /api/products/kartell-taj-lamp returns 200 with exact details',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const res = await apiRequest(srv.baseUrl, '/api/products/kartell-taj-lamp');
          assert.equal(res.status, 200);
          assert.equal(res.json.product.id, 'kartell-taj-lamp');
          assert.equal(res.json.product.price, 3850);
          assert.ok(
            res.json.product.instagramShortcode === 'DfnJqn-kduJ' ||
            res.json.product.instagramShortcode === 'DfnIlytkcNS'
          );
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F3-05',
      feature: 'F3',
      req: 'R1/AC1',
      name: 'Security headers present on both HTML and API responses',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          for (const route of ['/', '/api/products']) {
            const res = await apiRequest(srv.baseUrl, route);
            assert.equal(res.status, 200);
            assert.equal(
              res.headers.get('x-content-type-options'),
              'nosniff',
              `Missing X-Content-Type-Options on ${route}`
            );
            const hasFrame =
              Boolean(res.headers.get('x-frame-options')) ||
              /frame-ancestors/i.test(res.headers.get('content-security-policy') || '');
            assert.ok(hasFrame, `Missing frame protection header on ${route}`);
            assert.ok(res.headers.get('referrer-policy'), `Missing Referrer-Policy on ${route}`);
          }
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F3-06',
      feature: 'F3',
      req: 'R1/AC2',
      name: '_frame.html is removed from site/public and returns 404',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const r1 = await apiRequest(srv.baseUrl, '/_frame.html');
          const r2 = await apiRequest(srv.baseUrl, '/_frame');
          assert.equal(r1.status, 404);
          assert.equal(r2.status, 404);
        } finally {
          await srv.stop();
        }
      }
    },

    // ================= F4: Persistent Cart & Stock-Aware Validation (5) =================
    {
      id: 'T1-F4-01',
      feature: 'F4',
      req: 'R1/AC1',
      name: 'Add to Cart on product.html updates cart drawer with price, qty 1, and badge',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/product.html?id=marantz-twenty-nine`, {
            waitUntil: 'domcontentloaded'
          });
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();

          const drawer = page.getByRole('dialog');
          await drawer.waitFor({ state: 'visible', timeout: 5000 });
          const text = normText(await drawer.innerText());
          assert.ok(text.includes('Marantz Model Twenty Nine'), `Missing title in drawer: ${text}`);
          assert.ok(text.includes('R6 950'), `Missing R6 950 in drawer: ${text}`);
          const headerText = normText(await page.locator('header').innerText());
          assert.ok(headerText.includes('1'), `Expected badge 1 in header: ${headerText}`);
          collector.assertClean('cart-add');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F4-02',
      feature: 'F4',
      req: 'R1/AC1',
      name: 'Adding two different products updates cart subtotal accurately (R10 800)',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/product.html?id=marantz-twenty-nine`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();
          await page.waitForFunction(
            () => (document.querySelector('[role="dialog"]')?.innerText || '').includes('Marantz Model Twenty Nine'),
            null,
            { timeout: 5000 }
          );

          await page.goto(`${srv.baseUrl}/product.html?id=kartell-taj-lamp`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();

          const drawer = page.getByRole('dialog');
          await drawer.waitFor({ state: 'visible', timeout: 5000 });
          await page.waitForFunction(
            () => (document.querySelector('[role="dialog"]')?.innerText || '').replace(/[\s\u00a0\u202f]+/g, ' ').includes('R10 800'),
            null,
            { timeout: 5000 }
          );
          const text = normText(await drawer.innerText());
          assert.ok(text.includes('Marantz Model Twenty Nine'));
          assert.ok(text.includes('Kartell Taj'));
          assert.ok(text.includes('R10 800'), `Expected R10 800 subtotal, got: ${text}`);
          collector.assertClean('cart-two-items');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F4-03',
      feature: 'F4',
      req: 'R1/AC1',
      name: 'Cart persists across full page reload and navigation to /about via localStorage',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/product.html?id=nad-3020i`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();
          await page.waitForFunction(
            () => (document.querySelector('[role="dialog"]')?.innerText || '').includes('NAD 3020i'),
            null,
            { timeout: 5000 }
          );

          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.goto(`${srv.baseUrl}/about`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);

          await page.locator('header').getByRole('button', { name: /cart|bag/i }).click();
          const drawer = page.getByRole('dialog');
          await drawer.waitFor({ state: 'visible', timeout: 5000 });
          const text = normText(await drawer.innerText());
          assert.ok(text.includes('NAD 3020i'), `Expected persisted NAD 3020i, got: ${text}`);
          collector.assertClean('cart-persist');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F4-04',
      feature: 'F4',
      req: 'R1/AC1',
      name: 'Cart quantity increment and remove controls update subtotal and empty state',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          await apiRequest(srv.baseUrl, '/api/admin/products/nad-3020i', {
            method: 'PATCH',
            body: { quantity: 3 },
            jar
          });

          await page.goto(`${srv.baseUrl}/product.html?id=nad-3020i`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();

          const drawer = page.getByRole('dialog');
          await drawer.waitFor({ state: 'visible', timeout: 5000 });
          await drawer.getByRole('button', { name: /\+|increase/i }).click();
          await page.waitForFunction(
            () => (document.querySelector('[role="dialog"]')?.innerText || '').replace(/[\s\u00a0\u202f]+/g, ' ').includes('R7 500'),
            null,
            { timeout: 5000 }
          );

          await drawer.getByRole('button', { name: /remove/i }).click();
          await page.waitForFunction(
            () => /empty/i.test(document.querySelector('[role="dialog"]')?.innerText || ''),
            null,
            { timeout: 5000 }
          );
          collector.assertClean('cart-qty-remove');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F4-05',
      feature: 'F4',
      req: 'R1/AC1',
      name: 'Cart drawer revalidates against live /api/products on open and reflects updated price',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/product.html?id=nad-3020i`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();
          await page.getByRole('dialog').waitFor({ state: 'visible' });

          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          await apiRequest(srv.baseUrl, '/api/admin/products/nad-3020i', {
            method: 'PATCH',
            body: { price: 4150 },
            jar
          });

          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.locator('header').getByRole('button', { name: /cart|bag/i }).click();
          const drawer = page.getByRole('dialog');
          await drawer.waitFor({ state: 'visible' });
          await page.waitForFunction(
            () => (document.querySelector('[role="dialog"]')?.innerText || '').replace(/[\s\u00a0\u202f]+/g, ' ').includes('R4 150'),
            null,
            { timeout: 5000 }
          );
          collector.assertClean('cart-revalidate');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },

    // ================= F5: Checkout, Order Capture & Atomic Stock (5) =================
    {
      id: 'T1-F5-01',
      feature: 'F5',
      req: 'R1/AC1',
      name: 'POST /api/orders collection returns 201, zero shipping, and marks 1-of-1 item sold',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const res = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({
              fulfillment: 'collection',
              paymentMethod: 'eft',
              items: [{ id: 'marantz-twenty-nine', quantity: 1 }]
            })
          });
          assert.equal(res.status, 201);
          const order = res.json.order;
          assert.ok(order.orderRef, 'Missing orderRef');
          assert.ok(order.accessToken, 'Missing accessToken');
          assert.equal(order.shippingZar, 0);
          assert.equal(order.subtotalZar, 6950);
          assert.equal(order.totalZar, 6950);

          const prod = await apiRequest(srv.baseUrl, '/api/products/marantz-twenty-nine');
          assert.equal(prod.json.product.quantity, 0);
          assert.equal(prod.json.product.status, 'sold');
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F5-02',
      feature: 'F5',
      req: 'R1/AC1',
      name: 'POST /api/orders SA delivery returns 201 with computed shipping and total',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const res = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({
              fulfillment: 'delivery',
              shippingAddress: {
                street: '14 Kloof Street',
                suburb: 'Gardens',
                city: 'Cape Town',
                province: 'Western Cape',
                postalCode: '8001'
              },
              items: [{ id: 'kartell-taj-lamp', quantity: 1 }]
            })
          });
          assert.equal(res.status, 201);
          const order = res.json.order;
          assert.equal(order.subtotalZar, 3850);
          assert.ok(typeof order.shippingZar === 'number' && order.shippingZar >= 0);
          assert.equal(order.totalZar, order.subtotalZar + order.shippingZar);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F5-03',
      feature: 'F5',
      req: 'R1/AC1',
      name: 'GET /api/orders/:orderRef?token=<accessToken> returns matching order receipt',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const create = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({ items: [{ id: 'pioneer-sa-6300', quantity: 1 }] })
          });
          assert.equal(create.status, 201);
          const { orderRef, accessToken, totalZar } = create.json.order;

          const lookup = await apiRequest(
            srv.baseUrl,
            `/api/orders/${encodeURIComponent(orderRef)}?token=${encodeURIComponent(accessToken)}`
          );
          assert.equal(lookup.status, 200);
          assert.equal(lookup.json.order.orderRef, orderRef);
          assert.equal(lookup.json.order.totalZar, totalZar);
          assert.equal(lookup.json.order.items[0].id, 'pioneer-sa-6300');
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F5-04',
      feature: 'F5',
      req: 'R1/AC1',
      name: 'Checkout UI submission creates order and renders orderRef confirmation',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/product.html?id=marantz-twenty-nine`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();
          await page.getByRole('dialog').getByRole('link', { name: /checkout/i }).click();

          await page.waitForURL(/checkout/i);
          await waitForCatalogHydration(page);
          await page.getByRole('textbox', { name: /full name|name/i }).fill('Lerato Dlamini');
          await page.getByRole('textbox', { name: /email/i }).fill('lerato@example.co.za');
          await page.getByRole('textbox', { name: /phone|mobile/i }).fill('0821234567');
          await page.getByRole('radio', { name: /^(?!.*pay).*(collect|norwood)/i }).check();
          await page.getByRole('radio', { name: /eft|pay on collection/i }).first().check();
          await page.getByRole('button', { name: /place order|confirm|submit/i }).click();

          await page.waitForFunction(
            () => /RM-[A-Z0-9-]+/i.test(document.body.innerText || ''),
            null,
            { timeout: 8000 }
          );
          const bodyText = normText(await page.locator('main').innerText());
          assert.ok(/RM-[A-Z0-9-]+/i.test(bodyText), `Expected orderRef in receipt: ${bodyText}`);
          collector.assertClean('checkout-ui');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F5-05',
      feature: 'F5',
      req: 'R1/AC1',
      name: 'Preserved Instagram DM enquiry action remains accessible on product.html',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/product.html?id=marantz-twenty-nine`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          const dmControl = page.locator('[data-enquire], a[href*="ig.me"], button:has-text("DM")').first();
          await dmControl.waitFor({ state: 'visible', timeout: 5000 });
          collector.assertClean('product-dm-cta');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },

    // ================= F6: Storefront Production Readiness & Hydration (5) =================
    {
      id: 'T1-F6-01',
      feature: 'F6',
      req: 'R1/AC1',
      name: 'Zero console.error or pageerror across all public storefront pages',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          for (const route of ['/', '/shop', '/product.html?id=marantz-twenty-nine', '/about', '/contact', '/checkout']) {
            await page.goto(`${srv.baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
            await waitForCatalogHydration(page);
            collector.assertClean(route);
          }
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F6-02',
      feature: 'F6',
      req: 'R1/AC1',
      name: 'Dynamic hydration reflects admin PATCH immediately across Home, Shop, and Product',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const patch = await apiRequest(srv.baseUrl, '/api/admin/products/nad-3020i', {
            method: 'PATCH',
            body: { price: 4350 },
            jar
          });
          assert.equal(patch.status, 200);

          for (const route of ['/', '/shop', '/product.html?id=nad-3020i']) {
            await page.goto(`${srv.baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
            await waitForCatalogHydration(page);
            await page.waitForFunction(
              () => (document.querySelector('main')?.innerText || '').replace(/[\s\u00a0\u202f]+/g, ' ').includes('R4 350'),
              null,
              { timeout: 6000 }
            );
          }
          collector.assertClean('hydration');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F6-03',
      feature: 'F6',
      req: 'R1/AC1',
      name: 'Shop category filter, search input, and sort control filter hydrated catalog',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);

          await page.getByRole('tablist', { name: /category/i }).getByRole('tab', { name: /^audio/i }).click();
          await page.waitForFunction(
            () => document.querySelectorAll('main a[href*="product"]').length === 3,
            null,
            { timeout: 5000 }
          );

          await page.getByLabel(/sort/i).selectOption('low');
          const firstTitle = normText(await page.locator('main a[href*="product"]').first().innerText());
          assert.ok(firstTitle.includes('NAD 3020i'), `Expected lowest audio item NAD 3020i first, got: ${firstTitle}`);

          await page.getByLabel(/search/i).fill('Marantz');
          await page.waitForFunction(
            () => document.querySelectorAll('main a[href*="product"]').length === 1,
            null,
            { timeout: 5000 }
          );
          assert.ok(page.url().includes('cat=audio'), `Expected URL query sync, got ${page.url()}`);
          collector.assertClean('shop-filter-sort');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F6-04',
      feature: 'F6',
      req: 'R1/AC1',
      name: 'robots.txt and sitemap.xml return HTTP 200 with expected content',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const robots = await apiRequest(srv.baseUrl, '/robots.txt');
          assert.equal(robots.status, 200);
          assert.ok(/user-agent:/i.test(robots.text));

          const sitemap = await apiRequest(srv.baseUrl, '/sitemap.xml');
          assert.equal(sitemap.status, 200);
          assert.ok(/<urlset/i.test(sitemap.text));
          assert.ok(/shop/i.test(sitemap.text));
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F6-05',
      feature: 'F6',
      req: 'R1/AC1',
      name: 'Contact page intent buttons toggle aria-pressed and update message preview live',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/contact`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          const group = page.getByRole('group', { name: /what is this about/i });
          const sellBtn = group.getByRole('button', { name: /selling/i });
          await sellBtn.click();
          assert.equal(await sellBtn.getAttribute('aria-pressed'), 'true');
          await page.getByLabel(/message|tell us|looking for/i).fill('Pioneer SX-780 for sale');
          collector.assertClean('contact-intent');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },

    // ================= F7: Admin Auth & Inventory/Order Console (5) =================
    {
      id: 'T1-F7-01',
      feature: 'F7',
      req: 'R1/R2',
      name: 'Admin login sets HttpOnly SameSite=Lax cookie and authenticates session',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          assert.ok(jar.cookies.has('retromod_admin'), 'Missing retromod_admin cookie');

          const rawLogin = await fetch(`${srv.baseUrl}/api/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: srv.adminPassword })
          });
          const setCookie = rawLogin.headers.get('set-cookie') || '';
          assert.ok(/httponly/i.test(setCookie), `Expected HttpOnly cookie: ${setCookie}`);
          assert.ok(/samesite=lax/i.test(setCookie), `Expected SameSite=Lax cookie: ${setCookie}`);

          const sess = await apiRequest(srv.baseUrl, '/api/admin/session', { jar });
          assert.equal(sess.status, 200);
          assert.equal(sess.json.authenticated, true);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F7-02',
      feature: 'F7',
      req: 'R1/R2',
      name: 'Admin logout clears session and /api/admin/session returns false',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const logout = await apiRequest(srv.baseUrl, '/api/admin/logout', { method: 'POST', jar });
          assert.equal(logout.status, 200);
          assert.equal(logout.json.authenticated, false);

          const sess = await apiRequest(srv.baseUrl, '/api/admin/session', { jar });
          assert.equal(sess.status, 200);
          assert.equal(sess.json.authenticated, false);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F7-03',
      feature: 'F7',
      req: 'R1/R2',
      name: 'Admin catalog and product PATCH update price, quantity, and status',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const cat = await apiRequest(srv.baseUrl, '/api/admin/catalog', { jar });
          assert.equal(cat.status, 200);
          assert.equal(cat.json.products.length, 5);

          const patch = await apiRequest(srv.baseUrl, '/api/admin/products/pioneer-sa-6300', {
            method: 'PATCH',
            body: { price: 4250, quantity: 2, status: 'available' },
            jar
          });
          assert.equal(patch.status, 200);
          assert.equal(patch.json.product.price, 4250);
          assert.equal(patch.json.product.quantity, 2);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F7-04',
      feature: 'F7',
      req: 'R1/R2',
      name: 'Admin orders list and status transition (pending -> confirmed)',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const orderRes = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({ items: [{ id: 'kartell-taj-lamp', quantity: 1 }] })
          });
          assert.equal(orderRes.status, 201);
          const ref = orderRes.json.order.orderRef;

          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const list = await apiRequest(srv.baseUrl, '/api/admin/orders', { jar });
          assert.equal(list.status, 200);
          assert.ok(list.json.orders.some((o) => o.orderRef === ref));

          const patch = await apiRequest(srv.baseUrl, `/api/admin/orders/${encodeURIComponent(ref)}`, {
            method: 'PATCH',
            body: { status: 'confirmed' },
            jar
          });
          assert.equal(patch.status, 200);
          assert.equal(patch.json.order.status, 'confirmed');
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F7-05',
      feature: 'F7',
      req: 'R1/R2',
      name: '/admin UI login displays inventory, performs inline edit, and lists orders',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({ items: [{ id: 'fujifilm-x100v', quantity: 1 }] })
          });

          await page.goto(`${srv.baseUrl}/admin`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByLabel(/password/i).fill(srv.adminPassword);
          await page.getByRole('button', { name: /log in|sign in/i }).click();

          const nadRow = page
            .locator('[data-product-id="nad-3020i"], tr:has-text("NAD 3020i"), article:has-text("NAD 3020i"), li:has-text("NAD 3020i")')
            .first();
          await nadRow.waitFor({ state: 'visible', timeout: 8000 });
          const priceInput = nadRow.locator('input[type="number"]').first();
          await priceInput.fill('4199');
          await nadRow.getByRole('button', { name: /save|update/i }).click();

          await page.waitForFunction(
            async () => {
              const r = await fetch('/api/products/nad-3020i');
              const d = await r.json();
              return d.product?.price === 4199;
            },
            null,
            { timeout: 6000 }
          );

          const bodyText = normText(await page.locator('main').innerText());
          assert.ok(/RM-/i.test(bodyText), `Expected orderRef in /admin orders list: ${bodyText}`);
          collector.assertClean('admin-ui');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },

    // ================= F8: Assisted Instagram Stock Import Workflow (6) =================
    {
      id: 'T1-F8-01',
      feature: 'F8',
      req: 'R2/AC3',
      name: 'Import preview (mode=urls) extracts candidate from mock @retromod.za post without mutating catalog',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const preview = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: { mode: 'urls', urls: [ctx.mockIg.urls.newAudio] },
            jar
          });
          assert.equal(preview.status, 200);
          assert.equal(preview.json.items.length, 1);
          const row = preview.json.items[0];
          assert.equal(row.action, 'create');
          assert.ok(row.candidate.title.includes('Technics'), `Unexpected title: ${row.candidate.title}`);
          assert.equal(row.candidate.price, 12500);
          assert.equal(row.candidate.instagramShortcode, 'DfnNewAudio1');
          assert.ok(row.candidate.remoteImageUrl.includes('technics-1200.jpg'));

          // Ensure preview never mutates catalog
          const cat = await apiRequest(srv.baseUrl, '/api/products');
          assert.equal(cat.json.products.length, 5);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F8-02',
      feature: 'F8',
      req: 'R2/AC3',
      name: 'Import preview (mode=export) parses IG posts_1.json export fixture into candidates + summary',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const exportPayload = fs.readFileSync(path.join(ctx.fixturesDir, 'ig-posts-export.json'), 'utf8');
          const preview = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: { mode: 'export', payload: exportPayload },
            jar
          });
          assert.equal(preview.status, 200);
          assert.equal(preview.json.summary.total, 5);
          assert.ok(preview.json.summary.valid >= 2);
          assert.ok(preview.json.items.some((x) => x.action === 'create' && /Beogram 1700/i.test(x.candidate.title)));
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F8-03',
      feature: 'F8',
      req: 'R2/AC3',
      name: 'Import preview (mode=csv) parses ig-stock.csv fixture into structured candidates',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const csvPayload = fs.readFileSync(path.join(ctx.fixturesDir, 'ig-stock.csv'), 'utf8');
          const preview = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: { mode: 'csv', payload: csvPayload },
            jar
          });
          assert.equal(preview.status, 200);
          assert.equal(preview.json.summary.total, 5);
          assert.ok(preview.json.items.some((x) => x.action === 'create' && x.candidate.price === 4950));
          assert.ok(preview.json.items.some((x) => x.action === 'update' && x.candidate.instagramShortcode === 'DfnJqn-kduJ'));
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F8-04',
      feature: 'F8',
      req: 'R2/AC3',
      name: 'Import preview (mode=caption) parses @retromod.za caption batch text',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const captionPayload = fs.readFileSync(path.join(ctx.fixturesDir, 'ig-captions.txt'), 'utf8');
          const preview = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: { mode: 'caption', payload: captionPayload },
            jar
          });
          assert.equal(preview.status, 200);
          assert.equal(preview.json.summary.total, 5);
          assert.ok(preview.json.items.some((x) => x.action === 'create' && /Revox B77/i.test(x.candidate.title)));
          assert.ok(preview.json.items.some((x) => x.action === 'create' && /Louis Poulsen/i.test(x.candidate.title)));
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F8-05',
      feature: 'F8',
      req: 'R2/AC3',
      name: 'Import commit downloads remote image locally and serves it via HTTP 200 /media/<file>',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const preview = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: { mode: 'urls', urls: [ctx.mockIg.urls.newFurniture] },
            jar
          });
          assert.equal(preview.status, 200);
          const commit = await apiRequest(srv.baseUrl, '/api/admin/import/commit', {
            method: 'POST',
            body: { items: preview.json.items, downloadImages: true },
            jar
          });
          assert.equal(commit.status, 200);
          assert.equal(commit.json.created, 1);

          const imported = commit.json.products.find((p) => p.instagramShortcode === 'DfnNewFurn2');
          assert.ok(imported);
          assert.ok(imported.image.startsWith('/media/') || imported.image.startsWith('media/'));
          const imgPath = imported.image.startsWith('/') ? imported.image : `/${imported.image}`;
          const imgRes = await fetch(`${srv.baseUrl}${imgPath}`);
          assert.equal(imgRes.status, 200);
          assert.ok((imgRes.headers.get('content-type') || '').startsWith('image/'));
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T1-F8-06',
      feature: 'F8',
      req: 'R2/AC3',
      name: '/admin import UI previews URL, allows editing candidate field, commits, and updates /shop',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/admin`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByLabel(/password/i).fill(srv.adminPassword);
          await page.getByRole('button', { name: /log in|sign in/i }).click();

          const modeSel = page.getByLabel(/mode/i);
          if (await modeSel.count()) {
            await modeSel.selectOption('urls');
          }
          await page.getByLabel(/import|payload|urls/i).fill(ctx.mockIg.urls.newAudio);
          await page.getByRole('button', { name: /preview/i }).click();

          const firstRow = page.locator('[data-preview-row="0"], [data-preview-row]').first();
          await firstRow.waitFor({ state: 'visible', timeout: 8000 });
          const priceInput = firstRow.locator('input[type="number"]').first();
          await priceInput.fill('13200');

          await page.getByRole('button', { name: /commit|import/i }).click();
          await page.waitForFunction(
            async () => {
              const r = await fetch('/api/products');
              const d = await r.json();
              return d.products.some((p) => p.price === 13200);
            },
            null,
            { timeout: 8000 }
          );

          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          const shopText = normText(await page.locator('main').innerText());
          assert.ok(shopText.includes('Technics'), `Imported item not on /shop: ${shopText}`);
          assert.ok(shopText.includes('R13 200'), `Edited price not on /shop: ${shopText}`);
          collector.assertClean('admin-import-ui');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    }
  ];
}
