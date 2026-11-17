'use strict';

const { sendJson, sendError, readJsonBody, HttpError } = require('../http');
const auth = require('../auth');
const defaultImportService = require('../instagram-import');
const { VALID_STATUSES } = require('../store');

const VALID_CATEGORIES = new Set(['audio', 'lighting', 'cameras', 'furniture', 'art']);
const SAFE_LOCAL_IMAGE_RE = /^(?:$|assets\/stock\/[a-z0-9._-]+\.(?:jpg|jpeg|png|webp|gif|avif)|\/media\/[a-z0-9._-]+\.(?:jpg|jpeg|png|webp|gif))$/i;

const ALLOWED_ORDER_STATUSES = new Set([
  'pending',
  'pending_payment',
  'confirmed',
  'paid',
  'ready_for_collection',
  'dispatched',
  'shipped',
  'completed',
  'cancelled'
]);

const EDITABLE_PRODUCT_FIELDS = [
  'title',
  'maker',
  'origin',
  'era',
  'category',
  'price',
  'quantity',
  'status',
  'lede',
  'body',
  'specs',
  'image',
  'instagramUrl',
  'instagramShortcode',
  'added'
];

function validateProductPatch(rawBody) {
  const patch = {};
  let fieldCount = 0;

  for (const key of EDITABLE_PRODUCT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(rawBody, key)) continue;
    const val = rawBody[key];
    fieldCount += 1;

    switch (key) {
      case 'title': {
        if (typeof val !== 'string' || !val.trim()) {
          throw new HttpError(400, 'Product title must be a non-empty string');
        }
        patch.title = val.trim();
        break;
      }
      case 'maker':
      case 'origin':
      case 'era':
      case 'lede':
      case 'instagramShortcode':
      case 'added': {
        if (typeof val !== 'string') {
          throw new HttpError(400, `${key} must be a string`);
        }
        patch[key] = val.trim();
        break;
      }
      case 'instagramUrl': {
        if (typeof val !== 'string') {
          throw new HttpError(400, 'instagramUrl must be a string');
        }
        const trimmed = val.trim();
        if (trimmed) {
          let parsed;
          try {
            parsed = new URL(trimmed);
          } catch {
            throw new HttpError(400, 'instagramUrl must be a valid URL');
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new HttpError(400, 'instagramUrl must use http or https');
          }
        }
        patch.instagramUrl = trimmed;
        break;
      }
      case 'category': {
        if (typeof val !== 'string' || !VALID_CATEGORIES.has(val.trim().toLowerCase())) {
          throw new HttpError(400, 'Invalid product category');
        }
        patch.category = val.trim().toLowerCase();
        break;
      }
      case 'price': {
        if (typeof val === 'boolean' || val === null || val === '') {
          throw new HttpError(400, 'Price must be a non-negative number');
        }
        const num = Number(val);
        if (!Number.isFinite(num) || num < 0) {
          throw new HttpError(400, 'Price must be a non-negative number');
        }
        patch.price = Math.round(num);
        break;
      }
      case 'quantity': {
        if (typeof val === 'boolean' || val === null || val === '') {
          throw new HttpError(400, 'Quantity must be a non-negative whole number');
        }
        const qty = Number(val);
        if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 0) {
          throw new HttpError(400, 'Quantity must be a non-negative whole number');
        }
        patch.quantity = qty;
        break;
      }
      case 'status': {
        if (typeof val !== 'string' || !VALID_STATUSES.has(val.trim())) {
          throw new HttpError(400, 'Invalid product status');
        }
        patch.status = val.trim();
        break;
      }
      case 'body': {
        if (Array.isArray(val)) {
          patch.body = val.map(line => String(line).trim()).filter(Boolean);
        } else if (typeof val === 'string') {
          patch.body = val.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
        } else {
          throw new HttpError(400, 'Product body must be an array of paragraphs or string');
        }
        break;
      }
      case 'specs': {
        if (!Array.isArray(val)) {
          throw new HttpError(400, 'Product specs must be an array of [label, value] pairs');
        }
        const cleaned = [];
        for (const pair of val) {
          if (!Array.isArray(pair) || pair.length < 2) {
            throw new HttpError(400, 'Each spec entry must be a [label, value] pair');
          }
          cleaned.push([String(pair[0]).trim(), String(pair[1]).trim()]);
        }
        patch.specs = cleaned;
        break;
      }
      case 'image': {
        if (typeof val !== 'string') {
          throw new HttpError(400, 'Product image must be a string path');
        }
        const trimmed = val.trim();
        if (trimmed.includes('..') || trimmed.includes('\\') || !SAFE_LOCAL_IMAGE_RE.test(trimmed)) {
          throw new HttpError(400, 'Image must be a safe local assets/stock/ or /media/ path');
        }
        patch.image = trimmed;
        break;
      }
      default:
        break;
    }
  }

  if (fieldCount === 0) {
    throw new HttpError(400, 'At least one editable product field is required');
  }

  return patch;
}

function createAdminRouter({ store, importService = defaultImportService } = {}) {
  if (!store) {
    throw new Error('createAdminRouter requires a store instance');
  }

  return {
    async handle(req, res, url) {
      const rawPath = url.pathname;
      const pathname = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;

      if (pathname !== '/api/admin' && !pathname.startsWith('/api/admin/')) {
        return false;
      }

      // 1. Public admin auth endpoints
      if (pathname === '/api/admin/login') {
        if (req.method !== 'POST') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'POST' });
          return true;
        }
        const body = await readJsonBody(req, { maxBytes: 16 * 1024, requireObject: true });
        const check = auth.verifyAdminPassword(body.password);
        if (!check.configured) {
          sendError(res, 503, 'Admin password is not configured');
          return true;
        }
        if (!check.ok) {
          sendError(res, 401, 'Invalid password');
          return true;
        }
        const { cookie } = auth.createSessionCookie(req);
        sendJson(res, 200, { authenticated: true }, { 'Set-Cookie': cookie });
        return true;
      }

      if (pathname === '/api/admin/logout') {
        if (req.method !== 'POST') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'POST' });
          return true;
        }
        sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': auth.clearSessionCookie(req) });
        return true;
      }

      if (pathname === '/api/admin/session') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'GET, HEAD' });
          return true;
        }
        const session = auth.verifySession(req);
        const extraHeaders = {};
        if (session && auth.shouldRotate(session)) {
          extraHeaders['Set-Cookie'] = auth.createSessionCookie(req).cookie;
        }
        sendJson(res, 200, { authenticated: Boolean(session) }, extraHeaders);
        return true;
      }

      // 2. Auth gate on all other /api/admin/* routes
      const session = auth.verifySession(req);
      if (!session) {
        sendError(res, 401, 'Authentication required');
        return true;
      }

      const sessionHeaders = auth.shouldRotate(session)
        ? { 'Set-Cookie': auth.createSessionCookie(req).cookie }
        : {};

      // 3. Protected routes
      if (pathname === '/api/admin/catalog') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'GET, HEAD', ...sessionHeaders });
          return true;
        }
        const category = url.searchParams.get('category') || '';
        const q = url.searchParams.get('q') || '';
        const status = url.searchParams.get('status') || '';
        const data = store.getCatalog({ category, q, status });
        sendJson(res, 200, {
          products: data.products,
          stats: data.stats
        }, sessionHeaders);
        return true;
      }

      if (pathname.startsWith('/api/admin/products/')) {
        if (req.method !== 'PATCH') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'PATCH', ...sessionHeaders });
          return true;
        }
        const encodedId = pathname.slice('/api/admin/products/'.length);
        if (!encodedId || encodedId.includes('/')) {
          sendError(res, 404, 'Product not found', {}, sessionHeaders);
          return true;
        }
        let id;
        try {
          id = decodeURIComponent(encodedId);
        } catch {
          throw new HttpError(400, 'Invalid product identifier');
        }

        const rawBody = await readJsonBody(req, { maxBytes: 256 * 1024, requireObject: true });
        const patch = validateProductPatch(rawBody);

        const updated = await store.withTransaction(({ catalog }) => {
          const idx = catalog.products.findIndex(p => p.id === id);
          if (idx === -1) {
            throw new HttpError(404, 'Product not found');
          }
          const existing = catalog.products[idx];

          if (patch.status === 'sold' && patch.quantity !== undefined && patch.quantity > 0) {
            throw new HttpError(400, 'Sold items must have quantity 0');
          }

          const merged = {
            ...existing,
            ...patch,
            id: existing.id,
            updatedAt: new Date().toISOString()
          };
          if (
            (patch.status === 'available' || patch.status === 'reserved') &&
            patch.quantity === undefined &&
            existing.quantity <= 0
          ) {
            merged.quantity = 1;
          }

          if (
            patch.quantity !== undefined &&
            patch.quantity > 0 &&
            patch.status === undefined &&
            existing.status === 'sold'
          ) {
            merged.status = 'available';
          }

          const normalized = store.normalizeProduct(merged, existing);
          catalog.products[idx] = normalized;
          return { saveCatalog: true, result: normalized };
        });

        sendJson(res, 200, { product: updated }, sessionHeaders);
        return true;
      }

      if (pathname === '/api/admin/orders') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'GET, HEAD', ...sessionHeaders });
          return true;
        }
        const orders = store
          .getOrders()
          .slice()
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        sendJson(res, 200, { orders }, sessionHeaders);
        return true;
      }

      if (pathname.startsWith('/api/admin/orders/')) {
        if (req.method !== 'PATCH') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'PATCH', ...sessionHeaders });
          return true;
        }
        const encodedRef = pathname.slice('/api/admin/orders/'.length);
        if (!encodedRef || encodedRef.includes('/')) {
          sendError(res, 404, 'Order not found', {}, sessionHeaders);
          return true;
        }
        let orderRef;
        try {
          orderRef = decodeURIComponent(encodedRef);
        } catch {
          throw new HttpError(400, 'Invalid order reference');
        }

        const body = await readJsonBody(req, { maxBytes: 64 * 1024, requireObject: true });
        const nextStatus = typeof body.status === 'string' ? body.status.trim() : '';
        if (!ALLOWED_ORDER_STATUSES.has(nextStatus)) {
          throw new HttpError(400, 'Invalid order status');
        }

        const updatedOrder = await store.withTransaction(({ catalog, orders }) => {
          const list = orders && Array.isArray(orders.orders) ? orders.orders : [];
          const order = list.find(o => o && o.orderRef === orderRef);
          if (!order) {
            throw new HttpError(404, 'Order not found');
          }

          if (order.status === 'cancelled' && nextStatus !== 'cancelled') {
            throw new HttpError(409, 'Cancelled orders cannot be reopened');
          }

          let saveCatalog = false;
          const nowIso = new Date().toISOString();

          if (nextStatus === 'cancelled' && order.status !== 'cancelled' && !order.stockRestoredAt) {
            const lines = Array.isArray(order.items) ? order.items : [];
            for (const line of lines) {
              if (!line || !line.id) continue;
              const prod = catalog.products.find(p => p.id === line.id);
              if (!prod) continue;
              const qty = Math.max(0, Math.floor(Number(line.quantity) || 0));
              if (qty <= 0) continue;
              prod.quantity = Math.max(0, Math.floor(Number(prod.quantity) || 0)) + qty;
              if (prod.quantity > 0 && prod.status === 'sold') {
                prod.status = 'available';
              }
              prod.updatedAt = nowIso;
              saveCatalog = true;
            }
            order.stockRestoredAt = nowIso;
          }

          order.status = nextStatus;
          order.updatedAt = nowIso;

          return {
            saveCatalog,
            saveOrders: true,
            result: order
          };
        });

        sendJson(res, 200, { order: updatedOrder }, sessionHeaders);
        return true;
      }

      if (pathname === '/api/admin/import/preview') {
        if (req.method !== 'POST') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'POST', ...sessionHeaders });
          return true;
        }
        const body = await readJsonBody(req, { maxBytes: 10 * 1024 * 1024, requireObject: true });
        const result = await importService.previewImport(body, { store });
        sendJson(res, 200, result, sessionHeaders);
        return true;
      }

      if (pathname === '/api/admin/import/commit') {
        if (req.method !== 'POST') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'POST', ...sessionHeaders });
          return true;
        }
        const body = await readJsonBody(req, { maxBytes: 10 * 1024 * 1024, requireObject: true });
        if (!Array.isArray(body.items)) {
          throw new HttpError(400, 'items must be an array');
        }
        const result = await importService.commitImport(body, { store });
        sendJson(res, 200, result, sessionHeaders);
        return true;
      }

      sendError(res, 404, 'Admin route not found', {}, sessionHeaders);
      return true;
    }
  };
}

module.exports = {
  createAdminRouter,
  ALLOWED_ORDER_STATUSES,
  VALID_CATEGORIES
};
