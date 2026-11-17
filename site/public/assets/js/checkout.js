/* RETROMOD. — checkout form, 409 conflict recovery & order receipt */
(() => {
'use strict';
const RM = window.RM;
if (!RM || !RM.cart) return;

const { $, $$, fmt, img, esc, enquire, toast } = RM;
const SHIPPING_RATES = { collection: 0, delivery: 250 };

const alertEl = $('#checkoutAlert');
const emptyEl = $('#checkoutEmpty');
const viewEl = $('#checkoutView');
const receiptEl = $('#receiptView');
const form = $('#checkoutForm');
const shippingFields = $('#shippingFields');
const summaryItemsEl = $('#summaryItems');
const sumSubtotalEl = $('#sumSubtotal');
const sumShippingEl = $('#sumShipping');
const sumShipLabelEl = $('#sumShipLabel');
const sumTotalEl = $('#sumTotal');
const placeBtn = $('#placeOrderBtn');
const heroTitle = $('#coHeroTitle');
const heroLead = $('#coHeroLead');

const FIELD_MAP = {
  'customer.name': { input: '#coName', err: '#errName' },
  'customer.email': { input: '#coEmail', err: '#errEmail' },
  'customer.phone': { input: '#coPhone', err: '#errPhone' },
  fulfillment: { err: '#errFulfillment' },
  'shippingAddress.street': { input: '#coStreet', err: '#errStreet' },
  'shippingAddress.suburb': { input: '#coSuburb', err: '#errSuburb' },
  'shippingAddress.city': { input: '#coCity', err: '#errCity' },
  'shippingAddress.province': { input: '#coProvince', err: '#errProvince' },
  'shippingAddress.postalCode': { input: '#coPostal', err: '#errPostalCode' },
  paymentMethod: { err: '#errPaymentMethod' },
  notes: { input: '#coNotes', err: '#errNotes' }
};

let conflictItemId = null;
let conflictAvailableQty = null;

function clearErrors() {
  if (alertEl) {
    alertEl.innerHTML = '';
    alertEl.className = 'alert';
    alertEl.hidden = true;
  }
  $$('.err', form).forEach(el => { el.textContent = ''; });
  $$('[aria-invalid="true"]', form).forEach(el => { el.removeAttribute('aria-invalid'); });
  conflictItemId = null;
  conflictAvailableQty = null;
}

function showAlert(message, { actionsHtml = '', ok = false } = {}) {
  if (!alertEl) return;
  alertEl.className = ok ? 'alert alert--ok' : 'alert';
  alertEl.innerHTML = `<div>${esc(message)}</div>${actionsHtml ? `<div class="alert-actions">${actionsHtml}</div>` : ''}`;
  alertEl.hidden = false;
}

function applyFieldErrors(fields, summaryMessage) {
  let firstInvalid = null;
  if (fields && typeof fields === 'object') {
    for (const [key, msg] of Object.entries(fields)) {
      const mapping = FIELD_MAP[key];
      if (!mapping) continue;
      if (mapping.err) {
        const errEl = $(mapping.err);
        if (errEl) errEl.textContent = String(msg);
      }
      if (mapping.input) {
        const inp = $(mapping.input);
        if (inp) {
          inp.setAttribute('aria-invalid', 'true');
          if (!firstInvalid) firstInvalid = inp;
        }
      }
    }
  }
  showAlert(summaryMessage || 'Please check the highlighted fields before placing your order.');
  if (firstInvalid) firstInvalid.focus();
}

function selectedFulfillment() {
  const checked = $('input[name="fulfillment"]:checked', form);
  return checked ? checked.value : 'collection';
}

function selectedPaymentMethod() {
  const checked = $('input[name="paymentMethod"]:checked', form);
  return checked ? checked.value : 'eft';
}

function syncChoiceCards() {
  const ful = selectedFulfillment();
  const isDelivery = ful === 'delivery';
  shippingFields.hidden = !isDelivery;

  // Toggle required on shipping inputs only when delivery is chosen
  ['#coStreet', '#coSuburb', '#coCity', '#coProvince', '#coPostal'].forEach(sel => {
    const el = $(sel);
    if (el) el.required = isDelivery;
  });

  // Disable pay_on_collection when delivery is chosen
  const payCol = $('#payCollection');
  const payColLbl = $('#payCollectionLbl');
  const payEft = $('#payEft');
  if (payCol && payColLbl) {
    payCol.disabled = isDelivery;
    payColLbl.classList.toggle('is-disabled', isDelivery);
    if (isDelivery && payCol.checked && payEft) {
      payEft.checked = true;
    }
  }

  $$('.choice', form).forEach(lbl => {
    const input = $('input[type="radio"]', lbl);
    lbl.classList.toggle('on', Boolean(input && input.checked));
  });

  renderSummary();
}

function renderSummary() {
  const items = RM.cart.getItems();
  const hasItems = items.length > 0;
  emptyEl.hidden = hasItems;
  viewEl.hidden = !hasItems;
  if (!hasItems) return;

  const ful = selectedFulfillment();
  const subtotal = RM.cart.getSubtotal();
  const shipping = SHIPPING_RATES[ful] || 0;
  const total = subtotal + shipping;

  summaryItemsEl.innerHTML = items.map(it => {
    const p = it.product;
    const title = p ? p.title : it.id;
    const isConf = conflictItemId && conflictItemId === it.id;
    return `
      <li class="co-item${isConf ? ' is-conflict' : ''}" data-summary-item="${esc(it.id)}">
        <div class="co-item-img">${p ? `<img src="${esc(img(p))}" alt="${esc(title)}" draggable="false">` : ''}</div>
        <div>
          <div class="co-item-title">${esc(title)}</div>
          <div class="co-item-meta">Qty ${it.quantity} · ${fmt(it.price)} each</div>
        </div>
        <div class="co-item-price">${fmt(it.lineTotal)}</div>
      </li>`;
  }).join('');

  sumSubtotalEl.textContent = fmt(subtotal);
  sumShipLabelEl.textContent = ful === 'delivery' ? 'Nationwide SA courier' : 'Norwood collection';
  sumShippingEl.textContent = shipping === 0 ? 'Free (R0)' : fmt(shipping);
  sumTotalEl.textContent = fmt(total);
}

function validateClient() {
  const fields = {};
  const name = $('#coName').value.trim();
  const email = $('#coEmail').value.trim();
  const phone = $('#coPhone').value.trim();
  const ful = selectedFulfillment();
  const pay = selectedPaymentMethod();
  const notes = $('#coNotes').value.trim();

  if (name.length < 2 || name.length > 120) {
    fields['customer.name'] = 'Enter your full name (2–120 characters)';
  }
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    fields['customer.email'] = 'Enter a valid email address';
  }
  const digits = phone.replace(/\D/g, '');
  if (!phone || !/^[+\d\s().-]+$/.test(phone) || digits.length < 7 || digits.length > 15) {
    fields['customer.phone'] = 'Enter a valid phone or WhatsApp number (7–15 digits)';
  }

  let shippingAddress;
  if (ful === 'delivery') {
    const street = $('#coStreet').value.trim();
    const suburb = $('#coSuburb').value.trim();
    const city = $('#coCity').value.trim();
    const province = $('#coProvince').value.trim();
    const postalCode = $('#coPostal').value.trim();

    if (street.length < 3) fields['shippingAddress.street'] = 'Enter a street address';
    if (suburb.length < 2) fields['shippingAddress.suburb'] = 'Enter a suburb';
    if (city.length < 2) fields['shippingAddress.city'] = 'Enter a city';
    if (!province) fields['shippingAddress.province'] = 'Select a province';
    if (!/^\d{4}$/.test(postalCode)) fields['shippingAddress.postalCode'] = 'Enter a 4-digit SA postal code';
    shippingAddress = { street, suburb, city, province, postalCode };
  }

  if (notes.length > 1000) {
    fields.notes = 'Order notes must be 1000 characters or fewer';
  }

  if (Object.keys(fields).length > 0) {
    applyFieldErrors(fields, 'Please check the highlighted fields before placing your order.');
    return null;
  }

  const items = RM.cart.getCart().items.map(it => ({ id: it.id, quantity: it.quantity }));
  return {
    customer: { name, email, phone },
    fulfillment: ful,
    ...(shippingAddress ? { shippingAddress } : {}),
    paymentMethod: pay,
    notes,
    items
  };
}

function paymentLabel(method) {
  if (method === 'eft') return 'EFT / Bank Transfer';
  if (method === 'pay_on_collection') return 'Pay on Collection';
  if (method === 'card_order_request') return 'Card Payment Link';
  return method;
}

function paymentInstructions(order) {
  if (order.paymentMethod === 'eft') {
    return `Please use <strong>${esc(order.orderRef)}</strong> as your payment reference when completing your EFT transfer. Send proof of payment via Instagram DM @retromod.za or email so we can finalize dispatch or collection.`;
  }
  if (order.paymentMethod === 'pay_on_collection') {
    return `Your piece is reserved at <strong>66 Grant Avenue, Corner Nellie Road, Norwood</strong>. Settle ${fmt(order.totalZar)} in-store when you collect.`;
  }
  return `Your piece is reserved. We will send a secure card / Yoco payment link for ${fmt(order.totalZar)} to ${esc(order.customer.email)} or via Instagram DM.`;
}

function buildOrderDmText(order) {
  const lines = [
    `Hi RETROMOD., I just placed order ${order.orderRef} (${fmt(order.totalZar)}).`,
    ...order.items.map(it => `• ${it.quantity}× ${it.title} — ${fmt(it.lineTotalZar)}`),
    `Fulfillment: ${order.fulfillment === 'delivery' ? 'Nationwide Courier' : 'Norwood Collection'}`,
    `Payment: ${paymentLabel(order.paymentMethod)}`,
    `Name: ${order.customer.name} (${order.customer.phone})`
  ];
  return lines.join('\n');
}

function renderReceipt(order) {
  emptyEl.hidden = true;
  viewEl.hidden = true;
  receiptEl.hidden = false;
  if (heroTitle) heroTitle.textContent = 'Order confirmed.';
  if (heroLead) heroLead.textContent = 'Your order has been captured and stock has been reserved on the Norwood floor.';

  const fulDetails = order.fulfillment === 'delivery' && order.shippingAddress
    ? `Nationwide SA Courier Delivery<br>${esc(order.shippingAddress.street)}, ${esc(order.shippingAddress.suburb)}<br>${esc(order.shippingAddress.city)}, ${esc(order.shippingAddress.province)} ${esc(order.shippingAddress.postalCode)}`
    : 'Collect in Norwood<br>66 Grant Avenue, Corner Nellie Road<br>Norwood, Johannesburg 2192';

  receiptEl.innerHTML = `
    <div class="rc-head">
      <div>
        <span class="eyebrow">Order receipt</span>
        <h2 class="rc-ref">${esc(order.orderRef)}</h2>
      </div>
      <span class="rc-pill"><i></i>${esc(order.status)}</span>
    </div>
    <div class="rc-grid">
      <div class="rc-block">
        <h3>Customer</h3>
        <p>${esc(order.customer.name)}<br>${esc(order.customer.email)}<br>${esc(order.customer.phone)}</p>
      </div>
      <div class="rc-block">
        <h3>Fulfillment</h3>
        <p>${fulDetails}</p>
      </div>
      <div class="rc-block">
        <h3>Payment method</h3>
        <p>${esc(paymentLabel(order.paymentMethod))}</p>
      </div>
      <div class="rc-block">
        <h3>Placed on</h3>
        <p>${esc(new Date(order.createdAt).toLocaleString('en-ZA'))}</p>
      </div>
    </div>
    <ul class="co-items" style="margin-top:18px">
      ${order.items.map(it => `
        <li class="co-item">
          <div class="co-item-img"><img src="${esc(it.image || ('assets/stock/' + encodeURIComponent(it.id) + '.jpg'))}" alt="${esc(it.title)}" draggable="false"></div>
          <div>
            <div class="co-item-title">${esc(it.title)}</div>
            <div class="co-item-meta">Qty ${it.quantity} · ${fmt(it.price)} each</div>
          </div>
          <div class="co-item-price">${fmt(it.lineTotalZar)}</div>
        </li>`).join('')}
    </ul>
    <div class="co-totals">
      <div class="co-tot-row"><span>Subtotal</span><b>${fmt(order.subtotalZar)}</b></div>
      <div class="co-tot-row"><span>Shipping</span><b>${order.shippingZar === 0 ? 'Free (R0)' : fmt(order.shippingZar)}</b></div>
    </div>
    <div class="co-tot-grand">
      <span>Total (ZAR)</span>
      <b>${fmt(order.totalZar)}</b>
    </div>
    <div class="rc-inst">
      <h3>Next steps</h3>
      <p>${paymentInstructions(order)}</p>
    </div>
    ${order.notes ? `<div class="rc-inst"><h3>Your notes</h3><p>${esc(order.notes)}</p></div>` : ''}
    <div class="rc-actions">
      <button type="button" class="btn" id="rcDmBtn">Notify via Instagram DM <span class="arr">↗</span></button>
      <a class="btn btn--ghost" href="shop.html">Continue shopping</a>
      <button type="button" class="btn btn--ghost" id="rcPrintBtn">Print receipt</button>
    </div>`;

  const dmBtn = $('#rcDmBtn', receiptEl);
  dmBtn && dmBtn.addEventListener('click', () => enquire(buildOrderDmText(order)));
  const printBtn = $('#rcPrintBtn', receiptEl);
  printBtn && printBtn.addEventListener('click', () => window.print());
}

async function handleConflict(statusPayload) {
  conflictItemId = statusPayload.itemId || null;
  conflictAvailableQty = typeof statusPayload.availableQuantity === 'number'
    ? statusPayload.availableQuantity
    : 0;

  renderSummary();

  let actionBtn = '';
  if (conflictItemId) {
    if (conflictAvailableQty <= 0) {
      actionBtn = `<button type="button" class="btn btn--sm" data-conflict-remove="${esc(conflictItemId)}">Remove unavailable item</button>`;
    } else {
      actionBtn = `<button type="button" class="btn btn--sm" data-conflict-clamp="${esc(conflictItemId)}" data-qty="${conflictAvailableQty}">Update quantity to ${conflictAvailableQty}</button>`;
    }
  }
  showAlert(statusPayload.error || 'One or more items in your bag are currently out of stock or unavailable.', {
    actionsHtml: actionBtn
  });
}

alertEl && alertEl.addEventListener('click', e => {
  const remBtn = e.target.closest('[data-conflict-remove]');
  if (remBtn) {
    RM.cart.removeItem(remBtn.dataset.conflictRemove);
    clearErrors();
    renderSummary();
    toast('Removed unavailable item');
    return;
  }
  const clampBtn = e.target.closest('[data-conflict-clamp]');
  if (clampBtn) {
    const qty = Number(clampBtn.dataset.qty) || 1;
    RM.cart.updateQuantity(clampBtn.dataset.conflictClamp, qty);
    clearErrors();
    renderSummary();
    toast(`Updated quantity to ${qty}`);
  }
});

form && form.addEventListener('change', e => {
  if (e.target.name === 'fulfillment' || e.target.name === 'paymentMethod') {
    syncChoiceCards();
  }
});

form && form.addEventListener('input', e => {
  if (e.target.hasAttribute('aria-invalid')) {
    e.target.removeAttribute('aria-invalid');
  }
});

form && form.addEventListener('submit', async e => {
  e.preventDefault();
  clearErrors();

  const payload = validateClient();
  if (!payload) return;

  placeBtn.disabled = true;
  const origHtml = placeBtn.innerHTML;
  placeBtn.textContent = 'Placing order…';

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json().catch(() => ({}));

    if (res.status === 201 && json.order) {
      RM.cart.clear();
      if (RM.refreshCatalog) await RM.refreshCatalog();
      const q = new URLSearchParams({
        orderRef: json.order.orderRef,
        token: json.order.accessToken
      });
      history.replaceState(null, '', `${location.pathname}?${q.toString()}`);
      renderReceipt(json.order);
      window.scrollTo({ top: 0, behavior: RM.REDUCE ? 'auto' : 'smooth' });
      return;
    }

    if (res.status === 400) {
      applyFieldErrors(json.fields, json.error || 'Please check the order details.');
      return;
    }

    if (res.status === 409) {
      await handleConflict(json);
      return;
    }

    showAlert(json.error || 'Could not complete your order right now. Please try again or DM us.');
  } catch {
    showAlert('Network error while placing your order. Please check your connection and try again.');
  } finally {
    placeBtn.disabled = false;
    placeBtn.innerHTML = origHtml;
  }
});

RM.cart.onChange(() => {
  if (receiptEl.hidden) renderSummary();
});

RM.onCatalog(() => {
  if (receiptEl.hidden) renderSummary();
});

async function boot() {
  const params = new URLSearchParams(location.search);
  const orderRef = params.get('orderRef');
  const token = params.get('token');

  if (orderRef && token) {
    emptyEl.hidden = true;
    viewEl.hidden = true;
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderRef)}?token=${encodeURIComponent(token)}`, {
        cache: 'no-store'
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.order) {
        renderReceipt(json.order);
        return;
      }
      showAlert(json.error || 'Could not load that order receipt.');
    } catch {
      showAlert('Could not load that order receipt.');
    }
  }

  syncChoiceCards();
  renderSummary();
}

boot();
})();
