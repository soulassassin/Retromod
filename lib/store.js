'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', 'data');
const DEFAULT_SEED_PATH = path.resolve(__dirname, '..', 'data', 'seed-catalog.json');
const VALID_STATUSES = new Set(['available', 'reserved', 'sold']);
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// Per-directory async write-queue mutex so concurrent requests serialize cleanly.
const dirLocks = new Map();
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

function normSearch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019']/g, '');
}

function withLock(dir, fn) {
  const resolved = path.resolve(dir);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const prev = dirLocks.get(key) || Promise.resolve();
  const next = prev.then(() => fn());
  const tail = next.catch(() => {});
  dirLocks.set(key, tail);
  return next.finally(() => {
    if (dirLocks.get(key) === tail) {
      dirLocks.delete(key);
    }
  });
}

function writeJsonAtomicSync(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const payload = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmpPath, payload, 'utf8');

  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_RENAME_CODES.has(err.code) || attempt === 5) {
        break;
      }
      sleepSync(15 * (attempt + 1));
    }
  }

  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch {
    // ignore cleanup error
  }
  throw lastErr;
}

function readJsonSync(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeProduct(raw, existing = null) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const base = existing && typeof existing === 'object' ? existing : {};

  const id = String(src.id !== undefined ? src.id : (base.id || '')).trim();
  const rawStatus = src.status !== undefined ? src.status : base.status;
  let status = VALID_STATUSES.has(rawStatus) ? rawStatus : 'available';

  let quantity;
  if (src.quantity !== undefined && src.quantity !== null && src.quantity !== '') {
    const parsed = Number(src.quantity);
    quantity = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : (status === 'sold' ? 0 : 1);
  } else if (base.quantity !== undefined && base.quantity !== null) {
    const parsed = Number(base.quantity);
    quantity = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : (status === 'sold' ? 0 : 1);
  } else {
    quantity = status === 'sold' ? 0 : 1;
  }

  // Hard stock/status invariants
  if (status === 'sold') {
    quantity = 0;
  } else if (quantity <= 0) {
    quantity = 0;
    status = 'sold';
  }

  const rawPrice = src.price !== undefined ? src.price : base.price;
  const priceNum = Number(rawPrice);
  const price = Number.isFinite(priceNum) ? Math.max(0, Math.round(priceNum)) : 0;

  const rawBody = src.body !== undefined ? src.body : base.body;
  const body = Array.isArray(rawBody)
    ? rawBody.map(line => String(line)).filter(Boolean)
    : (rawBody ? [String(rawBody)] : []);

  const rawSpecs = src.specs !== undefined ? src.specs : base.specs;
  const specs = Array.isArray(rawSpecs)
    ? rawSpecs
        .filter(pair => Array.isArray(pair) && pair.length >= 2)
        .map(([k, v]) => [String(k), String(v)])
    : [];

  const image = String(
    src.image !== undefined
      ? (src.image || `assets/stock/${id}.jpg`)
      : (base.image || `assets/stock/${id}.jpg`)
  );

  return {
    id,
    title: String(src.title !== undefined ? src.title : (base.title || '')),
    maker: String(src.maker !== undefined ? src.maker : (base.maker || '')),
    origin: String(src.origin !== undefined ? src.origin : (base.origin || '')),
    era: String(src.era !== undefined ? src.era : (base.era || '')),
    category: String(src.category !== undefined ? src.category : (base.category || 'furniture')),
    price,
    quantity,
    status,
    added: String(src.added !== undefined ? src.added : (base.added || new Date().toISOString().slice(0, 10))),
    image,
    instagramUrl: String(src.instagramUrl !== undefined ? src.instagramUrl : (base.instagramUrl || '')),
    instagramShortcode: String(src.instagramShortcode !== undefined ? src.instagramShortcode : (base.instagramShortcode || '')),
    lede: String(src.lede !== undefined ? src.lede : (base.lede || '')),
    body,
    specs,
    updatedAt: String(src.updatedAt || base.updatedAt || new Date().toISOString())
  };
}

function computeStats(catalog) {
  const products = Array.isArray(catalog && catalog.products) ? catalog.products : [];
  const categoriesList = Array.isArray(catalog && catalog.categories) ? catalog.categories : [];

  let availableCount = 0;
  let reservedCount = 0;
  let soldCount = 0;
  let totalUnits = 0;
  let totalValue = 0;
  const byCategory = { all: products.length };
  const availableByCategory = { all: 0 };

  for (const cat of categoriesList) {
    if (cat && cat.id && cat.id !== 'all') {
      byCategory[cat.id] = 0;
      availableByCategory[cat.id] = 0;
    }
  }

  for (const p of products) {
    const qty = Math.max(0, Number(p.quantity) || 0);
    const isSold = p.status === 'sold' || qty <= 0;
    const isReserved = !isSold && p.status === 'reserved';

    if (isSold) {
      soldCount += 1;
    } else if (isReserved) {
      reservedCount += 1;
    } else {
      availableCount += 1;
    }

    totalUnits += qty;
    if (!isSold) {
      totalValue += (Number(p.price) || 0) * qty;
    }

    const catId = p.category || 'other';
    byCategory[catId] = (byCategory[catId] || 0) + 1;
    if (!isSold) {
      availableByCategory.all += 1;
      availableByCategory[catId] = (availableByCategory[catId] || 0) + 1;
    }
  }

  return {
    total: products.length,
    count: products.length,
    totalProducts: products.length,
    available: availableCount,
    availableCount,
    reserved: reservedCount,
    reservedCount,
    sold: soldCount,
    soldCount,
    totalUnits,
    totalValue,
    posts: catalog && catalog.posts != null ? catalog.posts : 471,
    followers: catalog && catalog.followers != null ? catalog.followers : 55.3,
    byCategory,
    availableByCategory
  };
}

function createStore(options = {}) {
  const pinnedDataDir = options.dataDir ? path.resolve(options.dataDir) : null;
  const seedPath = path.resolve(options.seedPath || DEFAULT_SEED_PATH);

  function getDataDir() {
    if (pinnedDataDir) return pinnedDataDir;
    return path.resolve(process.env.RETROMOD_DATA_DIR || DEFAULT_DATA_DIR);
  }

  function getMediaDir() {
    return path.join(getDataDir(), 'media');
  }

  function getPaths(dir = getDataDir()) {
    return {
      dir,
      mediaDir: path.join(dir, 'media'),
      catalogPath: path.join(dir, 'catalog.json'),
      ordersPath: path.join(dir, 'orders.json'),
      importLogsPath: path.join(dir, 'import-logs.json')
    };
  }

  function ensureStoreSync() {
    const paths = getPaths();
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.mkdirSync(paths.mediaDir, { recursive: true });

    if (!fs.existsSync(paths.catalogPath)) {
      const seed = readJsonSync(seedPath);
      const seededCatalog = {
        version: seed.version || 1,
        links: seed.links || {},
        address: Array.isArray(seed.address) ? seed.address : [],
        followers: seed.followers ?? 55.3,
        posts: seed.posts ?? 471,
        categories: Array.isArray(seed.categories) ? seed.categories : [],
        products: Array.isArray(seed.products)
          ? seed.products.map(p => normalizeProduct(p))
          : []
      };
      writeJsonAtomicSync(paths.catalogPath, seededCatalog);
    }

    if (!fs.existsSync(paths.ordersPath)) {
      writeJsonAtomicSync(paths.ordersPath, { version: 1, orders: [] });
    }

    if (!fs.existsSync(paths.importLogsPath)) {
      writeJsonAtomicSync(paths.importLogsPath, { version: 1, logs: [] });
    }

    return paths;
  }

  async function ensureStore() {
    const dir = getDataDir();
    return withLock(dir, () => ensureStoreSync());
  }

  function readCatalogRaw() {
    const paths = ensureStoreSync();
    const raw = readJsonSync(paths.catalogPath);
    const products = Array.isArray(raw.products)
      ? raw.products.map(p => normalizeProduct(p))
      : [];
    return {
      version: raw.version || 1,
      links: raw.links || {},
      address: Array.isArray(raw.address) ? raw.address : [],
      followers: raw.followers ?? 55.3,
      posts: raw.posts ?? 471,
      categories: Array.isArray(raw.categories) ? raw.categories : [],
      products
    };
  }

  function getCatalog(filters = {}) {
    const catalog = readCatalogRaw();
    const stats = computeStats(catalog);
    let products = catalog.products;

    const category = filters.category ? String(filters.category).trim().toLowerCase() : '';
    const status = filters.status ? String(filters.status).trim().toLowerCase() : '';
    const query = filters.q ? normSearch(String(filters.q).trim()) : '';

    if (category && category !== 'all') {
      products = products.filter(p => String(p.category || '').toLowerCase() === category);
    }

    if (status && status !== 'all') {
      products = products.filter(p => String(p.status || '').toLowerCase() === status);
    }

    if (query) {
      products = products.filter(p => {
        const bodyText = Array.isArray(p.body) ? p.body.join(' ') : String(p.body || '');
        const specsText = Array.isArray(p.specs)
          ? p.specs.map(s => (Array.isArray(s) ? s.join(' ') : String(s || ''))).join(' ')
          : '';
        const haystack = normSearch([
          p.id,
          p.title,
          p.maker,
          p.origin,
          p.era,
          p.category,
          p.lede,
          bodyText,
          specsText,
          p.instagramShortcode
        ].filter(Boolean).join(' '));
        return haystack.includes(query);
      });
    }

    return {
      links: catalog.links,
      address: catalog.address,
      followers: catalog.followers,
      posts: catalog.posts,
      categories: catalog.categories,
      stats,
      products
    };
  }

  function getProductById(id) {
    if (!id) return null;
    const catalog = readCatalogRaw();
    const found = catalog.products.find(p => p.id === String(id));
    return found || null;
  }

  async function withTransaction(fn) {
    const dir = getDataDir();
    return withLock(dir, async () => {
      const paths = ensureStoreSync();
      const catalog = readCatalogRaw();
      const ordersData = readJsonSync(paths.ordersPath);
      const importLogsData = readJsonSync(paths.importLogsPath);

      const state = {
        catalog: structuredClone(catalog),
        orders: structuredClone(ordersData),
        importLogs: structuredClone(importLogsData),
        dataDir: paths.dir,
        mediaDir: paths.mediaDir
      };

      const outcome = await fn(state);

      if (outcome && typeof outcome === 'object' && ('saveCatalog' in outcome || 'saveOrders' in outcome || 'saveImportLogs' in outcome || 'result' in outcome)) {
        if (outcome.saveCatalog) {
          state.catalog.products = Array.isArray(state.catalog.products)
            ? state.catalog.products.map(p => normalizeProduct(p))
            : [];
          writeJsonAtomicSync(paths.catalogPath, state.catalog);
        }
        if (outcome.saveOrders) {
          writeJsonAtomicSync(paths.ordersPath, state.orders);
        }
        if (outcome.saveImportLogs) {
          writeJsonAtomicSync(paths.importLogsPath, state.importLogs);
        }
        return outcome.result;
      }

      return outcome;
    });
  }

  async function patchProduct(id, patch) {
    if (!id || !patch || typeof patch !== 'object') return null;
    return withTransaction(({ catalog }) => {
      const idx = catalog.products.findIndex(p => p.id === String(id));
      if (idx === -1) return { result: null };

      const existing = catalog.products[idx];
      const merged = {
        ...existing,
        ...patch,
        id: existing.id,
        updatedAt: new Date().toISOString()
      };

      // If restocking a previously sold item without explicitly passing status, make it available.
      if (
        patch.quantity !== undefined &&
        Number(patch.quantity) > 0 &&
        patch.status === undefined &&
        existing.status === 'sold'
      ) {
        merged.status = 'available';
      }

      const normalized = normalizeProduct(merged, existing);
      catalog.products[idx] = normalized;
      return { saveCatalog: true, result: normalized };
    });
  }

  function getOrders() {
    const paths = ensureStoreSync();
    const data = readJsonSync(paths.ordersPath);
    return Array.isArray(data.orders) ? data.orders : [];
  }

  function getOrderByRef(orderRef) {
    if (!orderRef) return null;
    const target = String(orderRef).trim();
    const orders = getOrders();
    return orders.find(o => o.orderRef === target) || null;
  }

  function getImportLogs() {
    const paths = ensureStoreSync();
    const data = readJsonSync(paths.importLogsPath);
    return Array.isArray(data.logs) ? data.logs : [];
  }

  return {
    getDataDir,
    getMediaDir,
    ensureStore,
    ensureStoreSync,
    getCatalog,
    getProductById,
    computeStats,
    normalizeProduct,
    withTransaction,
    patchProduct,
    getOrders,
    getOrderByRef,
    getImportLogs
  };
}

const defaultStore = createStore();

module.exports = {
  DEFAULT_DATA_DIR,
  DEFAULT_SEED_PATH,
  VALID_STATUSES,
  createStore,
  normalizeProduct,
  computeStats,
  writeJsonAtomicSync,
  getDataDir: defaultStore.getDataDir,
  getMediaDir: defaultStore.getMediaDir,
  ensureStore: defaultStore.ensureStore,
  ensureStoreSync: defaultStore.ensureStoreSync,
  getCatalog: defaultStore.getCatalog,
  getProductById: defaultStore.getProductById,
  withTransaction: defaultStore.withTransaction,
  patchProduct: defaultStore.patchProduct,
  getOrders: defaultStore.getOrders,
  getOrderByRef: defaultStore.getOrderByRef,
  getImportLogs: defaultStore.getImportLogs
};
