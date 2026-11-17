import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

export function normText(str) {
  return String(str ?? '')
    .replace(/[\s\u00a0\u202f]+/g, ' ')
    .trim();
}

export function resolveChromiumExecutable() {
  if (process.env.RETROMOD_CHROME_PATH && fs.existsSync(process.env.RETROMOD_CHROME_PATH)) {
    return process.env.RETROMOD_CHROME_PATH;
  }

  const localAppData = process.env.LOCALAPPDATA || '';
  const msPlaywrightDir = localAppData ? path.join(localAppData, 'ms-playwright') : '';

  if (msPlaywrightDir && fs.existsSync(msPlaywrightDir)) {
    const entries = fs.readdirSync(msPlaywrightDir, { withFileTypes: true }).filter((d) => d.isDirectory());

    const chromiumDirs = entries
      .map((d) => ({ name: d.name, match: /^chromium-(\d+)$/.exec(d.name) }))
      .filter((x) => x.match)
      .sort((a, b) => Number(b.match[1]) - Number(a.match[1]));

    for (const dir of chromiumDirs) {
      const candidate = path.join(msPlaywrightDir, dir.name, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(candidate)) return candidate;
      const linuxCandidate = path.join(msPlaywrightDir, dir.name, 'chrome-linux', 'chrome');
      if (fs.existsSync(linuxCandidate)) return linuxCandidate;
    }

    const shellDirs = entries
      .map((d) => ({ name: d.name, match: /^chromium_headless_shell-(\d+)$/.exec(d.name) }))
      .filter((x) => x.match)
      .sort((a, b) => Number(b.match[1]) - Number(a.match[1]));

    for (const dir of shellDirs) {
      const candidate = path.join(
        msPlaywrightDir,
        dir.name,
        'chrome-headless-shell-win64',
        'chrome-headless-shell.exe'
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const systemCandidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    localAppData ? path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe') : '',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);

  for (const candidate of systemCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    'Unable to locate Chromium/Chrome/Edge executable. Set RETROMOD_CHROME_PATH or install ms-playwright chromium.'
  );
}

export async function launchBrowser(options = {}) {
  const executablePath = resolveChromiumExecutable();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    ...options
  });
  return { browser, executablePath };
}

export function attachErrorCollectors(page, baseOrigin, options = {}) {
  const pageErrors = [];
  const consoleErrors = [];
  const serverErrors = [];
  const allowedStatus = options.allowedStatus ?? new Set([400, 401, 403, 404, 409]);
  const strictClientErrors = Boolean(options.strictClientErrors);
  const ignore404Prefixes = options.ignore404Prefixes ?? [];
  const ignoreHttpConsolePrefixes = options.ignoreHttpConsolePrefixes ?? [];

  page.on('pageerror', (err) => {
    pageErrors.push(err.message || String(err));
  });

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const locUrl = msg.location()?.url || '';
    if (
      ignore404Prefixes.length > 0 &&
      /404\s*\(Not Found\)/i.test(text) &&
      ignore404Prefixes.some((p) => locUrl.includes(p))
    ) {
      return;
    }
    if (
      ignoreHttpConsolePrefixes.length > 0 &&
      /status of (400|409)\b/i.test(text) &&
      ignoreHttpConsolePrefixes.some((p) => locUrl.includes(p))
    ) {
      return;
    }
    // Tolerate third-party network noise when running offline (fonts.googleapis.com, cloudfront.net, google maps)
    const isThirdPartyLoc =
      locUrl &&
      !locUrl.startsWith(baseOrigin) &&
      !locUrl.startsWith('data:') &&
      !locUrl.startsWith('blob:');
    const isOfflineResourceNoise =
      text.includes('Failed to load resource') &&
      (isThirdPartyLoc ||
        /fonts\.googleapis|cloudfront\.net|google\.com\/maps/i.test(text));
    if (isThirdPartyLoc || isOfflineResourceNoise) return;
    consoleErrors.push(locUrl ? `${text} (${locUrl})` : text);
  });

  page.on('response', (res) => {
    const url = res.url();
    if (!url.startsWith(baseOrigin)) return;
    const status = res.status();
    if (status >= 500) {
      serverErrors.push(`${status} ${url}`);
    } else if (strictClientErrors && status >= 400 && !allowedStatus.has(status)) {
      serverErrors.push(`${status} ${url}`);
    }
  });

  return {
    pageErrors,
    consoleErrors,
    serverErrors,
    assertClean(label = 'page') {
      const problems = [];
      if (pageErrors.length) problems.push(`pageerror: ${pageErrors.join(' | ')}`);
      if (consoleErrors.length) problems.push(`console.error: ${consoleErrors.join(' | ')}`);
      if (serverErrors.length) problems.push(`5xx/unexpected response: ${serverErrors.join(' | ')}`);
      if (problems.length) {
        throw new Error(`[${label}] Runtime/console errors detected: ${problems.join('; ')}`);
      }
    },
    clear() {
      pageErrors.length = 0;
      consoleErrors.length = 0;
      serverErrors.length = 0;
    }
  };
}

export async function waitForCatalogHydration(page, timeout = 8000) {
  await page.waitForLoadState('domcontentloaded', { timeout });
  await page
    .waitForLoadState('networkidle', { timeout: 2500 })
    .catch(() => {});
  await page
    .waitForFunction(() => document.fonts ? document.fonts.status === 'loaded' : true, null, {
      timeout: 1500
    })
    .catch(() => {});
}

export async function assertProductImagesHealthy(page, baseUrl, options = {}) {
  const minCount = options.minCount ?? 1;
  const selector =
    options.selector ??
    'main a[href*="product"] img, main article img, #pdImg img, .hslide.on img';

  const imgInfos = await page.locator(selector).evaluateAll((imgs) =>
    imgs.map((img) => ({
      src: img.getAttribute('src') || '',
      currentSrc: img.currentSrc || img.src || '',
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      noImgClass: Boolean(img.closest('.no-img'))
    }))
  );

  if (imgInfos.length < minCount) {
    throw new Error(
      `Expected at least ${minCount} product image(s) matching "${selector}", found ${imgInfos.length}`
    );
  }

  for (const info of imgInfos) {
    if (!info.complete || info.naturalWidth <= 0 || info.naturalHeight <= 0) {
      throw new Error(
        `Broken product image detected: src="${info.src}" complete=${info.complete} natural=${info.naturalWidth}x${info.naturalHeight}`
      );
    }
    if (info.noImgClass) {
      throw new Error(`Image container has fallback .no-img class: src="${info.src}"`);
    }
    const resolved = new URL(info.currentSrc || info.src, baseUrl).toString();
    if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
      const res = await fetch(resolved, { signal: AbortSignal.timeout(3000) });
      if (res.status !== 200) {
        throw new Error(`Product image fetch returned HTTP ${res.status} for ${resolved}`);
      }
      const ctype = res.headers.get('content-type') || '';
      if (!ctype.toLowerCase().startsWith('image/')) {
        throw new Error(`Product image ${resolved} returned non-image Content-Type: "${ctype}"`);
      }
    }
  }

  return imgInfos;
}
