import assert from 'node:assert/strict';
import { apiRequest } from '../helpers/api-client.mjs';
import {
  normText,
  attachErrorCollectors,
  waitForCatalogHydration,
  assertProductImagesHealthy
} from '../helpers/browser.mjs';

export function getTier4Tests() {
  return [
    {
      id: 'S1',
      feature: 'F2,F3,F4,F5,F6',
      req: 'First-time collector (Norwood Collection)',
      name: 'Browse Home -> Shop -> Filter Audio -> Marantz 29 -> Cart -> Norwood Collection Checkout -> SOLD badge',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await assertProductImagesHealthy(page, srv.baseUrl, { minCount: 3 });

          await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^shop$/i }).click();
          await page.waitForURL(/shop/i);
          await waitForCatalogHydration(page);

          await page.getByRole('tablist', { name: /category/i }).getByRole('tab', { name: /^audio/i }).click();
          await page.locator('main a[href*="product"]', { hasText: 'Marantz Model Twenty Nine' }).first().click();
          await page.waitForURL(/product/i);
          await waitForCatalogHydration(page);
          await assertProductImagesHealthy(page, srv.baseUrl, { selector: 'main article img, #pdImg img', minCount: 1 });

          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();
          await page.getByRole('dialog').getByRole('link', { name: /checkout/i }).click();
          await page.waitForURL(/checkout/i);
          await waitForCatalogHydration(page);

          await page.getByRole('textbox', { name: /full name|name/i }).fill('Kagiso Molefe');
          await page.getByRole('textbox', { name: /email/i }).fill('kagiso@example.co.za');
          await page.getByRole('textbox', { name: /phone|mobile/i }).fill('0827771111');
          await page.getByRole('radio', { name: /^(?!.*pay).*(collect|norwood)/i }).check();
          await page.getByRole('radio', { name: /eft/i }).check();
          await page.getByRole('button', { name: /place order|confirm|submit/i }).click();

          await page.waitForFunction(() => /RM-[A-Z0-9-]+/i.test(document.body.innerText || ''), null, {
            timeout: 8000
          });

          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          const marantzCard = page.locator('main a[href*="product"]', { hasText: 'Marantz Model Twenty Nine' }).first();
          assert.ok(/sold/i.test(normText(await marantzCard.innerText())));

          await marantzCard.click();
          await waitForCatalogHydration(page);
          assert.ok(/sold/i.test(normText(await page.locator('main').innerText())));
          collector.assertClean('S1');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'S2',
      feature: 'F1,F3,F4,F5,F6',
      req: 'Multi-item SA Delivery collector',
      name: 'Add Kartell Taj + Pioneer SA-6300 -> R7 800 -> Delivery invalid guard -> Valid SA address -> Sold',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl, {
          ignoreHttpConsolePrefixes: ['/api/orders']
        });
        try {
          await page.goto(`${srv.baseUrl}/product.html?id=kartell-taj-lamp`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();
          await page.waitForFunction(
            () => (document.querySelector('[role="dialog"]')?.innerText || '').includes('Kartell Taj'),
            null,
            { timeout: 5000 }
          );

          await page.goto(`${srv.baseUrl}/product.html?id=pioneer-sa-6300`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();

          const drawer = page.getByRole('dialog');
          await drawer.waitFor({ state: 'visible' });
          await page.waitForFunction(
            () => (document.querySelector('[role="dialog"]')?.innerText || '').replace(/[\s\u00a0\u202f]+/g, ' ').includes('R7 800'),
            null,
            { timeout: 5000 }
          );
          assert.ok(normText(await drawer.innerText()).includes('R7 800'));

          await drawer.getByRole('link', { name: /checkout/i }).click();
          await page.waitForURL(/checkout/i);
          await waitForCatalogHydration(page);

          await page.getByRole('textbox', { name: /full name|name/i }).fill('Annelize van der Merwe');
          await page.getByRole('textbox', { name: /email/i }).fill('annelize@example.co.za');
          await page.getByRole('textbox', { name: /phone|mobile/i }).fill('0836543210');
          await page.getByRole('radio', { name: /deliver|courier|ship/i }).check();

          // Submit with incomplete delivery address -> expect inline error, no order created
          await page.getByRole('button', { name: /place order|confirm|submit/i }).click();
          await page.waitForFunction(
            () => (document.querySelector('[role="alert"], .error, [aria-invalid="true"]')?.textContent || '').trim().length > 0 ||
                  document.querySelectorAll('[aria-invalid="true"]').length > 0,
            null,
            { timeout: 5000 }
          );

          // Now fill valid SA delivery address
          await page.getByLabel(/street|address/i).fill('42 Bree Street');
          await page.getByLabel(/suburb/i).fill('CBD');
          await page.getByLabel(/city/i).fill('Cape Town');
          await page.getByLabel(/province/i).fill('Western Cape');
          await page.getByLabel(/postal/i).fill('8001');
          await page.getByRole('button', { name: /place order|confirm|submit/i }).click();

          await page.waitForFunction(() => /RM-[A-Z0-9-]+/i.test(document.body.innerText || ''), null, {
            timeout: 8000
          });

          const [kRes, pRes] = await Promise.all([
            apiRequest(srv.baseUrl, '/api/products/kartell-taj-lamp'),
            apiRequest(srv.baseUrl, '/api/products/pioneer-sa-6300')
          ]);
          assert.equal(kRes.json.product.status, 'sold');
          assert.equal(pRes.json.product.status, 'sold');
          collector.assertClean('S2');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'S3',
      feature: 'F1,F2,F6,F7,F8',
      req: 'Store owner Instagram import workflow',
      name: 'Admin logs in -> imports mixed IG URL batch -> edits preview row -> commits -> storefront shows /media images',
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
          if (await modeSel.count()) await modeSel.selectOption('urls');

          const mixedUrls = [
            ctx.mockIg.urls.newAudio,
            ctx.mockIg.urls.newFurniture,
            ctx.mockIg.urls.existingMarantz,
            ctx.mockIg.urls.nonProductReel,
            ctx.mockIg.urls.notFoundPost
          ].join('\n');

          await page.getByLabel(/import|payload|urls/i).fill(mixedUrls);
          await page.getByRole('button', { name: /preview/i }).click();

          const firstRow = page.locator('[data-preview-row="0"], [data-preview-row]').first();
          await firstRow.waitFor({ state: 'visible', timeout: 8000 });
          await firstRow.locator('input[type="number"]').first().fill('12900');

          await page.getByRole('button', { name: /commit|import/i }).click();
          await page.waitForFunction(
            async () => {
              const r = await fetch('/api/products');
              const d = await r.json();
              return d.products.length >= 7 && d.products.some((p) => p.price === 12900);
            },
            null,
            { timeout: 8000 }
          );

          await page.goto(`${srv.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          const shopText = normText(await page.locator('main').innerText());
          assert.ok(shopText.includes('Technics'));
          assert.ok(shopText.includes('R12 900'));
          assert.ok(shopText.includes('Danish Teak Credenza'));
          await assertProductImagesHealthy(page, srv.baseUrl, { selector: 'main a[href*="product"] img', minCount: 7 });
          collector.assertClean('S3');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    },
    {
      id: 'S4',
      feature: 'F1,F4,F5,F7',
      req: 'Concurrent collector contention & admin cancel recovery',
      name: 'Two buyers race on 1-of-1 Fujifilm X100V -> B gets conflict -> Admin cancels A -> B succeeds',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const ctxA = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const ctxB = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const ctxAdmin = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });

        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const pageAdmin = await ctxAdmin.newPage();
        const colA = attachErrorCollectors(pageA, srv.baseUrl);
        const colB = attachErrorCollectors(pageB, srv.baseUrl, {
          ignoreHttpConsolePrefixes: ['/api/orders']
        });
        const colAdmin = attachErrorCollectors(pageAdmin, srv.baseUrl);

        try {
          // Both A and B add Fujifilm X100V and open /checkout
          for (const p of [pageA, pageB]) {
            await p.goto(`${srv.baseUrl}/product.html?id=fujifilm-x100v`, { waitUntil: 'domcontentloaded' });
            await waitForCatalogHydration(p);
            await p.getByRole('button', { name: /add to (cart|bag)/i }).click();
            await p.getByRole('dialog').getByRole('link', { name: /checkout/i }).click();
            await p.waitForURL(/checkout/i);
            await waitForCatalogHydration(p);
          }

          // Customer A checks out first
          await pageA.getByRole('textbox', { name: /full name|name/i }).fill('Buyer Alpha');
          await pageA.getByRole('textbox', { name: /email/i }).fill('alpha@example.co.za');
          await pageA.getByRole('textbox', { name: /phone|mobile/i }).fill('0821112222');
          await pageA.getByRole('button', { name: /place order|confirm|submit/i }).click();
          await pageA.waitForFunction(() => /RM-[A-Z0-9-]+/i.test(document.body.innerText || ''), null, {
            timeout: 8000
          });
          const matchRef = /RM-[A-Z0-9-]+/i.exec(await pageA.locator('main').innerText());
          assert.ok(matchRef, 'Missing Buyer A orderRef');
          const orderRefA = matchRef[0];

          // Customer B tries to submit -> expects graceful conflict message, no crash
          await pageB.getByRole('textbox', { name: /full name|name/i }).fill('Buyer Beta');
          await pageB.getByRole('textbox', { name: /email/i }).fill('beta@example.co.za');
          await pageB.getByRole('textbox', { name: /phone|mobile/i }).fill('0823334444');
          await pageB.getByRole('button', { name: /place order|confirm|submit/i }).click();
          await pageB.waitForFunction(
            () => /insufficient|sold|unavailable|stock/i.test(document.body.innerText || ''),
            null,
            { timeout: 6000 }
          );

          // Admin logs in and cancels Buyer A's order
          await pageAdmin.goto(`${srv.baseUrl}/admin`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(pageAdmin);
          await pageAdmin.getByLabel(/password/i).fill(srv.adminPassword);
          await pageAdmin.getByRole('button', { name: /log in|sign in/i }).click();

          const orderRow = pageAdmin
            .locator(`[data-order-ref="${orderRefA}"], tr:has-text("${orderRefA}"), article:has-text("${orderRefA}"), li:has-text("${orderRefA}")`)
            .first();
          await orderRow.waitFor({ state: 'visible', timeout: 8000 });
          await orderRow.locator('select').selectOption('cancelled');
          await orderRow.getByRole('button', { name: /update|save|cancel/i }).click();

          await pageAdmin.waitForFunction(
            async () => {
              const r = await fetch('/api/products/fujifilm-x100v');
              const d = await r.json();
              return d.product?.status === 'available' && d.product?.quantity === 1;
            },
            null,
            { timeout: 6000 }
          );

          // Buyer B retries checkout and succeeds!
          await pageB.getByRole('button', { name: /place order|confirm|submit/i }).click();
          await pageB.waitForFunction(() => /RM-[A-Z0-9-]+/i.test(document.body.innerText || ''), null, {
            timeout: 8000
          });

          colA.assertClean('S4-A');
          colB.assertClean('S4-B');
          colAdmin.assertClean('S4-Admin');
        } finally {
          await Promise.all([ctxA.close(), ctxB.close(), ctxAdmin.close()]);
          await srv.stop();
        }
      }
    },
    {
      id: 'S5',
      feature: 'F1,F3,F6,F7',
      req: 'Admin inline edit & restart persistence',
      name: 'Admin edits NAD 3020i price & qty -> storefront reflects immediately -> persists across server restart',
      async fn(ctx) {
        const srv1 = await ctx.spawnServer({ cleanupDataDir: false });
        const sharedDir = srv1.dataDir;
        const context1 = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page1 = await context1.newPage();
        const col1 = attachErrorCollectors(page1, srv1.baseUrl);
        try {
          await page1.goto(`${srv1.baseUrl}/admin`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page1);
          await page1.getByLabel(/password/i).fill(srv1.adminPassword);
          await page1.getByRole('button', { name: /log in|sign in/i }).click();

          const nadRow = page1
            .locator('[data-product-id="nad-3020i"], tr:has-text("NAD 3020i"), article:has-text("NAD 3020i"), li:has-text("NAD 3020i")')
            .first();
          await nadRow.waitFor({ state: 'visible', timeout: 8000 });
          const nums = nadRow.locator('input[type="number"]');
          await nums.nth(0).fill('4250');
          await nums.nth(1).fill('3');
          await nadRow.getByRole('button', { name: /save|update/i }).click();

          await page1.waitForFunction(
            async () => {
              const r = await fetch('/api/products/nad-3020i');
              const d = await r.json();
              return d.product?.price === 4250 && d.product?.quantity === 3;
            },
            null,
            { timeout: 6000 }
          );

          await page1.goto(`${srv1.baseUrl}/shop`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page1);
          assert.ok(normText(await page1.locator('main').innerText()).includes('R4 250'));
          col1.assertClean('S5-before-restart');
        } finally {
          await context1.close();
          await srv1.stop({ removeDataDir: false });
        }

        const srv2 = await ctx.spawnServer({ dataDir: sharedDir, cleanupDataDir: true });
        const context2 = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page2 = await context2.newPage();
        const col2 = attachErrorCollectors(page2, srv2.baseUrl);
        try {
          await page2.goto(`${srv2.baseUrl}/product.html?id=nad-3020i`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page2);
          assert.ok(normText(await page2.locator('main').innerText()).includes('R4 250'));
          const apiCheck = await apiRequest(srv2.baseUrl, '/api/products/nad-3020i');
          assert.equal(apiCheck.json.product.price, 4250);
          assert.equal(apiCheck.json.product.quantity, 3);
          col2.assertClean('S5-after-restart');
        } finally {
          await context2.close();
          await srv2.stop({ removeDataDir: true });
        }
      }
    },
    {
      id: 'S6',
      feature: 'F2,F3,F4,F5,F6',
      req: 'Mobile viewport 390x844 E2E purchase',
      name: 'Mobile 390x844 navigation -> Kartell Taj -> Cart Drawer -> Checkout -> Order confirmation with zero overflow',
      async fn(ctx) {
        const srv = await ctx.spawnServer();
        const context = await ctx.browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await context.newPage();
        const collector = attachErrorCollectors(page, srv.baseUrl);
        try {
          await page.goto(`${srv.baseUrl}/`, { waitUntil: 'domcontentloaded' });
          await waitForCatalogHydration(page);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 1
          );
          assert.equal(overflow, false, 'Horizontal overflow detected on mobile home');
          await assertProductImagesHealthy(page, srv.baseUrl, { minCount: 3 });

          const menuBtn = page.getByRole('button', { name: /open menu|menu/i });
          if (await menuBtn.isVisible()) {
            await menuBtn.click();
          }
          await page.locator('#mnav a[href*="shop"], a[href*="shop"]:visible').first().click();
          await page.waitForURL(/shop/i);
          await waitForCatalogHydration(page);

          await page.locator('main a[href*="product"]', { hasText: 'Kartell Taj' }).first().click();
          await page.waitForURL(/product/i);
          await waitForCatalogHydration(page);

          await page.getByRole('button', { name: /add to (cart|bag)/i }).click();
          await page.getByRole('dialog').getByRole('link', { name: /checkout/i }).click();
          await page.waitForURL(/checkout/i);
          await waitForCatalogHydration(page);

          await page.getByRole('textbox', { name: /full name|name/i }).fill('Siyabonga Nkosi');
          await page.getByRole('textbox', { name: /email/i }).fill('siya@example.co.za');
          await page.getByRole('textbox', { name: /phone|mobile/i }).fill('0829876543');
          await page.getByRole('button', { name: /place order|confirm|submit/i }).click();
          await page.waitForFunction(() => /RM-[A-Z0-9-]+/i.test(document.body.innerText || ''), null, {
            timeout: 8000
          });
          collector.assertClean('S6-mobile');
        } finally {
          await context.close();
          await srv.stop();
        }
      }
    }
  ];
}
