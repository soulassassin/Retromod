/* RETROMOD. — persistent cart & accessible slide-over drawer */
(() => {
'use strict';
const RM = window.RM;
if (!RM) return;

const STORAGE_KEY = 'retromod_cart_v1';
const { $, $$, fmt, img, esc, availQty, isSold, isReserved, toast } = RM;

let memoryFallback = null;
let lastTrigger = null;
let lastNotices = [];

function emptyState() {
  return { version: 1, updatedAt: new Date().toISOString(), items: [] };
}

function normalizeCart(raw) {
  const out = emptyState();
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.updatedAt === 'string') out.updatedAt = raw.updatedAt;
  if (!Array.isArray(raw.items)) return out;
  const merged = new Map();
  for (const entry of raw.items) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const qty = Math.floor(Number(entry.quantity));
    if (!id || !Number.isFinite(qty) || qty < 1) continue;
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  out.items = Array.from(merged.entries()).map(([id, quantity]) => ({ id, quantity }));
  return out;
}

function readCart() {
  try {
    for (const legacyKey of ['retromod_cart', 'rm_cart']) {
      const legacyRaw = window.localStorage.getItem(legacyKey);
      if (legacyRaw) {
        try { JSON.parse(legacyRaw); } catch { window.localStorage.removeItem(legacyKey); }
      }
    }
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    return normalizeCart(JSON.parse(raw));
  } catch {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch {}
    return memoryFallback ? normalizeCart(memoryFallback) : emptyState();
  }
}

function writeCart(cart) {
  const normalized = normalizeCart(cart);
  normalized.updatedAt = new Date().toISOString();
  memoryFallback = normalized;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Restricted storage fallback already kept in memoryFallback
  }
  emitChange(normalized);
  return normalized;
}

function getProducts() {
  const cat = RM.getCatalog ? RM.getCatalog() : window.RETROMOD;
  return Array.isArray(cat && cat.products) ? cat.products : [];
}

function findProduct(id, products = getProducts()) {
  return products.find(p => p && p.id === id) || null;
}

function getCount(cart = readCart()) {
  return cart.items.reduce((sum, it) => sum + it.quantity, 0);
}

function getDetailedItems(cart = readCart(), products = getProducts()) {
  return cart.items.map(it => {
    const product = findProduct(it.id, products);
    const price = product ? Math.max(0, Math.round(Number(product.price) || 0)) : 0;
    return {
      id: it.id,
      quantity: it.quantity,
      product,
      price,
      lineTotal: price * it.quantity
    };
  });
}

function getSubtotal(cart = readCart(), products = getProducts()) {
  return getDetailedItems(cart, products).reduce((sum, it) => sum + it.lineTotal, 0);
}

const REDUCE_MOTION = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE_OUT = 'cubic-bezier(.23,1,.32,1)';
const EASE_DRAWER = 'cubic-bezier(.32,.72,0,1)';

function updateBadges(cart = readCart()) {
  const count = getCount(cart);
  $$('[data-cart-count]').forEach(el => {
    const prev = Number(el.textContent) || 0;
    el.textContent = String(count);
    el.classList.toggle('is-empty', count === 0);
    // Feedback: the count bumps when something is added (not on page load, not on remove).
    if (count > prev && !REDUCE_MOTION && el.animate && document.readyState === 'complete') {
      el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.3)' }, { transform: 'scale(1)' }],
        { duration: 260, easing: EASE_OUT });
    }
  });
  $$('[data-cart-open]').forEach(btn => {
    if (btn.id === 'bagBtn' || btn.classList.contains('bag-btn')) {
      btn.setAttribute('aria-label', `Shopping bag (${count} ${count === 1 ? 'item' : 'items'})`);
    }
  });
}

function emitChange(cart) {
  updateBadges(cart);
  renderDrawer(cart);
  const detail = { cart, count: getCount(cart), subtotal: getSubtotal(cart) };
  window.dispatchEvent(new CustomEvent('rm:cart', { detail }));
  window.dispatchEvent(new CustomEvent('retromod:cart-updated', { detail }));
}

function showPageAlert(message, { clear = false } = {}) {
  const alertEl = $('#pdAlert') || $('#shopAlert') || $('#homeAlert') || $('#gridAlert');
  if (!alertEl) return;
  if (clear || !message) {
    alertEl.textContent = '';
    alertEl.hidden = true;
    return;
  }
  alertEl.textContent = message;
  alertEl.hidden = false;
}

function setDrawerNotice(messages) {
  lastNotices = Array.isArray(messages) ? messages.filter(Boolean) : (messages ? [String(messages)] : []);
  const el = $('#cartNotice');
  if (!el) return;
  if (!lastNotices.length) {
    el.textContent = '';
    el.hidden = true;
    return;
  }
  el.innerHTML = lastNotices.map(m => `<div>${esc(m)}</div>`).join('');
  el.hidden = false;
}

function revalidate(products = getProducts(), { showNotice = true } = {}) {
  if (!Array.isArray(products)) return { cart: readCart(), notices: [] };
  const cart = readCart();
  if (!cart.items.length) {
    updateBadges(cart);
    return { cart, notices: [] };
  }

  const nextItems = [];
  const notices = [];
  let changed = false;

  for (const item of cart.items) {
    const p = findProduct(item.id, products);
    if (!p) {
      changed = true;
      notices.push(`"${item.id}" is no longer available and was removed from your bag.`);
      continue;
    }
    if (isSold(p)) {
      changed = true;
      notices.push(`${p.title} has sold out and was removed from your bag.`);
      continue;
    }
    if (isReserved(p)) {
      changed = true;
      notices.push(`${p.title} is currently reserved and was removed from your bag.`);
      continue;
    }
    const maxQty = availQty(p);
    if (item.quantity > maxQty) {
      changed = true;
      nextItems.push({ id: item.id, quantity: maxQty });
      notices.push(`Adjusted ${p.title} quantity to ${maxQty} (maximum available).`);
      continue;
    }
    nextItems.push(item);
  }

  let saved = cart;
  if (changed) {
    saved = writeCart({ ...cart, items: nextItems });
  } else {
    updateBadges(cart);
    renderDrawer(cart);
  }

  if (showNotice && notices.length) {
    setDrawerNotice(notices);
  }
  return { cart: saved, notices };
}

function ensureDrawerDom() {
  let root = $('#cartDrawer');
  if (root) return root;

  root = document.createElement('div');
  root.id = 'cartDrawer';
  root.className = 'drawer';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Shopping bag');
  root.tabIndex = -1;
  root.hidden = true;
  root.innerHTML = `
    <div class="drawer-backdrop" data-cart-close></div>
    <div class="drawer-panel">
      <div class="cart-head">
        <div class="cart-head-title">
          <h2>Your bag</h2>
          <small id="cartHeadCount">0 items</small>
        </div>
        <button type="button" class="cart-close" id="cartCloseBtn" data-cart-close aria-label="Close shopping bag">✕</button>
      </div>
      <div id="cartNotice" class="cart-notice" role="alert" aria-live="polite" hidden></div>
      <div class="cart-body" id="cartBody"></div>
      <div class="cart-foot" id="cartFoot" hidden>
        <div class="cart-total-row">
          <span>Subtotal</span>
          <b id="cartSubtotal">R0</b>
        </div>
        <p class="cart-foot-note">Norwood collection is free · Nationwide SA courier R250 calculated at checkout.</p>
        <div class="cart-foot-actions">
          <button type="button" class="btn btn--ghost" id="cartClear">Clear bag</button>
          <a class="btn" href="checkout.html" id="cartCheckout">Checkout <span class="arr">↗</span></a>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);

  root.addEventListener('click', e => {
    if (e.target.closest('[data-cart-close]')) {
      e.preventDefault();
      closeDrawer();
      return;
    }
    const dec = e.target.closest('[data-cart-dec]');
    if (dec) {
      e.preventDefault();
      const id = dec.dataset.cartDec;
      const cur = readCart().items.find(it => it.id === id);
      if (cur) updateQuantity(id, cur.quantity - 1);
      return;
    }
    const inc = e.target.closest('[data-cart-inc]');
    if (inc) {
      e.preventDefault();
      const id = inc.dataset.cartInc;
      const cur = readCart().items.find(it => it.id === id);
      if (cur) updateQuantity(id, cur.quantity + 1);
      return;
    }
    const rem = e.target.closest('[data-cart-remove]');
    if (rem) {
      e.preventDefault();
      removeItem(rem.dataset.cartRemove);
      return;
    }
    if (e.target.closest('#cartClear')) {
      e.preventDefault();
      clear();
    }
  });

  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDrawer();
      return;
    }
    if (e.key === 'Tab') {
      const focusable = $$(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        root
      ).filter(el => el.offsetParent !== null || el === document.activeElement);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  return root;
}

function renderDrawer(cart = readCart()) {
  const root = $('#cartDrawer');
  if (!root) return;
  const body = $('#cartBody', root);
  const foot = $('#cartFoot', root);
  const headCount = $('#cartHeadCount', root);
  const subtotalEl = $('#cartSubtotal', root);

  const details = getDetailedItems(cart);
  const count = getCount(cart);
  headCount.textContent = `${count} ${count === 1 ? 'item' : 'items'}`;

  if (!details.length) {
    foot.hidden = true;
    body.innerHTML = `
      <div class="cart-empty">
        <h3>Your bag is empty.</h3>
        <p>Every piece is hand-selected for the Norwood floor. Add a piece to check out online or arrange collection.</p>
        <a class="btn" href="shop.html">Browse the shop <span class="arr">↗</span></a>
      </div>`;
    return;
  }

  foot.hidden = false;
  subtotalEl.textContent = fmt(getSubtotal(cart));
  body.innerHTML = `<ul class="cart-items">${details.map(({ id, quantity, product, price, lineTotal }) => {
    const title = product ? product.title : id;
    const maxQty = product ? availQty(product) : quantity;
    const href = `product.html?id=${encodeURIComponent(id)}`;
    const thumb = product
      ? `<img src="${esc(img(product))}" alt="${esc(title)}" loading="lazy" draggable="false">`
      : '';
    return `
      <li class="cart-item" data-cart-item="${esc(id)}">
        <a class="cart-thumb" href="${href}">${thumb}</a>
        <div class="cart-meta">
          <a class="cart-title" href="${href}">${esc(title)}</a>
          <div class="cart-price">${fmt(price)} each · Line ${fmt(lineTotal)}</div>
          <div class="cart-controls">
            <div class="qty-ctrl">
              <button type="button" class="qty-btn" data-cart-dec="${esc(id)}" aria-label="Decrease quantity of ${esc(title)}">−</button>
              <span class="cart-qty" aria-label="Quantity">${quantity}</span>
              <button type="button" class="qty-btn" data-cart-inc="${esc(id)}" aria-label="Increase quantity of ${esc(title)}"${quantity >= maxQty ? ' disabled aria-disabled="true"' : ''}>+</button>
            </div>
            <button type="button" class="cart-remove" data-cart-remove="${esc(id)}" aria-label="Remove ${esc(title)} from bag">Remove</button>
          </div>
        </div>
      </li>`;
  }).join('')}</ul>`;
}

async function openDrawer(trigger = null) {
  const root = ensureDrawerDom();
  lastTrigger = trigger || document.activeElement;

  // Close mobile nav if open
  if (document.body.classList.contains('menu-open')) {
    document.body.classList.remove('menu-open');
    const menuBtn = $('#menuBtn');
    menuBtn && menuBtn.setAttribute('aria-expanded', 'false');
  }

  setDrawerNotice([]);
  const initialRev = revalidate(getProducts(), { showNotice: true });
  const collectedNotices = [...initialRev.notices];
  renderDrawer(readCart());
  root.hidden = false;
  animateDrawer(root, true);
  document.body.classList.add('cart-open');
  $$('[data-cart-open]').forEach(btn => btn.setAttribute('aria-expanded', 'true'));

  const closeBtn = $('#cartCloseBtn', root);
  (closeBtn || root).focus();

  // Revalidate live stock whenever the drawer opens
  if (RM.refreshCatalog) {
    const data = await RM.refreshCatalog();
    if (data && Array.isArray(data.products)) {
      const freshRev = revalidate(data.products, { showNotice: false });
      for (const n of freshRev.notices) {
        if (!collectedNotices.includes(n)) collectedNotices.push(n);
      }
      if (collectedNotices.length) {
        setDrawerNotice(collectedNotices);
      }
      renderDrawer(readCart());
    }
  }
}

// Slide-over motion. Enter: 360ms on the iOS drawer curve. Exit: 220ms, faster
// than the enter. Both are interruptible — re-opening mid-close reverses from
// wherever the panel currently is instead of restarting.
function animateDrawer(root, open) {
  const panel = $('.drawer-panel', root), backdrop = $('.drawer-backdrop', root);
  if (!panel || !panel.animate) { if (!open) root.hidden = true; return; }
  const running = [...panel.getAnimations(), ...backdrop.getAnimations()];
  const from = running.length ? getComputedStyle(panel).transform : (open ? 'translateX(100%)' : 'none');
  const fromOpacity = running.length ? getComputedStyle(backdrop).opacity : (open ? '0' : '1');
  running.forEach(a => a.cancel());
  root.dataset.state = open ? 'open' : 'closing';
  const slide = REDUCE_MOTION
    ? panel.animate([{ opacity: open ? 0 : 1 }, { opacity: open ? 1 : 0 }], { duration: 180, easing: 'ease', fill: 'forwards' })
    : panel.animate([{ transform: from === 'none' ? 'translateX(0)' : from }, { transform: open ? 'translateX(0)' : 'translateX(100%)' }],
        { duration: open ? 360 : 220, easing: open ? EASE_DRAWER : EASE_OUT, fill: 'forwards' });
  backdrop.animate([{ opacity: fromOpacity }, { opacity: open ? 1 : 0 }], { duration: open ? 280 : 200, easing: 'ease', fill: 'forwards' });
  slide.onfinish = () => {
    if (!open && root.dataset.state === 'closing') {
      root.hidden = true;
      [...panel.getAnimations(), ...backdrop.getAnimations()].forEach(a => a.cancel());
    }
  };
}

function closeDrawer() {
  const root = $('#cartDrawer');
  if (!root || root.hidden || root.dataset.state === 'closing') return;
  animateDrawer(root, false);
  document.body.classList.remove('cart-open');
  $$('[data-cart-open]').forEach(btn => btn.setAttribute('aria-expanded', 'false'));
  if (lastTrigger && typeof lastTrigger.focus === 'function' && document.contains(lastTrigger)) {
    lastTrigger.focus();
  }
  lastTrigger = null;
}

function addItem(id, qty = 1, { open = true } = {}) {
  const cleanId = String(id || '').trim();
  const addQty = Math.max(1, Math.floor(Number(qty) || 1));
  const p = findProduct(cleanId);

  if (!p) {
    const msg = 'That piece could not be found in the catalog.';
    showPageAlert(msg);
    setDrawerNotice(msg);
    toast(msg);
    return { ok: false, reason: 'not_found', message: msg };
  }
  if (isSold(p)) {
    const msg = `${p.title} has sold out.`;
    showPageAlert(msg);
    setDrawerNotice(msg);
    toast(msg);
    return { ok: false, reason: 'sold', message: msg };
  }
  if (isReserved(p)) {
    const msg = `${p.title} is currently reserved.`;
    showPageAlert(msg);
    setDrawerNotice(msg);
    toast(msg);
    return { ok: false, reason: 'reserved', message: msg };
  }

  const maxQty = availQty(p);
  const cart = readCart();
  const existing = cart.items.find(it => it.id === cleanId);
  const existingQty = existing ? existing.quantity : 0;

  if (existingQty + addQty > maxQty) {
    const msg = maxQty === 1
      ? `Only 1 available — ${p.title} is already in your bag.`
      : `Only ${maxQty} available — ${existingQty} already in your bag.`;
    showPageAlert(msg);
    setDrawerNotice(msg);
    toast(msg);
    return { ok: false, reason: 'stock_limit', availableQuantity: maxQty, message: msg };
  }

  const nextItems = existing
    ? cart.items.map(it => (it.id === cleanId ? { ...it, quantity: it.quantity + addQty } : it))
    : [...cart.items, { id: cleanId, quantity: addQty }];

  showPageAlert('', { clear: true });
  setDrawerNotice([]);
  writeCart({ ...cart, items: nextItems });
  toast(`Added ${p.title} to bag`);
  if (open) openDrawer(document.activeElement);
  return { ok: true };
}

function updateQuantity(id, nextQty) {
  const cleanId = String(id || '').trim();
  const qty = Math.floor(Number(nextQty));
  if (!Number.isFinite(qty) || qty <= 0) {
    return removeItem(cleanId);
  }
  const p = findProduct(cleanId);
  if (!p || isSold(p) || isReserved(p)) {
    removeItem(cleanId);
    const msg = p ? `${p.title} is no longer available.` : 'Item is no longer available.';
    setDrawerNotice(msg);
    return { ok: false, message: msg };
  }
  const maxQty = availQty(p);
  if (qty > maxQty) {
    const msg = `Only ${maxQty} of ${p.title} available.`;
    setDrawerNotice(msg);
    toast(msg);
    return { ok: false, availableQuantity: maxQty, message: msg };
  }
  const cart = readCart();
  const nextItems = cart.items.map(it => (it.id === cleanId ? { ...it, quantity: qty } : it));
  setDrawerNotice([]);
  writeCart({ ...cart, items: nextItems });
  return { ok: true };
}

function removeItem(id) {
  const cleanId = String(id || '').trim();
  const cart = readCart();
  const nextItems = cart.items.filter(it => it.id !== cleanId);
  writeCart({ ...cart, items: nextItems });
  return { ok: true };
}

function clear() {
  setDrawerNotice([]);
  writeCart(emptyState());
}

function onChange(fn) {
  if (typeof fn !== 'function') return () => {};
  const handler = e => fn((e && e.detail) || { cart: readCart(), count: getCount(), subtotal: getSubtotal() });
  window.addEventListener('rm:cart', handler);
  return () => window.removeEventListener('rm:cart', handler);
}

/* ---------- global listeners ---------- */
document.addEventListener('click', e => {
  const openBtn = e.target.closest('[data-cart-open]');
  if (openBtn) {
    e.preventDefault();
    openDrawer(openBtn);
    return;
  }
  const addBtn = e.target.closest('[data-add-to-cart]');
  if (addBtn) {
    e.preventDefault();
    const id = addBtn.dataset.addToCart;
    if (addBtn.disabled) {
      const p = findProduct(id);
      const msg = p && isReserved(p) ? `${p.title} is currently reserved.` : 'This piece is sold out.';
      showPageAlert(msg);
      toast(msg);
      return;
    }
    addItem(id, 1, { open: true });
  }
});

window.addEventListener('storage', e => {
  if (e.key === STORAGE_KEY) {
    const cart = readCart();
    updateBadges(cart);
    renderDrawer(cart);
    window.dispatchEvent(new CustomEvent('rm:cart', {
      detail: { cart, count: getCount(cart), subtotal: getSubtotal(cart) }
    }));
  }
});

window.addEventListener('rm:catalog', () => {
  const cart = readCart();
  updateBadges(cart);
  renderDrawer(cart);
  const detail = { cart, count: getCount(cart), subtotal: getSubtotal(cart) };
  window.dispatchEvent(new CustomEvent('rm:cart', { detail }));
  window.dispatchEvent(new CustomEvent('retromod:cart-updated', { detail }));
});

/* ---------- boot ---------- */
ensureDrawerDom();
updateBadges(readCart());
renderDrawer(readCart());

RM.cart = {
  STORAGE_KEY,
  getCart: readCart,
  getItems: () => getDetailedItems(readCart()),
  getCount: () => getCount(readCart()),
  getSubtotal: () => getSubtotal(readCart()),
  addItem,
  updateQuantity,
  removeItem,
  clear,
  revalidate,
  open: openDrawer,
  close: closeDrawer,
  onChange,
  showPageAlert
};
})();
