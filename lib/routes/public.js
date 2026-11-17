'use strict';

const { sendJson, sendError, HttpError } = require('../http');

function createPublicRouter({ store }) {
  return {
    async handle(req, res, url) {
      const rawPath = url.pathname;
      const pathname = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;

      if (pathname === '/api/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'GET, HEAD' });
          return true;
        }
        const catalog = store.getCatalog();
        sendJson(res, 200, {
          ok: true,
          status: 'ok',
          productCount: catalog.products.length,
          timestamp: new Date().toISOString()
        });
        return true;
      }

      if (pathname === '/api/products') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'GET, HEAD' });
          return true;
        }
        const category = url.searchParams.get('category') || '';
        const q = url.searchParams.get('q') || '';
        const status = url.searchParams.get('status') || '';
        const data = store.getCatalog({ category, q, status });
        sendJson(res, 200, {
          links: data.links,
          categories: data.categories,
          stats: data.stats,
          products: data.products
        });
        return true;
      }

      if (pathname.startsWith('/api/products/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'GET, HEAD' });
          return true;
        }
        const encodedId = pathname.slice('/api/products/'.length);
        if (!encodedId || encodedId.includes('/')) {
          sendError(res, 404, 'Product not found');
          return true;
        }
        let id;
        try {
          id = decodeURIComponent(encodedId);
        } catch {
          throw new HttpError(400, 'Invalid product identifier');
        }
        const product = store.getProductById(id);
        if (!product) {
          sendError(res, 404, 'Product not found');
          return true;
        }
        sendJson(res, 200, { product });
        return true;
      }

      return false;
    }
  };
}

module.exports = { createPublicRouter };
