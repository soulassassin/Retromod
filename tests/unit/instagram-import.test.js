'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const importer = require('../../lib/instagram-import');
const storeModule = require('../../lib/store');
const { startServer } = require('../../server');

function makeTempDir(prefix = 'retromod-m3-ig-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function extractCookiePair(res) {
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'Expected Set-Cookie header');
  const firstSemi = setCookie.indexOf(';');
  return firstSemi === -1 ? setCookie : setCookie.slice(0, firstSemi);
}

// Valid minimal 1x1 JPEG & 1x1 PNG binary buffers
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9
]);

const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82
]);

describe('SSRF protection & scheme validation', () => {
  it('blocks private, loopback, link-local, metadata, ULA, mapped IPv4, and unsafe schemes by default', async (t) => {
    const prevAllow = process.env.RETROMOD_IMPORT_ALLOW_HOSTS;
    delete process.env.RETROMOD_IMPORT_ALLOW_HOSTS;
    t.after(() => {
      if (prevAllow === undefined) delete process.env.RETROMOD_IMPORT_ALLOW_HOSTS;
      else process.env.RETROMOD_IMPORT_ALLOW_HOSTS = prevAllow;
    });

    const blockedUrls = [
      'http://127.0.0.1/p/ABC123/',
      'http://localhost:3000/p/ABC123/',
      'http://[::1]/p/ABC123/',
      'http://10.0.0.1/p/ABC123/',
      'http://172.16.5.4/p/ABC123/',
      'http://192.168.1.10/p/ABC123/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/p/ABC123/',
      'http://0.0.0.0/p/ABC123/',
      'http://[fc00::1]/p/ABC123/',
      'http://[fe80::1]/p/ABC123/',
      'http://[::ffff:127.0.0.1]/p/ABC123/',
      'http://[::ffff:7f00:1]/p/ABC123/',
      'file:///etc/passwd',
      'ftp://example.com/file',
      'javascript:alert(1)'
    ];

    for (const u of blockedUrls) {
      await assert.rejects(
        () => importer.assertSafeUrl(u),
        err => err instanceof importer.SsrfBlockedError,
        `Expected SSRF block for ${u}`
      );
    }

    // DNS rebinding defense: hostname resolving to private IP must be blocked
    await assert.rejects(
      () => importer.assertSafeUrl('https://www.instagram.com/p/DfnF8-nkdJi/', {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }]
      }),
      err => err instanceof importer.SsrfBlockedError
    );

    // Honors RETROMOD_IMPORT_ALLOW_HOSTS=127.0.0.1 while still blocking metadata & localhost
    process.env.RETROMOD_IMPORT_ALLOW_HOSTS = '127.0.0.1';
    const ok = await importer.assertSafeUrl('http://127.0.0.1:4199/p/Test123/');
    assert.equal(ok.hostname, '127.0.0.1');
    assert.equal(ok.isAllowlisted, true);

    await assert.rejects(
      () => importer.assertSafeUrl('http://169.254.169.254/latest/meta-data/'),
      err => err instanceof importer.SsrfBlockedError
    );
    await assert.rejects(
      () => importer.assertSafeUrl('http://localhost/p/Test123/'),
      err => err instanceof importer.SsrfBlockedError
    );
  });

  it('blocks HTTP redirects pointing to private/metadata IPs', async (t) => {
    const prevAllow = process.env.RETROMOD_IMPORT_ALLOW_HOSTS;
    process.env.RETROMOD_IMPORT_ALLOW_HOSTS = '127.0.0.1';
    const mockServer = http.createServer((req, res) => {
      if (req.url === '/p/Redir123/') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      mockServer.close();
      if (prevAllow === undefined) delete process.env.RETROMOD_IMPORT_ALLOW_HOSTS;
      else process.env.RETROMOD_IMPORT_ALLOW_HOSTS = prevAllow;
    });

    const port = mockServer.address().port;
    await assert.rejects(
      () => importer.safeFetch(`http://127.0.0.1:${port}/p/Redir123/`),
      err => err instanceof importer.SsrfBlockedError
    );
  });
});

describe('@retromod.za caption, export & CSV parsing', () => {
  it('parses 2-part, 3-part, art, SOLD, specs, and non-product captions accurately', () => {
    const res1 = importer.parseRetromodCaption([
      'KARTELL ‘TAJ’ TABLE LAMP IN CLEAR | DESIGNED BY FERRUCCIO LAVIANI | ITALY, CIRCA 2012',
      '',
      'Sculptural PMMA table lamp with integrated LED.',
      'Second paragraph with gallery provenance.',
      '',
      'Size : 350mm(H)',
      'Nationwide Shipping Available.',
      '',
      'Price : R3 850.00',
      '',
      'Kindly send @retromod.za a DM if you wish to purchase.'
    ].join('\n'));

    assert.equal(res1.isNonProduct, false);
    assert.equal(res1.errors.length, 0);
    assert.equal(res1.candidate.category, 'lighting');
    assert.equal(res1.candidate.price, 3850);
    assert.equal(res1.candidate.origin, 'Italy');
    assert.equal(res1.candidate.era, 'Circa 2012');
    assert.equal(res1.candidate.maker, 'Kartell · Ferruccio Laviani');
    assert.ok(Array.isArray(res1.candidate.body) && res1.candidate.body.length >= 1);
    assert.ok(res1.candidate.specs.some(([k, v]) => k === 'Size' && v === '350mm(H)'));
    assert.ok(res1.candidate.specs.some(([k, v]) => k === 'Shipping' && v === 'Nationwide'));

    // Art post + SOLD marker
    const resArt = importer.parseRetromodCaption([
      'SOLD - SAM NHLENGETHWA (SOUTH AFRICA, 1955 -) | STREET SCENE IN SENEGAL',
      '',
      'Original watercolour, signed, framed & dated, 1985.',
      'Frame Size : 530mm x 480mm',
      'Art Size : 400mm x 340mm',
      'Price : R14 950.00'
    ].join('\n'));

    assert.equal(resArt.isNonProduct, false);
    assert.equal(resArt.candidate.status, 'sold');
    assert.equal(resArt.candidate.quantity, 0);
    assert.equal(resArt.candidate.category, 'art');
    assert.equal(resArt.candidate.price, 14950);
    assert.equal(resArt.candidate.origin, 'South Africa');
    assert.equal(resArt.candidate.era, '1985');

    // Buying promo -> non_product
    const promo = importer.parseRetromodCaption('WE BUY VINYL RECORDS!\nKindly send @retromod.za a DM to sell.');
    assert.equal(promo.isNonProduct, true);

    // Reel without price -> non_product
    const reel = importer.parseRetromodCaption('We’re all slaves to the algorithm\n#technics #vintage', {
      productType: 'clips'
    });
    assert.equal(reel.isNonProduct, true);
  });

  it('parses RFC-4180 CSV with quoted commas and Meta posts_1.json exports', () => {
    const csv = [
      'title,category,price,quantity,origin,era,lede',
      '"Technics SL-1200MK2 Turntable",audio,"12,500",1,Japan,"Circa 1985","Direct-drive classic, serviced in Norwood."'
    ].join('\n');

    const rows = importer.parseExportPayload(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].candidate.title, 'Technics SL-1200MK2 Turntable');
    assert.equal(rows[0].candidate.price, 12500);
    assert.equal(rows[0].candidate.category, 'audio');
    assert.equal(rows[0].candidate.lede, 'Direct-drive classic, serviced in Norwood.');
  });
});

describe('End-to-end admin import preview & commit with local mock IG server', () => {
  it('previews URLs (SSR + meta + 403 assisted fallback), exports, commits media locally, and isolates errors', async (t) => {
    const tmpDir = makeTempDir();
    const prevPw = process.env.RETROMOD_ADMIN_PASSWORD;
    const prevSec = process.env.RETROMOD_SESSION_SECRET;
    const prevAllow = process.env.RETROMOD_IMPORT_ALLOW_HOSTS;

    process.env.RETROMOD_ADMIN_PASSWORD = 'import-admin-password';
    process.env.RETROMOD_SESSION_SECRET = 'import-admin-secret';
    process.env.RETROMOD_IMPORT_ALLOW_HOSTS = '127.0.0.1';

    let mockPort = 0;
    const mockIg = http.createServer((req, res) => {
      if (req.url === '/retromod.za/p/MockLamp1/') {
        const ssrData = {
          code: 'MockLamp1',
          __isXIGPolarisMedia: true,
          taken_at: 1794420619,
          product_type: 'feed',
          caption: {
            text: [
              'ARTEMIDE TIZIO DESK LAMP | DESIGNED BY RICHARD SAPPER | ITALY, CIRCA 1972',
              '',
              'Iconic counterbalanced halogen desk lamp in matte black.',
              'Size : 780mm(W)',
              'Price : R7 450.00'
            ].join('\n')
          },
          image_versions2: {
            candidates: [{ url: `http://127.0.0.1:${mockPort}/img/tizio.jpg` }]
          }
        };
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta property="og:url" content="https://www.instagram.com/retromod.za/p/MockLamp1/"></head><body><script type="application/json">${JSON.stringify(ssrData)}</script></body></html>`);
        return;
      }

      if (req.url === '/p/MockMeta2/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end([
          '<!doctype html><html><head>',
          `<meta property="og:image" content="http://127.0.0.1:${mockPort}/img/tizio.jpg">`,
          '<meta property="og:description" content="18 likes, 2 comments - retromod.za on November 12, 2026: &quot;LEICA M6 RANGEFINDER CAMERA | GERMANY, CIRCA 1988\n\nClassic 35mm mechanical body.\n\nPrice : R44 500.00&quot;">',
          '</head><body></body></html>'
        ].join(''));
        return;
      }

      if (req.url === '/p/Blocked3/') {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<html><body>Login required</body></html>');
        return;
      }

      if (req.url === '/img/tizio.jpg') {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(TINY_JPEG);
        return;
      }

      if (req.url === '/img/fake.jpg') {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise(resolve => mockIg.listen(0, '127.0.0.1', resolve));
    mockPort = mockIg.address().port;

    const store = storeModule.createStore({ dataDir: tmpDir });
    const appServer = await startServer({ port: 0, store });

    t.after(() => {
      appServer.close();
      mockIg.close();
      if (prevPw === undefined) delete process.env.RETROMOD_ADMIN_PASSWORD;
      else process.env.RETROMOD_ADMIN_PASSWORD = prevPw;
      if (prevSec === undefined) delete process.env.RETROMOD_SESSION_SECRET;
      else process.env.RETROMOD_SESSION_SECRET = prevSec;
      if (prevAllow === undefined) delete process.env.RETROMOD_IMPORT_ALLOW_HOSTS;
      else process.env.RETROMOD_IMPORT_ALLOW_HOSTS = prevAllow;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const base = `http://127.0.0.1:${appServer.address().port}`;
    const loginRes = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'import-admin-password' })
    });
    const cookie = extractCookiePair(loginRes);

    // 1. URL preview (SSR + meta + 403 assisted draft) must NOT mutate catalog or media/
    const prevRes = await fetch(`${base}/api/admin/import/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        mode: 'urls',
        urls: [
          `http://127.0.0.1:${mockPort}/retromod.za/p/MockLamp1/`,
          `http://127.0.0.1:${mockPort}/p/MockMeta2/`,
          `http://127.0.0.1:${mockPort}/p/Blocked3/`
        ]
      })
    });
    assert.equal(prevRes.status, 200);
    const prevData = await prevRes.json();
    assert.equal(prevData.mode, 'urls');
    assert.equal(prevData.summary.total, 3);
    assert.equal(prevData.summary.valid, 2);
    assert.equal(prevData.summary.invalid, 1);

    const lampCand = prevData.items[0];
    assert.equal(lampCand.action, 'create');
    assert.equal(lampCand.candidate.category, 'lighting');
    assert.equal(lampCand.candidate.price, 7450);
    assert.equal(lampCand.candidate.instagramShortcode, 'MockLamp1');

    const leicaCand = prevData.items[1];
    assert.equal(leicaCand.action, 'create');
    assert.equal(leicaCand.candidate.category, 'cameras');
    assert.equal(leicaCand.candidate.price, 44500);

    const blockedCand = prevData.items[2];
    assert.equal(blockedCand.action, 'invalid');
    assert.equal(blockedCand.candidate.instagramShortcode, 'Blocked3');
    assert.ok(blockedCand.warnings.some(w => /Assisted draft/i.test(w)));

    // Verify preview did NOT mutate store
    assert.equal(store.getCatalog().products.length, 5);
    assert.equal(fs.readdirSync(store.getMediaDir()).length, 0);

    // 2. Export preview (Meta posts_1.json with existing duplicate DfnF8-nkdJi + non_product)
    const exportPrev = await fetch(`${base}/api/admin/import/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        mode: 'export',
        payload: [
          {
            permalink: 'https://www.instagram.com/retromod.za/p/DfnF8-nkdJi/',
            creation_timestamp: 1794420619,
            media: [{ uri: 'media/posts/marantz.jpg' }],
            title: 'MARANTZ MODEL TWENTY NINE STEREO RECEIVER | USA, CIRCA EARLY 1970s\n\nPrice : R6 950.00'
          },
          {
            creation_timestamp: 1794420619,
            title: 'WE BUY VINTAGE HI-FI!\nKindly send @retromod.za a DM to sell.'
          }
        ]
      })
    });
    assert.equal(exportPrev.status, 200);
    const exportData = await exportPrev.json();
    assert.equal(exportData.items[0].action, 'duplicate');
    assert.equal(exportData.items[1].action, 'non_product');

    // 3. Non-array commit -> 400
    const badCommit = await fetch(`${base}/api/admin/import/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ items: 'not-an-array' })
    });
    assert.equal(badCommit.status, 400);

    // 4. Commit mixed batch:
    // - lampCand (valid create + downloads TINY_JPEG to /media/<id>.jpg)
    // - flat PNG data URI item (valid create -> /media/<id>.png)
    // - existing marantz-twenty-nine update (price -> 7250)
    // - disguised SVG fake.jpg (rejected by magic bytes)
    // - unsafe javascript: image (rejected)
    // - duplicate id in batch (rejected)
    // - missing title / negative price (rejected)
    const pngDataUri = `data:image/png;base64,${TINY_PNG.toString('base64')}`;
    const svgDataUri = `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`;

    const commitRes = await fetch(`${base}/api/admin/import/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        downloadImages: true,
        items: [
          lampCand,
          {
            tempId: 'flat-png-1',
            action: 'create',
            id: 'braun-sk55-turntable',
            title: 'Braun SK 55 Phonosuper',
            maker: 'Braun · Dieter Rams',
            origin: 'Germany',
            era: '1963',
            category: 'audio',
            price: 18500,
            quantity: 1,
            status: 'available',
            imageData: pngDataUri
          },
          {
            tempId: 'upd-1',
            action: 'update',
            matchedProductId: 'marantz-twenty-nine',
            candidate: {
              id: 'marantz-twenty-nine',
              title: 'Marantz Model Twenty Nine Stereo Receiver',
              category: 'audio',
              price: 7250,
              quantity: 1,
              status: 'available'
            }
          },
          {
            tempId: 'bad-svg-remote',
            action: 'create',
            candidate: {
              id: 'svg-spoof-lamp',
              title: 'Spoof Lamp',
              category: 'lighting',
              price: 900,
              quantity: 1,
              status: 'available',
              remoteImageUrl: `http://127.0.0.1:${mockPort}/img/fake.jpg`
            }
          },
          {
            tempId: 'bad-xss-img',
            action: 'create',
            candidate: {
              id: 'xss-lamp',
              title: 'XSS Lamp',
              category: 'lighting',
              price: 900,
              quantity: 1,
              status: 'available',
              image: 'javascript:alert(1)'
            }
          },
          {
            tempId: 'bad-svg-data',
            action: 'create',
            candidate: {
              id: 'svg-data-lamp',
              title: 'SVG Data Lamp',
              category: 'lighting',
              price: 900,
              quantity: 1,
              status: 'available',
              imageData: svgDataUri
            }
          },
          {
            tempId: 'dup-in-batch',
            action: 'create',
            candidate: {
              id: 'braun-sk55-turntable',
              title: 'Braun Duplicate',
              category: 'audio',
              price: 18500,
              quantity: 1,
              status: 'available'
            }
          },
          {
            tempId: 'malformed-neg',
            action: 'create',
            candidate: {
              id: 'broken-item',
              title: '',
              category: 'audio',
              price: -100,
              quantity: 1,
              status: 'available'
            }
          }
        ]
      })
    });

    assert.equal(commitRes.status, 200);
    const commitData = await commitRes.json();
    assert.equal(commitData.created, 2);
    assert.equal(commitData.updated, 1);
    assert.equal(commitData.rejected, 5);
    assert.equal(commitData.errors.length, 5);

    // Check persisted catalog & local media serving
    const createdLamp = store.getProductById(lampCand.candidate.id);
    assert.ok(createdLamp);
    assert.equal(createdLamp.image, `/media/${lampCand.candidate.id}.jpg`);

    const servedJpg = await fetch(`${base}${createdLamp.image}`);
    assert.equal(servedJpg.status, 200);
    assert.equal(servedJpg.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await servedJpg.arrayBuffer()), TINY_JPEG);

    const createdBraun = store.getProductById('braun-sk55-turntable');
    assert.ok(createdBraun);
    assert.equal(createdBraun.image, '/media/braun-sk55-turntable.png');
    const servedPng = await fetch(`${base}${createdBraun.image}`);
    assert.equal(servedPng.status, 200);
    assert.equal(servedPng.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await servedPng.arrayBuffer()), TINY_PNG);

    // Updated product & untouched existing products
    assert.equal(store.getProductById('marantz-twenty-nine').price, 7250);
    assert.equal(store.getProductById('pioneer-sa-6300').price, 3950);

    // Rejected items did NOT enter catalog
    assert.equal(store.getProductById('svg-spoof-lamp'), null);
    assert.equal(store.getProductById('xss-lamp'), null);
    assert.equal(store.getProductById('svg-data-lamp'), null);
    assert.equal(store.getProductById('broken-item'), null);

    // Audit log written
    const logs = store.getImportLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].created, 2);
    assert.equal(logs[0].updated, 1);
    assert.equal(logs[0].rejected, 5);
  });
});
