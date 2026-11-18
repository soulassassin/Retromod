'use strict';

// Supabase-backed store with the same interface as lib/store.js (createStore),
// except every read is async. Writes go through the `apply_changes` Postgres
// function so each withTransaction() commit is atomic and optimistically locked
// on a per-row `rev` counter; on a conflict the transaction is re-run.

const fs = require('fs');
const path = require('path');
const { normalizeProduct, computeStats, DEFAULT_SEED_PATH } = require('./store');
const { HttpError } = require('./http');

const MEDIA_BUCKET = 'media';
const MAX_ATTEMPTS = 4;
const MEDIA_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif'
};
const SAFE_MEDIA_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,120}\.(?:jpg|jpeg|png|webp|gif)$/i;

class ConflictError extends Error {}

function getSupabaseConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const anonKey = String(env.SUPABASE_ANON_KEY || '').trim();
  if (!url || !serviceKey) return null;
  return { url, serviceKey, anonKey };
}

function createSupabaseClient({ url, serviceKey }) {
  async function request(method, pathname, { body, headers = {}, raw = false } = {}) {
    const res = await fetch(`${url}${pathname}`, {
      method,
      headers: {
        apikey: serviceKey,
        // New-style sb_secret_ keys are not JWTs: send them only as apikey.
        ...(serviceKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${serviceKey}` }),
        ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body === undefined ? undefined : (raw ? body : JSON.stringify(body))
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    if (!res.ok) {
      const code = json && json.code;
      if (code === '40001' || code === '23505') {
        throw new ConflictError((json && json.message) || 'conflict');
      }
      const msg = (json && (json.message || json.error || json.msg)) || text || res.statusText;
      const err = new Error(`Supabase ${method} ${pathname.split('?')[0]} failed (${res.status}): ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
  return { request };
}

function createSupabaseStore(options = {}) {
  const config = options.config || getSupabaseConfig();
  if (!config) {
    throw new Error('Supabase store requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  const client = options.client || createSupabaseClient(config);
  const seedPath = path.resolve(options.seedPath || DEFAULT_SEED_PATH);

  let metaCache = null;
  function getMeta() {
    if (metaCache) return metaCache;
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    metaCache = {
      links: seed.links || {},
      address: Array.isArray(seed.address) ? seed.address : [],
      followers: seed.followers ?? 55.3,
      posts: seed.posts ?? 471,
      categories: Array.isArray(seed.categories) ? seed.categories : []
    };
    return metaCache;
  }

  async function loadProductRows() {
    const rows = await client.request('GET', '/rest/v1/products?select=id,data,rev,sort_order&order=sort_order.asc,id.asc');
    return Array.isArray(rows) ? rows : [];
  }

  async function loadOrderRows() {
    const rows = await client.request('GET', '/rest/v1/orders?select=order_ref,data,rev&order=created_at.asc');
    return Array.isArray(rows) ? rows : [];
  }

  async function readCatalogRaw() {
    const rows = await loadProductRows();
    return {
      version: 1,
      ...getMeta(),
      products: rows.map(r => normalizeProduct(r.data))
    };
  }

  async function getCatalog(filters = {}) {
    const catalog = await readCatalogRaw();
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
        const haystack = normSearch([
          p.id, p.title, p.maker, p.origin, p.era, p.category, p.lede,
          (p.body || []).join(' '),
          (p.specs || []).map(s => s.join(' ')).join(' '),
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

  async function getProductById(id) {
    if (!id) return null;
    const rows = await client.request('GET', `/rest/v1/products?select=data&id=eq.${encodeURIComponent(String(id))}`);
    return Array.isArray(rows) && rows[0] ? normalizeProduct(rows[0].data) : null;
  }

  async function getOrders() {
    const rows = await loadOrderRows();
    return rows.map(r => r.data);
  }

  async function getOrderByRef(orderRef) {
    if (!orderRef) return null;
    const rows = await client.request('GET', `/rest/v1/orders?select=data&order_ref=eq.${encodeURIComponent(String(orderRef).trim())}`);
    return Array.isArray(rows) && rows[0] ? rows[0].data : null;
  }

  async function getImportLogs() {
    const rows = await client.request('GET', '/rest/v1/import_logs?select=data&order=id.asc');
    return Array.isArray(rows) ? rows.map(r => r.data) : [];
  }

  async function uploadMedia(fileName, buffer) {
    if (!SAFE_MEDIA_NAME_RE.test(fileName)) throw new Error('Unsafe media file name');
    const ext = fileName.split('.').pop().toLowerCase();
    await client.request('POST', `/storage/v1/object/${MEDIA_BUCKET}/${encodeURIComponent(fileName)}`, {
      body: buffer,
      raw: true,
      headers: {
        'Content-Type': MEDIA_TYPES[ext] || 'application/octet-stream',
        'x-upsert': 'true',
        'Cache-Control': 'max-age=300'
      }
    });
  }

  async function deleteMedia(fileNames) {
    const names = fileNames.filter(n => SAFE_MEDIA_NAME_RE.test(n));
    if (!names.length) return;
    await client.request('DELETE', `/storage/v1/object/${MEDIA_BUCKET}`, { body: { prefixes: names } });
  }

  function getMediaPublicUrl(fileName) {
    return `${config.url}/storage/v1/object/public/${MEDIA_BUCKET}/${encodeURIComponent(fileName)}`;
  }

  async function runOnce(fn) {
    const [productRows, orderRows] = await Promise.all([loadProductRows(), loadOrderRows()]);
    const productsBefore = new Map(productRows.map(r => [r.id, r]));
    const ordersBefore = new Map(orderRows.map(r => [r.order_ref, r]));
    const sortOrders = productRows.map(r => r.sort_order);
    let minSort = sortOrders.length ? Math.min(...sortOrders) : 0;
    let maxSort = sortOrders.length ? Math.max(...sortOrders) : 0;

    const loaded = productRows.map(r => normalizeProduct(r.data));
    const snapshot = new Map(loaded.map(p => [p.id, JSON.stringify(p)]));
    const catalog = { version: 1, ...getMeta(), products: structuredClone(loaded) };
    const orders = { version: 1, orders: orderRows.map(r => structuredClone(r.data)) };
    const importLogs = { version: 1, logs: [] };

    const state = {
      catalog,
      orders,
      importLogs,
      dataDir: null,
      mediaDir: null,
      writeMedia: uploadMedia
    };

    const outcome = await fn(state);
    const wrapped = outcome && typeof outcome === 'object' &&
      ('saveCatalog' in outcome || 'saveOrders' in outcome || 'saveImportLogs' in outcome || 'result' in outcome);
    if (!wrapped) return outcome;

    const changes = {
      product_deletes: [],
      product_updates: [],
      product_inserts: [],
      order_updates: [],
      order_inserts: [],
      log_inserts: []
    };

    if (outcome.saveCatalog) {
      const nextProducts = (Array.isArray(state.catalog.products) ? state.catalog.products : []).map(p => normalizeProduct(p));
      const seen = new Set();
      const firstExistingIdx = nextProducts.findIndex(p => productsBefore.has(p.id));
      nextProducts.forEach((p, idx) => {
        seen.add(p.id);
        const before = productsBefore.get(p.id);
        if (!before) {
          const atFront = firstExistingIdx !== -1 && idx < firstExistingIdx;
          const sortOrder = atFront ? --minSort : ++maxSort;
          changes.product_inserts.push({ id: p.id, data: p, sort_order: sortOrder });
        } else if (snapshot.get(p.id) !== JSON.stringify(p)) {
          changes.product_updates.push({ id: p.id, data: p, rev: before.rev });
        }
      });
      for (const [id, before] of productsBefore) {
        if (!seen.has(id)) changes.product_deletes.push({ id, rev: before.rev });
      }
    }

    if (outcome.saveOrders) {
      for (const o of Array.isArray(state.orders.orders) ? state.orders.orders : []) {
        if (!o || !o.orderRef) continue;
        const before = ordersBefore.get(o.orderRef);
        if (!before) {
          changes.order_inserts.push({ order_ref: o.orderRef, data: o });
        } else if (JSON.stringify(before.data) !== JSON.stringify(o)) {
          changes.order_updates.push({ order_ref: o.orderRef, data: o, rev: before.rev });
        }
      }
    }

    if (outcome.saveImportLogs) {
      changes.log_inserts = Array.isArray(state.importLogs.logs) ? state.importLogs.logs : [];
    }

    const hasChanges = Object.values(changes).some(list => list.length);
    if (hasChanges) {
      await client.request('POST', '/rest/v1/rpc/apply_changes', { body: { changes } });
    }

    return outcome.result;
  }

  async function withTransaction(fn) {
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await runOnce(fn);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        lastErr = err;
        await new Promise(r => setTimeout(r, 40 * (attempt + 1) + Math.random() * 60));
      }
    }
    console.error('withTransaction gave up after conflicts:', lastErr && lastErr.message);
    throw new HttpError(409, 'The shop was being updated at the same moment. Please try again.');
  }

  return {
    kind: 'supabase',
    config,
    client,
    getDataDir: () => null,
    getMediaDir: () => null,
    getMediaPublicUrl,
    ensureStore: async () => {},
    ensureStoreSync: () => {},
    getCatalog,
    getProductById,
    computeStats,
    normalizeProduct,
    withTransaction,
    getOrders,
    getOrderByRef,
    getImportLogs,
    uploadMedia,
    deleteMedia
  };
}

function normSearch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’']/g, '');
}

module.exports = {
  createSupabaseStore,
  createSupabaseClient,
  getSupabaseConfig,
  ConflictError,
  SAFE_MEDIA_NAME_RE
};
