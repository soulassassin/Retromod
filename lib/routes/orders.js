'use strict';

const { sendJson, sendError, readJsonBody, HttpError } = require('../http');
const { createOrder, verifyOrderAccess } = require('../orders');

function createOrdersRouter({ store }) {
  return {
    async handle(req, res, url) {
      const rawPath = url.pathname;
      const pathname = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;

      if (pathname === '/api/orders') {
        if (req.method !== 'POST') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'POST' });
          return true;
        }
        const body = await readJsonBody(req, { maxBytes: 64 * 1024, requireObject: true });
        const order = await createOrder(store, body);
        sendJson(res, 201, { order });
        return true;
      }

      if (pathname.startsWith('/api/orders/')) {
        const encodedRef = pathname.slice('/api/orders/'.length);
        if (!encodedRef || encodedRef.includes('/')) {
          sendError(res, 404, 'Order not found');
          return true;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendError(res, 405, 'Method not allowed', {}, { Allow: 'GET, HEAD' });
          return true;
        }
        let orderRef;
        try {
          orderRef = decodeURIComponent(encodedRef);
        } catch {
          throw new HttpError(400, 'Invalid order reference');
        }
        const token = url.searchParams.get('token') || '';
        const order = verifyOrderAccess(store, orderRef, token);
        sendJson(res, 200, { order });
        return true;
      }

      return false;
    }
  };
}

module.exports = { createOrdersRouter };
