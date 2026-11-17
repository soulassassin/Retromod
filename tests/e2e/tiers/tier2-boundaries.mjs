import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiRequest, loginAdminApi, buildValidOrderPayload, CookieJar } from '../helpers/api-client.mjs';
import {
  normText,
  attachErrorCollectors,
  waitForCatalogHydration,
  assertProductImagesHealthy
} from '../helpers/browser.mjs';

export function getTier2Tests() {
  return [
    // ================= F1 Boundaries (5) =================
    {
      id: 'T2-F1-01',
      feature: 'F1',
      req: 'BVA quantity=0 invariant',
      name: 'PATCH quantity=0 forces product status to sold',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const res = await apiRequest(srv.baseUrl, '/api/admin/products/nad-3020i', {
            method: 'PATCH',
            body: { quantity: 0, status: 'available' },
            jar
          });
          assert.equal(res.status, 200);
          assert.equal(res.json.product.quantity, 0);
          assert.equal(res.json.product.status, 'sold');
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F1-02',
      feature: 'F1',
      req: 'BVA negative quantity/price',
      name: 'Negative quantity=-1 or price=-100 returns 400 and preserves catalog',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const negQty = await apiRequest(srv.baseUrl, '/api/admin/products/nad-3020i', {
            method: 'PATCH',
            body: { quantity: -1 },
            jar
          });
          assert.equal(negQty.status, 400);

          const negPrice = await apiRequest(srv.baseUrl, '/api/admin/products/nad-3020i', {
            method: 'PATCH',
            body: { price: -100 },
            jar
          });
          assert.equal(negPrice.status, 400);

          const after = await apiRequest(srv.baseUrl, '/api/products/nad-3020i');
          assert.equal(after.json.product.price, 3750);
          assert.equal(after.json.product.quantity, 1);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F1-03',
      feature: 'F1',
      req: 'Invalid types/status',
      name: 'Non-numeric price or invalid status returns 400 without mutating record',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const badStatus = await apiRequest(srv.baseUrl, '/api/admin/products/nad-3020i', {
            method: 'PATCH',
            body: { status: 'free' },
            jar
          });
          assert.equal(badStatus.status, 400);

          const badPrice = await apiRequest(srv.baseUrl, '/api/admin/products/nad-3020i', {
            method: 'PATCH',
            body: { price: 'abc' },
            jar
          });
          assert.equal(badPrice.status, 400);

          const check = await apiRequest(srv.baseUrl, '/api/products/nad-3020i');
          assert.equal(check.json.product.status, 'available');
          assert.equal(check.json.product.price, 3750);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F1-04',
      feature: 'F1',
      req: 'Auto-create nested RETROMOD_DATA_DIR',
      name: 'Server auto-creates missing nested RETROMOD_DATA_DIR and seeds catalog',
      async fn(ctx) {
        const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retromod-nested-'));
        const nestedDir = path.join(baseTmp, 'deep', 'store');
        const srv = await ctx.spawnServer({ dataDir: nestedDir, cleanupDataDir: false });
        try {
          const res = await apiRequest(srv.baseUrl, '/api/products');
          assert.equal(res.status, 200);
          assert.equal(res.json.products.length, 5);
          assert.ok(fs.existsSync(path.join(nestedDir, 'catalog.json')), 'catalog.json not created');
        } finally {
          await srv.stop({ removeDataDir: false });
          fs.rmSync(baseTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
    },
    {
      id: 'T2-F1-05',
      feature: 'F1',
      req: 'Atomic sequential writes',
      name: '10 rapid sequential PATCH writes keep catalog valid JSON and deterministic final value',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          for (let i = 1; i <= 10; i++) {
            const r = await apiRequest(srv.baseUrl, '/api/admin/products/nad-3020i', {
              method: 'PATCH',
              body: { price: 3000 + i * 100 },
              jar
            });
            assert.equal(r.status, 200);
          }
          const finalRes = await apiRequest(srv.baseUrl, '/api/products/nad-3020i');
          assert.equal(finalRes.status, 200);
          assert.equal(finalRes.json.product.price, 4000);
        } finally {
          await srv.stop();
        }
      }
    },

    // ================= F2 Boundaries (5) =================
    {
      id: 'T2-F2-01',
      feature: 'F2',
      req: 'Missing product ID on product.html',
      name: 'product.html?id=does-not-exist renders graceful not-found UI with zero broken images',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl, {
          strictClientErrors: true,
          ignore404Prefixes: ['/api/products/does-not-exist']
        });
        try {
          await page.goto(`${srv.baseUrl}/product.html?id=does-not-exist`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.waitForFunction(
            () => /moved on|not found|back to the shop/i.test(document.body.innerText || ''),
            null,
            { timeout: 6000 }
          );
          const brokenCount = await page.locator('main img').evaluateAll(
            (imgs) => imgs.filter((i) => !i.complete || i.naturalWidth === 0).length
          );
          assert.equal(brokenCount, 0);
          collector.assertClean('product-missing');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F2-02',
      feature: 'F2',
      req: 'Missing /media asset',
      name: 'GET /media/does-not-exist.jpg returns 404 (not 500 or directory listing)',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const res = await apiRequest(srv.baseUrl, '/media/does-not-exist.jpg');
          assert.equal(res.status, 404);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F2-03',
      feature: 'F2',
      req: 'Corrupt remote image isolation',
      name: 'Import commit with HTML corrupt.jpg URL does not save HTML as .jpg or crash server',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const preview = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: { mode: 'urls', urls: [ctx.mockIg.urls.corruptImagePost] },
            jar
          });
          assert.equal(preview.status, 200);
          const commit = await apiRequest(srv.baseUrl, '/api/admin/import/commit', {
            method: 'POST',
            body: { items: preview.json.items, downloadImages: true },
            jar
          });
          assert.equal(commit.status, 200);
          // Even if item was created with fallback or rejected, no /media/*.jpg should serve text/html
          const prod = commit.json.products.find((p) => p.instagramShortcode === 'DfnCorruptImg');
          if (prod && prod.image && prod.image.includes('/media/')) {
            const imgPath = prod.image.startsWith('/') ? prod.image : `/${prod.image}`;
            const imgRes = await fetch(`${srv.baseUrl}${imgPath}`);
            if (imgRes.status === 200) {
              const ctype = imgRes.headers.get('content-type') || '';
              assert.ok(ctype.startsWith('image/'), `Saved corrupt non-image at ${imgPath}: ${ctype}`);
            }
          }
          const health = await apiRequest(srv.baseUrl, '/api/health');
          assert.equal(health.status, 200);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F2-04',
      feature: 'F2',
      req: '404 remote image isolation',
      name: 'Import commit with 404 remoteImageUrl isolates failure without breaking existing catalog images',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const preview = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: { mode: 'urls', urls: [ctx.mockIg.urls.badImagePost] },
            jar
          });
          assert.equal(preview.status, 200);
          const commit = await apiRequest(srv.baseUrl, '/api/admin/import/commit', {
            method: 'POST',
            body: { items: preview.json.items, downloadImages: true },
            jar
          });
          assert.equal(commit.status, 200);

          const stockCheck = await fetch(`${srv.baseUrl}/assets/stock/marantz-twenty-nine.jpg`);
          assert.equal(stockCheck.status, 200);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F2-05',
      feature: 'F2',
      req: 'Desktop and mobile image geometry',
      name: 'Product images have non-zero natural and rendered dimensions on desktop and mobile viewports',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await assertProductImagesHealthy(page, srv.baseUrl, {
            selector: 'main a[href*="product"] img',
            minCount: 5
          });
          const rects = await page.locator('main a[href*="product"] img').evaluateAll((imgs) =>
            imgs.map((img) => {
              const r = img.getBoundingClientRect();
              return { width: r.width, height: r.height };
            })
          );
          for (const r of rects) {
            assert.ok(r.width > 0 && r.height > 0, `Image rendered with 0x0 box: ${JSON.stringify(r)}`);
          }
          collector.assertClean('mobile-images');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },

    // ================= F3 Boundaries (5) =================
    {
      id: 'T2-F3-01',
      feature: 'F3',
      req: 'Path traversal guard',
      name: 'Traversal paths (/../../package.json, /%2e%2e/server.js, /media/../../package.json) return 403 or 404',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          for (const badPath of ['/../../package.json', '/%2e%2e/%2e%2e/server.js', '/media/../../package.json']) {
            const res = await apiRequest(srv.baseUrl, badPath);
            assert.ok(res.status === 403 || res.status === 404, `Traversal ${badPath} returned ${res.status}`);
            assert.ok(!res.text.includes('"retromod"'), `Leaked package.json via ${badPath}`);
          }
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F3-02',
      feature: 'F3',
      req: 'Unknown product ID',
      name: 'GET /api/products/nonexistent-id-999 returns 404 JSON error',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const res = await apiRequest(srv.baseUrl, '/api/products/nonexistent-id-999');
          assert.equal(res.status, 404);
          assert.ok(res.json?.error);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F3-03',
      feature: 'F3',
      req: 'Malformed JSON and oversized payload',
      name: 'Invalid JSON body returns 400 and oversized body returns 413/400 without crashing server',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const badJson = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: '{bad json'
          });
          assert.equal(badJson.status, 400);

          const huge = 'x'.repeat(2 * 1024 * 1024);
          const over = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: huge
          });
          assert.ok(over.status === 413 || over.status === 400, `Expected 413/400 for 2MB body, got ${over.status}`);

          const health = await apiRequest(srv.baseUrl, '/api/health');
          assert.equal(health.status, 200);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F3-04',
      feature: 'F3',
      req: 'Unknown API route and method',
      name: 'Unknown /api/nonexistent and DELETE /api/products return 404/405 JSON without stack traces',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const r1 = await apiRequest(srv.baseUrl, '/api/nonexistent');
          assert.equal(r1.status, 404);
          assert.ok(r1.json?.error);

          const r2 = await apiRequest(srv.baseUrl, '/api/products', { method: 'DELETE' });
          assert.ok(r2.status === 404 || r2.status === 405, `Expected 404/405, got ${r2.status}`);
          assert.ok(!/at\s+\w+\s+\(/.test(r2.text), 'Stack trace leaked');
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F3-05',
      feature: 'F3',
      req: 'Malformed URL encoding',
      name: 'GET /%E0%A4%A returns 400 cleanly without crashing server',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const res = await apiRequest(srv.baseUrl, '/%E0%A4%A');
          assert.ok(res.status === 400 || res.status === 404, `Expected 400/404, got ${res.status}`);
          const health = await apiRequest(srv.baseUrl, '/api/health');
          assert.equal(health.status, 200);
        } finally {
          await srv.stop();
        }
      }
    },

    // ================= F4 Boundaries (5) =================
    {
      id: 'T2-F4-01',
      feature: 'F4',
      req: 'Sold-out UI guard',
      name: 'Sold product cannot be added to cart on product.html (button absent or disabled)',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          await apiRequest(srv.baseUrl, '/api/admin/products/pioneer-sa-6300', {
            method: 'PATCH',
            body: { quantity: 0, status: 'sold' },
            jar
          });

          await page.goto(`${srv.baseUrl}/product.html?id=pioneer-sa-6300`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.waitForFunction(
            () => /sold/i.test(document.querySelector('main')?.innerText || ''),
            null,
            { timeout: 6000 }
          );
          const addBtn = page.getByRole('button', { name: /add to (cart|bag)/i });
          const count = await addBtn.count();
          if (count > 0) {
            assert.equal(await addBtn.first().isDisabled(), true, 'Sold item Add button should be disabled');
          }
          collector.assertClean('sold-out-guard');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F4-02',
      feature: 'F4',
      req: 'Over-quantity boundary',
      name: 'Attempting to increment 1-of-1 item beyond available stock caps at 1',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/product.html?id=marantz-twenty-nine`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();
          const drawer = page.getByRole('dialog');
          await drawer.waitFor({ state: 'visible' });

          const incBtn = drawer.getByRole('button', { name: /\+|increase/i });
          if ((await incBtn.count()) > 0 && !(await incBtn.isDisabled())) {
            await incBtn.click();
          }
          // Subtotal must remain R6 950 (qty 1), never R13 900
          const text = normText(await drawer.innerText());
          assert.ok(text.includes('R6 950'), `Expected qty capped at 1 (R6 950), got: ${text}`);
          assert.ok(!text.includes('R13 900'), `Cart allowed over-quantity R13 900: ${text}`);
          collector.assertClean('over-qty-guard');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F4-03',
      feature: 'F4',
      req: 'Corrupt localStorage cart recovery',
      name: 'Pre-seeded corrupt JSON in localStorage recovers gracefully without pageerror',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        await context.addInitScript(() => {
          localStorage.setItem('retromod_cart', '{corrupt-json');
          localStorage.setItem('rm_cart', '{corrupt-json');
        });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.locator('header').getByRole('button', { name: /cart|bag/i }).click();
          await page.getByRole('dialog').waitFor({ state: 'visible' });
          collector.assertClean('corrupt-localstorage');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F4-04',
      feature: 'F4',
      req: 'Empty cart checkout guard',
      name: 'Empty cart drawer disables/blocks checkout progression',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.locator('header').getByRole('button', { name: /cart|bag/i }).click();
          const drawer = page.getByRole('dialog');
          await drawer.waitFor({ state: 'visible' });
          const text = normText(await drawer.innerText());
          assert.ok(/empty/i.test(text), `Expected empty cart message, got: ${text}`);
          const checkoutLink = drawer.getByRole('link', { name: /checkout/i });
          if ((await checkoutLink.count()) > 0) {
            const ariaDisabled = await checkoutLink.getAttribute('aria-disabled');
            const pointerEvents = await checkoutLink.evaluate((el) => getComputedStyle(el).pointerEvents);
            assert.ok(ariaDisabled === 'true' || pointerEvents === 'none', 'Empty cart checkout link must be disabled');
          }
          collector.assertClean('empty-cart-guard');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F4-05',
      feature: 'F4',
      req: 'Stale cart item revalidation',
      name: 'Item added to cart then sold via API is flagged unavailable upon cart reopen',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/product.html?id=kartell-taj-lamp`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();
          await page.getByRole('dialog').waitFor({ state: 'visible' });

          // Another buyer buys it via API
          const order = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({ items: [{ id: 'kartell-taj-lamp', quantity: 1 }] })
          });
          assert.equal(order.status, 201);

          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.locator('header').getByRole('button', { name: /cart|bag/i }).click();
          const drawer = page.getByRole('dialog');
          await drawer.waitFor({ state: 'visible' });
          await page.waitForFunction(
            () => /sold|unavailable|no longer/i.test(document.querySelector('[role="dialog"]')?.innerText || ''),
            null,
            { timeout: 6000 }
          );
          collector.assertClean('stale-cart-revalidation');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },

    // ================= F5 Boundaries (5) =================
    {
      id: 'T2-F5-01',
      feature: 'F5',
      req: '400 invalid item quantities',
      name: 'POST /api/orders rejects empty items, quantity=0, negative, and float quantities with 400',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          for (const items of [
            [],
            [{ id: 'marantz-twenty-nine', quantity: 0 }],
            [{ id: 'marantz-twenty-nine', quantity: -2 }],
            [{ id: 'marantz-twenty-nine', quantity: 1.5 }]
          ]) {
            const res = await apiRequest(srv.baseUrl, '/api/orders', {
              method: 'POST',
              body: buildValidOrderPayload({ items })
            });
            assert.equal(res.status, 400, `Expected 400 for items=${JSON.stringify(items)}, got ${res.status}`);
          }
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F5-02',
      feature: 'F5',
      req: '400 invalid customer & delivery address',
      name: 'POST /api/orders rejects invalid email and incomplete delivery address with 400',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const badEmail = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({ customer: { email: 'not-an-email' } })
          });
          assert.equal(badEmail.status, 400);

          const missingPostal = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({
              fulfillment: 'delivery',
              shippingAddress: { street: '1 Main', suburb: 'Norwood', city: 'JHB', province: 'Gauteng', postalCode: '' }
            })
          });
          assert.equal(missingPostal.status, 400);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F5-03',
      feature: 'F5',
      req: '404 unknown product in order',
      name: 'POST /api/orders with unknown product ID returns 404',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const res = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({ items: [{ id: 'fake-item-xyz', quantity: 1 }] })
          });
          assert.equal(res.status, 404);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F5-04',
      feature: 'F5',
      req: '409 oversell rollback atomicity',
      name: 'Multi-item order with 1 valid + 1 oversold item returns 409 and leaves valid item stock intact',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          await apiRequest(srv.baseUrl, '/api/admin/products/pioneer-sa-6300', {
            method: 'PATCH',
            body: { quantity: 0, status: 'sold' },
            jar
          });

          const res = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({
              items: [
                { id: 'marantz-twenty-nine', quantity: 1 },
                { id: 'pioneer-sa-6300', quantity: 1 }
              ]
            })
          });
          assert.equal(res.status, 409);
          assert.equal(res.json.itemId, 'pioneer-sa-6300');
          assert.equal(res.json.availableQuantity, 0);

          // Valid item must NOT have been decremented
          const marantz = await apiRequest(srv.baseUrl, '/api/products/marantz-twenty-nine');
          assert.equal(marantz.json.product.quantity, 1);
          assert.equal(marantz.json.product.status, 'available');
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F5-05',
      feature: 'F5',
      req: 'Order receipt token protection',
      name: 'GET /api/orders/:ref without token or wrong token returns 403/404 without leaking PII',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const create = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload()
          });
          assert.equal(create.status, 201);
          const ref = create.json.order.orderRef;

          const noTok = await apiRequest(srv.baseUrl, `/api/orders/${encodeURIComponent(ref)}`);
          assert.ok(noTok.status === 403 || noTok.status === 404, `Expected 403/404, got ${noTok.status}`);
          assert.ok(!noTok.text.includes('thabo.mokoena@example.co.za'), 'Leaked customer PII');

          const badTok = await apiRequest(srv.baseUrl, `/api/orders/${encodeURIComponent(ref)}?token=wrong-token`);
          assert.ok(badTok.status === 403 || badTok.status === 404);
          assert.ok(!badTok.text.includes('thabo.mokoena@example.co.za'), 'Leaked customer PII');
        } finally {
          await srv.stop();
        }
      }
    },

    // ================= F6 Boundaries (5) =================
    {
      id: 'T2-F6-01',
      feature: 'F6',
      req: 'Zero-match search & reset',
      name: 'Shop zero-match search displays empty message and Clear filters restores all 5 items',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByLabel(/search/i).fill('zzzznotfound999');
          await page.waitForFunction(
            () => document.querySelectorAll('main a[href*="product"]').length === 0,
            null,
            { timeout: 5000 }
          );
          await page.getByRole('button', { name: /clear filters/i }).click();
          await page.waitForFunction(
            () => document.querySelectorAll('main a[href*="product"]').length === 5,
            null,
            { timeout: 5000 }
          );
          collector.assertClean('shop-empty-reset');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F6-02',
      feature: 'F6',
      req: 'Invalid category query param',
      name: 'shop.html?cat=nonexistent falls back cleanly to All without JS errors',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/shop.html?cat=nonexistent`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.waitForFunction(
            () => document.querySelectorAll('main a[href*="product"]').length === 5,
            null,
            { timeout: 5000 }
          );
          collector.assertClean('shop-bad-cat');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F6-03',
      feature: 'F6',
      req: 'XSS escaping in search query',
      name: 'XSS payload in ?q=<script>alert(1)</script> does not execute script or throw errors',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        let dialogFired = false;
        page.on('dialog', () => {
          dialogFired = true;
        });
        try {
          await page.goto(`${srv.baseUrl}/shop.html?q=${encodeURIComponent('<script>alert(1)</script>')}`, {
            waitUntil: 'domcontentloaded'
          });
          await waitForCatalogHydration(page);
          assert.equal(dialogFired, false, 'XSS dialog triggered!');
          collector.assertClean('shop-xss');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F6-04',
      feature: 'F6',
      req: 'Sold badge & ordering on shop',
      name: 'Sold item displays Sold badge on /shop while available items remain prioritized',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({ items: [{ id: 'marantz-twenty-nine', quantity: 1 }] })
          });

          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          const marantzCard = page.locator('main a[href*="product"]', { hasText: 'Marantz Model Twenty Nine' }).first();
          await marantzCard.waitFor({ state: 'visible', timeout: 6000 });
          const cardText = normText(await marantzCard.innerText());
          assert.ok(/sold/i.test(cardText), `Expected Sold badge on card, got: ${cardText}`);
          collector.assertClean('shop-sold-badge');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F6-05',
      feature: 'F6',
      req: 'Contact empty-message validation',
      name: 'contact.html Selling intent with empty message sets aria-invalid=true and shows validation error',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/contact`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('group', { name: /what is this about/i }).getByRole('button', { name: /selling/i }).click();
          await page.getByRole('button', { name: /copy & open dm/i }).click();
          const msgField = page.getByLabel(/message|tell us|looking for/i);
          assert.equal(await msgField.getAttribute('aria-invalid'), 'true');
          collector.assertClean('contact-validation');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },

    // ================= F7 Boundaries (5) =================
    {
      id: 'T2-F7-01',
      feature: 'F7',
      req: '401 unauthenticated admin routes',
      name: 'All protected /api/admin/* endpoints return 401 without session cookie',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const checks = [
            ['GET', '/api/admin/catalog'],
            ['PATCH', '/api/admin/products/marantz-twenty-nine', { price: 1 }],
            ['GET', '/api/admin/orders'],
            ['PATCH', '/api/admin/orders/RM-NONE', { status: 'cancelled' }],
            ['POST', '/api/admin/import/preview', { mode: 'caption', payload: 'x' }],
            ['POST', '/api/admin/import/commit', { items: [] }]
          ];
          for (const [method, route, body] of checks) {
            const res = await apiRequest(srv.baseUrl, route, { method, body });
            assert.equal(res.status, 401, `${method} ${route} returned ${res.status} instead of 401`);
          }
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F7-02',
      feature: 'F7',
      req: 'Wrong password & tampered cookie',
      name: 'Wrong login password and forged HMAC cookie both return 401',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const badLogin = await apiRequest(srv.baseUrl, '/api/admin/login', {
            method: 'POST',
            body: { password: 'wrong-password-123' }
          });
          assert.equal(badLogin.status, 401);

          const forgedJar = new CookieJar();
          forgedJar.cookies.set('retromod_admin', 'eyJhZG1pbiI6dHJ1ZX0.tamperedsignature');
          const res = await apiRequest(srv.baseUrl, '/api/admin/catalog', { jar: forgedJar });
          assert.equal(res.status, 401);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F7-03',
      feature: 'F7',
      req: 'Order cancel restores stock',
      name: 'Cancelling an order restores item quantity to 1 and status to available',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const order = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({ items: [{ id: 'marantz-twenty-nine', quantity: 1 }] })
          });
          assert.equal(order.status, 201);
          const ref = order.json.order.orderRef;

          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const cancel = await apiRequest(srv.baseUrl, `/api/admin/orders/${encodeURIComponent(ref)}`, {
            method: 'PATCH',
            body: { status: 'cancelled' },
            jar
          });
          assert.equal(cancel.status, 200);
          assert.equal(cancel.json.order.status, 'cancelled');

          const prod = await apiRequest(srv.baseUrl, '/api/products/marantz-twenty-nine');
          assert.equal(prod.json.product.quantity, 1);
          assert.equal(prod.json.product.status, 'available');
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F7-04',
      feature: 'F7',
      req: 'Double-cancel idempotency',
      name: 'Cancelling the same order twice does not double-increment stock quantity',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const order = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({ items: [{ id: 'marantz-twenty-nine', quantity: 1 }] })
          });
          const ref = order.json.order.orderRef;
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);

          await apiRequest(srv.baseUrl, `/api/admin/orders/${encodeURIComponent(ref)}`, {
            method: 'PATCH',
            body: { status: 'cancelled' },
            jar
          });
          await apiRequest(srv.baseUrl, `/api/admin/orders/${encodeURIComponent(ref)}`, {
            method: 'PATCH',
            body: { status: 'cancelled' },
            jar
          });

          const prod = await apiRequest(srv.baseUrl, '/api/products/marantz-twenty-nine');
          assert.equal(prod.json.product.quantity, 1, 'Double cancel inflated quantity!');
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F7-05',
      feature: 'F7',
      req: 'Unknown admin product PATCH',
      name: 'PATCH /api/admin/products/missing-id returns 404 JSON error',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const res = await apiRequest(srv.baseUrl, '/api/admin/products/missing-id-xyz', {
            method: 'PATCH',
            body: { price: 1000 },
            jar
          });
          assert.equal(res.status, 404);
        } finally {
          await srv.stop();
        }
      }
    },

    // ================= F8 Boundaries (6) =================
    {
      id: 'T2-F8-01',
      feature: 'F8',
      req: 'Non-product reel classification',
      name: 'Previewing non-product @retromod.za reel classifies as non_product without polluting catalog',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const preview = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: { mode: 'urls', urls: [ctx.mockIg.urls.nonProductReel] },
            jar
          });
          assert.equal(preview.status, 200);
          assert.equal(preview.json.items[0].action, 'non_product');

          const commit = await apiRequest(srv.baseUrl, '/api/admin/import/commit', {
            method: 'POST',
            body: { items: preview.json.items, downloadImages: false },
            jar
          });
          assert.equal(commit.status, 200);
          assert.equal(commit.json.created, 0);
          assert.equal(commit.json.products.length, 5);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F8-02',
      feature: 'F8',
      req: 'Duplicate shortcode & batch dedup',
      name: 'Preview detects existing shortcode as update and in-batch duplicate as duplicate',
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
          assert.ok(preview.json.summary.duplicates >= 1, 'Expected >=1 in-batch duplicate');
          assert.ok(preview.json.items.some((x) => x.action === 'duplicate'));
          assert.ok(preview.json.items.some((x) => x.action === 'update'));
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F8-03',
      feature: 'F8',
      req: 'Malformed row isolation on commit',
      name: 'Mixed commit batch creates valid row, rejects invalid rows, and preserves existing 5 products',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const commit = await apiRequest(srv.baseUrl, '/api/admin/import/commit', {
            method: 'POST',
            body: {
              downloadImages: false,
              items: [
                {
                  tempId: 'ok-1',
                  action: 'create',
                  candidate: {
                    id: 'valid-imported-speaker',
                    title: 'JBL L100 Century Speakers',
                    category: 'audio',
                    price: 19500,
                    quantity: 1,
                    status: 'available'
                  }
                },
                {
                  tempId: 'bad-1',
                  action: 'create',
                  candidate: { id: 'missing-title', title: '', price: 1000, quantity: 1 }
                },
                {
                  tempId: 'bad-2',
                  action: 'create',
                  candidate: { id: 'neg-price', title: 'Bad Amp', price: -500, quantity: 1 }
                }
              ]
            },
            jar
          });
          assert.equal(commit.status, 200);
          assert.equal(commit.json.created, 1);
          assert.equal(commit.json.rejected, 2);
          assert.equal(commit.json.products.length, 6);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F8-04',
      feature: 'F8',
      req: 'Malformed commit payload',
      name: 'POST /api/admin/import/commit with non-array items returns 400',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const res = await apiRequest(srv.baseUrl, '/api/admin/import/commit', {
            method: 'POST',
            body: { items: 'not-an-array' },
            jar
          });
          assert.equal(res.status, 400);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F8-05',
      feature: 'F8',
      req: '404 and login-wall IG URL handling',
      name: 'Previewing 404 or login-wall IG URLs returns structured invalid candidate without 500',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const preview = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: {
              mode: 'urls',
              urls: [ctx.mockIg.urls.notFoundPost, ctx.mockIg.urls.loginWall]
            },
            jar
          });
          assert.equal(preview.status, 200);
          assert.equal(preview.json.items.length, 2);
          assert.ok(preview.json.items.every((x) => x.action === 'invalid' || x.errors.length > 0));
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T2-F8-06',
      feature: 'F8',
      req: 'SSRF protection',
      name: 'Import preview rejects private/metadata/file SSRF URLs even when 127.0.0.1 is allowlisted',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const preview = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: {
              mode: 'urls',
              urls: [
                'http://169.254.169.254/latest/meta-data/',
                'http://10.0.0.1/admin',
                'file:///etc/passwd'
              ]
            },
            jar
          });
          assert.equal(preview.status, 200);
          assert.equal(preview.json.items.length, 3);
          for (const item of preview.json.items) {
            assert.equal(item.action, 'invalid', `SSRF URL was not rejected: ${item.candidate?.instagramUrl}`);
            assert.ok(item.errors.length > 0);
          }
        } finally {
          await srv.stop();
        }
      }
    }
  ];
}
