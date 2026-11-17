import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, cleanupAllServers, DEFAULT_ADMIN_PASSWORD, REPO_ROOT } from './helpers/server.mjs';
import { launchBrowser, attachErrorCollectors } from './helpers/browser.mjs';
import { startMockInstagram } from './helpers/mock-instagram.mjs';
import { getTier1Tests } from './tiers/tier1-features.mjs';
import { getTier2Tests } from './tiers/tier2-boundaries.mjs';
import { getTier3Tests } from './tiers/tier3-combinations.mjs';
import { getTier4Tests } from './tiers/tier4-scenarios.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const CONTRACT_MOCK_PATH = path.join(__dirname, 'helpers', 'contract-mock-server.mjs');

function parseArgs(argv) {
  const opts = { tier: 'all', selfCheck: false, baseUrl: '' };
  for (const arg of argv) {
    if (arg === '--self-check') opts.selfCheck = true;
    else if (arg.startsWith('--tier=')) opts.tier = arg.slice('--tier='.length).toLowerCase();
    else if (arg.startsWith('--base-url=')) opts.baseUrl = arg.slice('--base-url='.length).replace(/\/+$/, '');
  }
  if (!['1', '2', '3', '4', 'all'].includes(opts.tier)) {
    throw new Error(`Invalid --tier value "${opts.tier}". Expected 1|2|3|4|all.`);
  }
  return opts;
}

async function runTestList(label, tests, ctx) {
  let passed = 0;
  let failed = 0;
  const failures = [];
  const t0 = Date.now();

  console.log(`\n=== ${label} (${tests.length} tests) ===`);
  for (const t of tests) {
    const start = Date.now();
    try {
      await t.fn(ctx);
      passed++;
      console.log(`  [PASS] ${t.id} (${t.feature}) ${t.name} (${Date.now() - start}ms)`);
    } catch (err) {
      failed++;
      const msg = err?.stack || err?.message || String(err);
      failures.push({ id: t.id, name: t.name, error: msg });
      console.error(`  [FAIL] ${t.id} (${t.feature}) ${t.name} (${Date.now() - start}ms)\n         ${err?.message || err}`);
    }
  }

  return {
    label,
    total: tests.length,
    passed,
    failed,
    durationMs: Date.now() - t0,
    failures
  };
}

function printSummary(results) {
  console.log('\n================ E2E SUMMARY ================');
  let total = 0;
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    total += r.total;
    passed += r.passed;
    failed += r.failed;
    console.log(
      `  ${r.label.padEnd(28)} ${String(r.passed).padStart(3)}/${String(r.total).padEnd(3)} passed (${r.durationMs}ms)`
    );
  }
  console.log('---------------------------------------------');
  console.log(`  TOTAL: ${passed}/${total} passed, ${failed} failed`);
  console.log('=============================================\n');

  if (failed > 0) {
    console.error('Failure details:');
    for (const r of results) {
      for (const f of r.failures) {
        console.error(`\n--- ${f.id}: ${f.name} ---\n${f.error}`);
      }
    }
  }
  return failed === 0;
}

async function runSelfCheck(opts) {
  console.log('=== RETROMOD E2E --self-check ===');

  // Stage 1: Syntax, module exports & fixture validation
  console.log('\n[Stage 1] Validating ESM modules, test matrix thresholds, and fixtures...');
  const t1 = getTier1Tests();
  const t2 = getTier2Tests();
  const t3 = getTier3Tests();
  const t4 = getTier4Tests();
  assert.ok(t1.length >= 40, `Tier 1 must have >=40 tests, got ${t1.length}`);
  assert.ok(t2.length >= 40, `Tier 2 must have >=40 tests, got ${t2.length}`);
  assert.ok(t3.length >= 12, `Tier 3 must have >=12 tests, got ${t3.length}`);
  assert.ok(t4.length >= 6, `Tier 4 must have >=6 scenarios, got ${t4.length}`);

  const exportJson = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'ig-posts-export.json'), 'utf8'));
  assert.ok(Array.isArray(exportJson) && exportJson.length >= 5);
  const csvText = fs.readFileSync(path.join(FIXTURES_DIR, 'ig-stock.csv'), 'utf8');
  assert.ok(csvText.includes('instagram_url,title'));
  const capText = fs.readFileSync(path.join(FIXTURES_DIR, 'ig-captions.txt'), 'utf8');
  assert.ok(capText.includes('---'));

  const jpgBytes = fs.readFileSync(path.join(FIXTURES_DIR, 'valid-sample.jpg'));
  assert.ok(jpgBytes[0] === 0xff && jpgBytes[1] === 0xd8, 'valid-sample.jpg missing JPEG SOI header');
  const pngBytes = fs.readFileSync(path.join(FIXTURES_DIR, 'valid-sample.png'));
  assert.ok(
    pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47,
    'valid-sample.png missing PNG signature'
  );
  console.log(
    `  [PASS] Modules & fixtures valid (Tier1=${t1.length}, Tier2=${t2.length}, Tier3=${t3.length}, Tier4=${t4.length}, Total=${t1.length + t2.length + t3.length + t4.length})`
  );

  // Stage 2: Chromium launch + mock-instagram binary image decode smoke check
  console.log('\n[Stage 2] Launching headless Chromium & verifying mock-instagram image decode...');
  const mockIg = await startMockInstagram();
  const { browser, executablePath } = await launchBrowser();
  console.log(`  Using Chromium: ${executablePath}`);

  const smokeServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <img id="jpg" src="${mockIg.urls.validJpg}" alt="jpg">
      <img id="png" src="${mockIg.urls.validPng}" alt="png">
    </body></html>`);
  });

  try {
    await new Promise((r) => smokeServer.listen(0, '127.0.0.1', r));
    const smokePort = smokeServer.address().port;
    const smokeUrl = `http://127.0.0.1:${smokePort}`;

    const context = await browser.newContext();
    const page = await context.newPage();
    const collector = attachErrorCollectors(page, smokeUrl);
    await page.goto(smokeUrl, { waitUntil: 'load' });
    const dims = await page.evaluate(() => ({
      jpg: {
        complete: document.getElementById('jpg').complete,
        w: document.getElementById('jpg').naturalWidth
      },
      png: {
        complete: document.getElementById('png').complete,
        w: document.getElementById('png').naturalWidth
      }
    }));
    assert.ok(dims.jpg.complete && dims.jpg.w > 0, `JPEG decode failed: ${JSON.stringify(dims.jpg)}`);
    assert.ok(dims.png.complete && dims.png.w > 0, `PNG decode failed: ${JSON.stringify(dims.png)}`);
    collector.assertClean('stage2-smoke');
    await context.close();
    await new Promise((r) => smokeServer.close(r));
    console.log(`  [PASS] Chromium decoded JPEG (${dims.jpg.w}px) and PNG (${dims.png.w}px) cleanly`);

    // Stage 3: Execute full Tiers 1–4 against contract-mock-server.mjs
    console.log('\n[Stage 3] Executing full Tiers 1-4 against contract-mock-server.mjs...');
    const ctx = {
      isContractMock: true,
      browser,
      mockIg,
      fixturesDir: FIXTURES_DIR,
      spawnServer: (spawnOpts = {}) =>
        startServer({
          scriptPath: CONTRACT_MOCK_PATH,
          healthPath: '/api/health',
          ...spawnOpts
        })
    };

    const suitesToRun = [];
    if (opts.tier === 'all' || opts.tier === '1') suitesToRun.push(['Tier 1 (Features)', t1]);
    if (opts.tier === 'all' || opts.tier === '2') suitesToRun.push(['Tier 2 (Boundaries)', t2]);
    if (opts.tier === 'all' || opts.tier === '3') suitesToRun.push(['Tier 3 (Combinations)', t3]);
    if (opts.tier === 'all' || opts.tier === '4') suitesToRun.push(['Tier 4 (Scenarios)', t4]);

    const results = [];
    for (const [label, list] of suitesToRun) {
      results.push(await runTestList(label, list, ctx));
    }

    const allContractPassed = printSummary(results);
    if (!allContractPassed) {
      return false;
    }

    // Stage 4: Progressive real server.js startup/health/teardown probe
    console.log('[Stage 4] Probing real server.js startup, health, and clean teardown...');
    const realSrv = await startServer({
      scriptPath: path.join(REPO_ROOT, 'server.js'),
      healthPath: '/',
      acceptAnyHttp: true
    });
    try {
      const homeRes = await fetch(`${realSrv.baseUrl}/`);
      assert.equal(homeRes.status, 200, `Real server.js GET / returned ${homeRes.status}`);
      const healthRes = await fetch(`${realSrv.baseUrl}/api/health`);
      if (healthRes.status === 200) {
        const healthJson = await healthRes.json();
        assert.equal(healthJson.ok, true);
        console.log(`  [PASS] Real server.js M1+ /api/health = 200 (productCount=${healthJson.productCount})`);
      } else {
        console.log(
          `  [INFO] Real server.js is pre-M1 static baseline (GET / = 200, /api/health = ${healthRes.status}); M1+ checks skipped`
        );
      }
    } finally {
      await realSrv.stop();
    }
    console.log('  [PASS] Real server.js started on ephemeral port and tore down cleanly.');
    return true;
  } finally {
    await browser.close().catch(() => {});
    await mockIg.close().catch(() => {});
    await cleanupAllServers();
  }
}

async function runNormalSuite(opts) {
  const mockIg = await startMockInstagram();
  const { browser } = await launchBrowser();

  const ctx = {
    isContractMock: false,
    externalBaseUrl: opts.baseUrl || '',
    browser,
    mockIg,
    fixturesDir: FIXTURES_DIR,
    spawnServer: async (spawnOpts = {}) => {
      if (opts.baseUrl) {
        return {
          baseUrl: opts.baseUrl,
          port: Number(new URL(opts.baseUrl).port) || 80,
          dataDir: spawnOpts.dataDir || '',
          adminPassword: process.env.RETROMOD_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
          async stop() {}
        };
      }
      return startServer({
        scriptPath: path.join(REPO_ROOT, 'server.js'),
        healthPath: '/api/health',
        ...spawnOpts
      });
    }
  };

  try {
    const suites = [];
    if (opts.tier === 'all' || opts.tier === '1') suites.push(['Tier 1 (Features)', getTier1Tests()]);
    if (opts.tier === 'all' || opts.tier === '2') suites.push(['Tier 2 (Boundaries)', getTier2Tests()]);
    if (opts.tier === 'all' || opts.tier === '3') suites.push(['Tier 3 (Combinations)', getTier3Tests()]);
    if (opts.tier === 'all' || opts.tier === '4') suites.push(['Tier 4 (Scenarios)', getTier4Tests()]);

    const results = [];
    for (const [label, list] of suites) {
      results.push(await runTestList(label, list, ctx));
    }
    return printSummary(results);
  } finally {
    await browser.close().catch(() => {});
    await mockIg.close().catch(() => {});
    await cleanupAllServers();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ok = opts.selfCheck ? await runSelfCheck(opts) : await runNormalSuite(opts);
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Fatal runner error:', err);
  await cleanupAllServers();
  process.exit(1);
});
