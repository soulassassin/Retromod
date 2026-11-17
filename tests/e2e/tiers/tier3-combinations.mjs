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

export function getTier3Tests() {
  return [
    {
      id: 'T3-01',
      feature: 'F4xF5',
      req: 'Concurrent checkout race',
      name: 'Two simultaneous POST /api/orders for last 1-of-1 item yield exactly one 201 and one 409',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const payload = buildValidOrderPayload({ items: [{ id: 'fujifilm-x100v', quantity: 1 }] });
          const [r1, r2] = await Promise.all([
            apiRequest(srv.baseUrl, '/api/orders', { method: 'POST', body: payload }),
            apiRequest(srv.baseUrl, '/api/orders', { method: 'POST', body: payload })
          ]);
          const statuses = [r1.status, r2.status].sort((a, b) => a - b);
          assert.deepEqual(statuses, [201, 409], `Expected [201, 409], got ${JSON.stringify(statuses)}`);
          const loser = r1.status === 409 ? r1 : r2;
          assert.equal(loser.json.itemId, 'fujifilm-x100v');
          assert.equal(loser.json.availableQuantity, 0);

          const prod = await apiRequest(srv.baseUrl, '/api/products/fujifilm-x100v');
          assert.equal(prod.json.product.quantity, 0);
          assert.equal(prod.json.product.status, 'sold');
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T3-02',
      feature: 'F4xF6',
      req: 'Cart + shop filter/sort hydration',
      name: 'Filtering categories and adding Pioneer + Kartell persists across navigation to Home',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('tablist', { name: /category/i }).getByRole('tab', { name: /^audio/i }).click();
          await page.locator('main a[href*="product"]', { hasText: 'Pioneer SA-6300' }).first().click();
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();
          await page.waitForFunction(
            () => (document.querySelector('[role="dialog"]')?.innerText || '').includes('Pioneer SA-6300'),
            null,
            { timeout: 5000 }
          );

          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('tablist', { name: /category/i }).getByRole('tab', { name: /^lighting/i }).click();
          await page.locator('main a[href*="product"]', { hasText: 'Kartell Taj' }).first().click();
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();
          await page.waitForFunction(
            () => (document.querySelector('[role="dialog"]')?.innerText || '').includes('Kartell Taj'),
            null,
            { timeout: 5000 }
          );

          await page.goto(`${srv.baseUrl}/`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.locator('header').getByRole('button', { name: /cart|bag/i }).click();
          const drawer = page.getByRole('dialog');
          await drawer.waitFor({ state: 'visible' });
          const text = normText(await drawer.innerText());
          assert.ok(text.includes('Pioneer SA-6300'));
          assert.ok(text.includes('Kartell Taj'));
          assert.ok(text.includes('R7 800'), `Expected R7 800 subtotal, got: ${text}`);
          collector.assertClean('t3-02');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T3-03',
      feature: 'F2xF5',
      req: 'Sold item retains healthy image',
      name: 'Purchased sold item displays Sold badge on /shop and /product while keeping HTTP 200 image',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          const order = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({ items: [{ id: 'marantz-twenty-nine', quantity: 1 }] })
          });
          assert.equal(order.status, 201);

          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await assertProductImagesHealthy(page, srv.baseUrl, { selector: 'main a[href*="product"] img', minCount: 5 });

          await page.goto(`${srv.baseUrl}/product.html?id=marantz-twenty-nine`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await assertProductImagesHealthy(page, srv.baseUrl, { selector: 'main article img, #pdImg img', minCount: 1 });
          const text = normText(await page.locator('main').innerText());
          assert.ok(/sold/i.test(text));
          collector.assertClean('t3-03');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T3-04',
      feature: 'F7xF4',
      req: 'Admin edit -> cart revalidation',
      name: 'Admin price update and sold mark are caught by cart revalidation',
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

          await page.goto(`${srv.baseUrl}/product.html?id=kartell-taj-lamp`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();
          await page.waitForFunction(
            () => (document.querySelector('[role="dialog"]')?.innerText || '').includes('Kartell Taj'),
            null,
            { timeout: 5000 }
          );

          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          await apiRequest(srv.baseUrl, '/api/admin/products/nad-3020i', {
            method: 'PATCH',
            body: { price: 4200 },
            jar
          });
          await apiRequest(srv.baseUrl, '/api/admin/products/kartell-taj-lamp', {
            method: 'PATCH',
            body: { quantity: 0, status: 'sold' },
            jar
          });

          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.locator('header').getByRole('button', { name: /cart|bag/i }).click();
          const drawer = page.getByRole('dialog');
          await drawer.waitFor({ state: 'visible' });
          await page.waitForFunction(
            () => {
              const t = (document.querySelector('[role="dialog"]')?.innerText || '').replace(/[\s\u00a0\u202f]+/g, ' ');
              return t.includes('R4 200') && /sold|unavailable/i.test(t);
            },
            null,
            { timeout: 6000 }
          );
          collector.assertClean('t3-04');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T3-05',
      feature: 'F5xF7',
      req: 'Order -> Cancel -> Re-purchase',
      name: 'Order decrements stock, admin cancel restores it, and second buyer succeeds',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const first = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({ items: [{ id: 'marantz-twenty-nine', quantity: 1 }] })
          });
          assert.equal(first.status, 201);

          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const cancel = await apiRequest(
            srv.baseUrl,
            `/api/admin/orders/${encodeURIComponent(first.json.order.orderRef)}`,
            { method: 'PATCH', body: { status: 'cancelled' }, jar }
          );
          assert.equal(cancel.status, 200);

          const second = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({
              customer: { name: 'Second Buyer', email: 'second@example.co.za', phone: '0839998888' },
              items: [{ id: 'marantz-twenty-nine', quantity: 1 }]
            })
          });
          assert.equal(second.status, 201);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T3-06',
      feature: 'F7xF1xF3',
      req: 'Restock survives restart',
      name: 'Admin restock (qty=3) persists across server restart and supports multi-unit order (qty=2)',
      async fn(ctx) {
        const srv1 = await ctx.spawnServer({ cleanupDataDir: false });
        const dir = srv1.dataDir;
        try {
          const jar = await loginAdminApi(srv1.baseUrl, srv1.adminPassword);
          const patch = await apiRequest(srv1.baseUrl, '/api/admin/products/nad-3020i', {
            method: 'PATCH',
            body: { quantity: 3, status: 'available' },
            jar
          });
          assert.equal(patch.status, 200);
        } finally {
          await srv1.stop({ removeDataDir: false });
        }

        const srv2 = await ctx.spawnServer({ dataDir: dir, cleanupDataDir: true });
        try {
          const order = await apiRequest(srv2.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({ items: [{ id: 'nad-3020i', quantity: 2 }] })
          });
          assert.equal(order.status, 201);
          const after = await apiRequest(srv2.baseUrl, '/api/products/nad-3020i');
          assert.equal(after.json.product.quantity, 1);
          assert.equal(after.json.product.status, 'available');
        } finally {
          await srv2.stop({ removeDataDir: true });
        }
      }
    },
    {
      id: 'T3-07',
      feature: 'F8xF1',
      req: 'Preview non-mutating -> Commit atomic + restart',
      name: 'Import preview leaves catalog untouched until commit, and committed state survives restart',
      async fn(ctx) {
        const srv1 = await ctx.spawnServer({ cleanupDataDir: false });
        const dir = srv1.dataDir;
        try {
          const jar = await loginAdminApi(srv1.baseUrl, srv1.adminPassword);
          const preview = await apiRequest(srv1.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: { mode: 'urls', urls: [ctx.mockIg.urls.newAudio, ctx.mockIg.urls.existingMarantz] },
            jar
          });
          assert.equal(preview.status, 200);

          const beforeCommit = await apiRequest(srv1.baseUrl, '/api/products');
          assert.equal(beforeCommit.json.products.length, 5);

          const commit = await apiRequest(srv1.baseUrl, '/api/admin/import/commit', {
            method: 'POST',
            body: { items: preview.json.items, downloadImages: false },
            jar
          });
          assert.equal(commit.status, 200);
          assert.equal(commit.json.created, 1);
          assert.equal(commit.json.updated, 1);
        } finally {
          await srv1.stop({ removeDataDir: false });
        }

        const srv2 = await ctx.spawnServer({ dataDir: dir, cleanupDataDir: true });
        try {
          const after = await apiRequest(srv2.baseUrl, '/api/products');
          assert.equal(after.json.products.length, 6);
        } finally {
          await srv2.stop({ removeDataDir: true });
        }
      }
    },
    {
      id: 'T3-08',
      feature: 'F8xF2xF6',
      req: 'IG import -> /media -> Storefront UI',
      name: 'Imported product renders on /shop and /product.html with local /media/ image (naturalWidth > 0)',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const preview = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: { mode: 'urls', urls: [ctx.mockIg.urls.newFurniture] },
            jar
          });
          const commit = await apiRequest(srv.baseUrl, '/api/admin/import/commit', {
            method: 'POST',
            body: { items: preview.json.items, downloadImages: true },
            jar
          });
          const imported = commit.json.products.find((p) => p.instagramShortcode === 'DfnNewFurn2');
          assert.ok(imported);

          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await assertProductImagesHealthy(page, srv.baseUrl, { selector: 'main a[href*="product"] img', minCount: 6 });

          await page.goto(`${srv.baseUrl}/product.html?id=${encodeURIComponent(imported.id)}`, {
            waitUntil: 'domcontentloaded'
          });
          await waitForCatalogHydration(page);
          await assertProductImagesHealthy(page, srv.baseUrl, { selector: 'main article img, #pdImg img', minCount: 1 });
          collector.assertClean('t3-08');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T3-09',
      feature: 'F8xF4xF5',
      req: 'Imported item -> Cart -> Checkout',
      name: 'Imported product with qty=2 can be purchased end-to-end and decrements to sold',
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
                  tempId: 'imp-1',
                  action: 'create',
                  candidate: {
                    id: 'beogram-1700-t3',
                    title: 'Bang & Olufsen Beogram 1700',
                    category: 'audio',
                    price: 4950,
                    quantity: 2,
                    status: 'available'
                  }
                }
              ]
            },
            jar
          });
          assert.equal(commit.json.created, 1);

          const order = await apiRequest(srv.baseUrl, '/api/orders', {
            method: 'POST',
            body: buildValidOrderPayload({
              fulfillment: 'delivery',
              shippingAddress: {
                street: '10 Oak Ave',
                suburb: 'Sandton',
                city: 'Johannesburg',
                province: 'Gauteng',
                postalCode: '2196'
              },
              items: [{ id: 'beogram-1700-t3', quantity: 2 }]
            })
          });
          assert.equal(order.status, 201);

          const prod = await apiRequest(srv.baseUrl, '/api/products/beogram-1700-t3');
          assert.equal(prod.json.product.quantity, 0);
          assert.equal(prod.json.product.status, 'sold');

          const receipt = await apiRequest(
            srv.baseUrl,
            `/api/orders/${encodeURIComponent(order.json.order.orderRef)}?token=${encodeURIComponent(order.json.order.accessToken)}`
          );
          assert.equal(receipt.status, 200);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T3-10',
      feature: 'F3xF5xF6',
      req: 'Clean URLs + Security + Checkout',
      name: 'Clean URLs (/shop, /product, /checkout) complete checkout with security headers and zero console errors',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          const headRes = await apiRequest(srv.baseUrl, '/checkout');
          assert.equal(headRes.status, 200);
          assert.equal(headRes.headers.get('x-content-type-options'), 'nosniff');

          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.locator('main a[href*="product"]', { hasText: 'NAD 3020i' }).first().click();
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();
          await page.getByRole('dialog').getByRole('link', { name: /checkout/i }).click();
          await page.waitForURL(/checkout/i);
          await waitForCatalogHydration(page);

          await page.getByRole('textbox', { name: /full name|name/i }).fill('Naledi Khumalo');
          await page.getByRole('textbox', { name: /email/i }).fill('naledi@example.co.za');
          await page.getByRole('textbox', { name: /phone|mobile/i }).fill('0824445555');
          await page.getByRole('button', { name: /place order|confirm|submit/i }).click();
          await page.waitForFunction(() => /RM-[A-Z0-9-]+/i.test(document.body.innerText || ''), null, {
            timeout: 8000
          });
          collector.assertClean('t3-10');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'T3-11',
      feature: 'F8xF7',
      req: 'Auth lifecycle gates import',
      name: 'Unauthenticated import blocked (401), login enables mixed commit, logout re-blocks (401)',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        try {
          const blocked1 = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: { mode: 'caption', payload: 'Test' }
          });
          assert.equal(blocked1.status, 401);

          const jar = await loginAdminApi(srv.baseUrl, srv.adminPassword);
          const csvPayload = fs.readFileSync(path.join(ctx.fixturesDir, 'ig-stock.csv'), 'utf8');
          const preview = await apiRequest(srv.baseUrl, '/api/admin/import/preview', {
            method: 'POST',
            body: { mode: 'csv', payload: csvPayload },
            jar
          });
          assert.equal(preview.status, 200);
          const commit = await apiRequest(srv.baseUrl, '/api/admin/import/commit', {
            method: 'POST',
            body: { items: preview.json.items, downloadImages: false },
            jar
          });
          assert.equal(commit.status, 200);
          assert.ok(commit.json.created >= 2);
          assert.ok(commit.json.rejected >= 1);

          await apiRequest(srv.baseUrl, '/api/admin/logout', { method: 'POST', jar });
          const blocked2 = await apiRequest(srv.baseUrl, '/api/admin/import/commit', {
            method: 'POST',
            body: { items: [] },
            jar
          });
          assert.equal(blocked2.status, 401);
        } finally {
          await srv.stop();
        }
      }
    },
    {
      id: 'T3-12',
      feature: 'F1xF5xF8',
      req: 'Mutex serialization order + import',
      name: 'Concurrent order and IG export import commit serialize cleanly without lost updates',
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
          // Only import the 2 new valid entries concurrently with a customer order for kartell-taj-lamp
          const newOnly = preview.json.items.filter((i) => i.action === 'create');

          const [orderRes, commitRes] = await Promise.all([
            apiRequest(srv.baseUrl, '/api/orders', {
              method: 'POST',
              body: buildValidOrderPayload({ items: [{ id: 'kartell-taj-lamp', quantity: 1 }] })
            }),
            apiRequest(srv.baseUrl, '/api/admin/import/commit', {
              method: 'POST',
              body: { items: newOnly, downloadImages: false },
              jar
            })
          ]);
          assert.equal(orderRes.status, 201);
          assert.equal(commitRes.status, 200);

          const finalCat = await apiRequest(srv.baseUrl, '/api/products');
          assert.equal(finalCat.status, 200);
          assert.equal(finalCat.json.products.length, 5 + newOnly.length);
          const kartell = finalCat.json.products.find((p) => p.id === 'kartell-taj-lamp');
          assert.equal(kartell.status, 'sold');
          assert.equal(kartell.quantity, 0);
        } finally {
          await srv.stop();
        }
      }
    }
  ];
}
