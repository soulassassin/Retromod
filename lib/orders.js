'use strict';

const crypto = require('crypto');
const { HttpError } = require('./http');

const SHIPPING_RATES = Object.freeze({
  collection: 0,
  delivery: 250
});

const VALID_FULFILLMENTS = Object.freeze(['collection', 'delivery']);
const VALID_PAYMENT_METHODS = Object.freeze([
  'eft',
  'pay_on_collection',
  'card_order_request'
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_CHARS_RE = /^[+\d\s().-]+$/;
const POSTAL_SA_RE = /^\d{4}$/;

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function cleanStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function calculateShippingZar(fulfillment) {
  if (!Object.prototype.hasOwnProperty.call(SHIPPING_RATES, fulfillment)) {
    return 0;
  }
  return SHIPPING_RATES[fulfillment];
}

function validateOrderInput(body) {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'Order payload must be a JSON object', {
      fields: { body: 'Order payload must be an object' }
    });
  }

  const fields = {};

  // Customer
  const rawCust = body.customer;
  let customer = null;
  if (!isPlainObject(rawCust)) {
    fields.customer = 'Customer details are required';
  } else {
    const name = cleanStr(rawCust.name);
    const email = cleanStr(rawCust.email);
    const phone = cleanStr(rawCust.phone);

    if (name.length < 2 || name.length > 120) {
      fields['customer.name'] = 'Enter your full name (2–120 characters)';
    }
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
      fields['customer.email'] = 'Enter a valid email address';
    }
    const digits = phone.replace(/\D/g, '');
    if (!phone || !PHONE_CHARS_RE.test(phone) || digits.length < 7 || digits.length > 15) {
      fields['customer.phone'] = 'Enter a valid phone or WhatsApp number (7–15 digits)';
    }

    customer = { name, email, phone };
  }

  // Fulfillment
  const fulfillment = cleanStr(body.fulfillment);
  if (!VALID_FULFILLMENTS.includes(fulfillment)) {
    fields.fulfillment = 'Select collection or nationwide delivery';
  }

  // Shipping address (required only for delivery)
  let shippingAddress = null;
  if (fulfillment === 'delivery') {
    const rawAddr = body.shippingAddress;
    if (!isPlainObject(rawAddr)) {
      fields.shippingAddress = 'Delivery address is required for courier shipping';
    } else {
      const street = cleanStr(rawAddr.street);
      const suburb = cleanStr(rawAddr.suburb);
      const city = cleanStr(rawAddr.city);
      const province = cleanStr(rawAddr.province);
      const postalCode = cleanStr(rawAddr.postalCode);

      if (street.length < 3 || street.length > 200) {
        fields['shippingAddress.street'] = 'Enter a street address (3–200 characters)';
      }
      if (suburb.length < 2 || suburb.length > 100) {
        fields['shippingAddress.suburb'] = 'Enter a suburb (2–100 characters)';
      }
      if (city.length < 2 || city.length > 100) {
        fields['shippingAddress.city'] = 'Enter a city (2–100 characters)';
      }
      if (province.length < 2 || province.length > 100) {
        fields['shippingAddress.province'] = 'Select or enter a province';
      }
      if (!POSTAL_SA_RE.test(postalCode)) {
        fields['shippingAddress.postalCode'] = 'Enter a 4-digit South African postal code';
      }

      shippingAddress = { street, suburb, city, province, postalCode };
    }
  }

  // Payment method
  const paymentMethod = cleanStr(body.paymentMethod);
  if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
    fields.paymentMethod = 'Select a valid payment method';
  }

  // Notes (optional)
  let notes = '';
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') {
      fields.notes = 'Order notes must be text';
    } else {
      notes = body.notes.trim();
      if (notes.length > 1000) {
        fields.notes = 'Order notes must be 1000 characters or fewer';
      }
    }
  }

  // Items
  const rawItems = body.items;
  const aggregated = new Map();
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    fields.items = 'Your bag is empty — add at least one piece to order';
  } else if (rawItems.length > 50) {
    fields.items = 'Too many line items in a single order (maximum 50)';
  } else {
    rawItems.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        fields[`items[${i}]`] = 'Invalid item entry';
        return;
      }
      const id = cleanStr(entry.id);
      if (!id || id.length > 160) {
        fields[`items[${i}].id`] = 'Product identifier is required';
      }
      const qty = entry.quantity;
      if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 100) {
        fields[`items[${i}].quantity`] = 'Quantity must be a whole number of at least 1';
      }
      if (id && typeof qty === 'number' && Number.isInteger(qty) && qty >= 1) {
        aggregated.set(id, (aggregated.get(id) || 0) + qty);
      }
    });
  }

  if (Object.keys(fields).length > 0) {
    throw new HttpError(400, 'Please check the order details', { fields });
  }

  const items = Array.from(aggregated.entries()).map(([id, quantity]) => ({ id, quantity }));

  return {
    customer,
    fulfillment,
    shippingAddress,
    paymentMethod,
    notes,
    items
  };
}

function generateOrderRef(existingOrders, now = new Date()) {
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const used = new Set((existingOrders || []).map(o => o && o.orderRef).filter(Boolean));
  for (let i = 0; i < 10; i++) {
    const hex = crypto.randomBytes(3).toString('hex').toUpperCase();
    const ref = `RM-${datePart}-${hex}`;
    if (!used.has(ref)) return ref;
  }
  return `RM-${datePart}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

async function createOrder(store, payload) {
  const input = validateOrderInput(payload);

  return store.withTransaction(async ({ catalog, orders }) => {
    const products = Array.isArray(catalog && catalog.products) ? catalog.products : [];
    const byId = new Map(products.map(p => [p.id, p]));

    // Pass 1: validate every item before mutating anything (all-or-nothing)
    const resolved = [];
    for (const reqItem of input.items) {
      const product = byId.get(reqItem.id);
      if (!product) {
        throw new HttpError(404, `Product not found: ${reqItem.id}`, { itemId: reqItem.id });
      }
      const rawQty = Math.max(0, Math.floor(Number(product.quantity) || 0));
      const availableQuantity = product.status === 'available' ? rawQty : 0;

      if (product.status !== 'available' || availableQuantity < reqItem.quantity) {
        const reason = availableQuantity <= 0
          ? `${product.title} is no longer available`
          : `Only ${availableQuantity} of ${product.title} available`;
        throw new HttpError(409, reason, {
          itemId: product.id,
          availableQuantity
        });
      }
      resolved.push({ product, quantity: reqItem.quantity });
    }

    // Pass 2: decrement stock and create authoritative order record
    const now = new Date();
    const nowIso = now.toISOString();
    let subtotalZar = 0;
    const orderItems = [];

    for (const { product, quantity } of resolved) {
      const nextQty = Math.max(0, Math.floor(Number(product.quantity) || 0) - quantity);
      product.quantity = nextQty;
      if (nextQty <= 0) {
        product.quantity = 0;
        product.status = 'sold';
      }
      product.updatedAt = nowIso;

      const unitPrice = Math.max(0, Math.round(Number(product.price) || 0));
      const lineTotalZar = unitPrice * quantity;
      subtotalZar += lineTotalZar;

      orderItems.push({
        id: product.id,
        title: product.title,
        price: unitPrice,
        quantity,
        lineTotalZar,
        image: product.image || `assets/stock/${product.id}.jpg`
      });
    }

    if (!orders || typeof orders !== 'object') {
      throw new Error('Invalid orders store state');
    }
    if (!Array.isArray(orders.orders)) {
      orders.orders = [];
    }

    const shippingZar = calculateShippingZar(input.fulfillment);
    const totalZar = subtotalZar + shippingZar;
    const orderRef = generateOrderRef(orders.orders, now);
    const accessToken = crypto.randomBytes(24).toString('hex');

    const order = {
      orderRef,
      accessToken,
      status: 'pending',
      customer: input.customer,
      fulfillment: input.fulfillment,
      shippingAddress: input.shippingAddress,
      paymentMethod: input.paymentMethod,
      notes: input.notes,
      items: orderItems,
      subtotalZar,
      shippingZar,
      totalZar,
      createdAt: nowIso,
      updatedAt: nowIso
    };

    orders.orders.push(order);

    return {
      saveCatalog: true,
      saveOrders: true,
      result: order
    };
  });
}

async function verifyOrderAccess(store, orderRef, token) {
  const ref = cleanStr(orderRef);
  if (!ref) {
    throw new HttpError(404, 'Order not found');
  }
  const order = await store.getOrderByRef(ref);
  if (!order) {
    throw new HttpError(404, 'Order not found');
  }

  const provided = typeof token === 'string' ? token.trim() : '';
  const expected = typeof order.accessToken === 'string' ? order.accessToken : '';

  if (!provided || !expected) {
    throw new HttpError(403, 'Invalid or missing order access token');
  }

  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    throw new HttpError(403, 'Invalid or missing order access token');
  }

  return order;
}

module.exports = {
  SHIPPING_RATES,
  VALID_FULFILLMENTS,
  VALID_PAYMENT_METHODS,
  calculateShippingZar,
  validateOrderInput,
  createOrder,
  verifyOrderAccess
};
