(() => {
  'use strict';

  const CATEGORIES = [
    { id: 'audio', label: 'Audio' },
    { id: 'lighting', label: 'Lighting' },
    { id: 'cameras', label: 'Cameras' },
    { id: 'furniture', label: 'Furniture' },
    { id: 'art', label: 'Art' }
  ];

  const PRODUCT_STATUSES = ['available', 'reserved', 'sold'];
  const ORDER_STATUSES = [
    'pending',
    'pending_payment',
    'confirmed',
    'paid',
    'ready_for_collection',
    'dispatched',
    'shipped',
    'completed',
    'cancelled'
  ];

  const state = {
    authenticated: false,
    activeTab: 'inventory',
    importMode: 'urls',
    catalog: [],
    stats: null,
    orders: [],
    importItems: [],
    importSummary: null
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(val) {
    return String(val == null ? '' : val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeImgUrl(raw) {
    const val = String(raw || '').trim();
    if (!val) return '';
    if (/^data:image\/(?:jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(val)) {
      return val;
    }
    if (/^(?:javascript|vbscript|data|file):/i.test(val)) return '';
    if (val.includes('..') || val.includes('\\') || val.startsWith('//')) return '';
    if (/^(?:\/?(?:assets|media)\/[a-zA-Z0-9._/-]+)$/.test(val)) {
      return val;
    }
    try {
      const parsed = new URL(val, window.location.origin);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.toString();
      }
    } catch {
      return '';
    }
    return '';
  }

  function safeExtUrl(raw) {
    const val = String(raw || '').trim();
    if (!val) return '';
    try {
      const parsed = new URL(val);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.toString();
      }
    } catch {
      return '';
    }
    return '';
  }

  function fmtZar(amount) {
    const num = Math.round(Number(amount) || 0);
    return 'R' + num.toLocaleString('en-ZA');
  }

  function formatOrderStatusLabel(s) {
    return String(s || 'pending').replace(/_/g, ' ');
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function setRegionMsg(el, msg) {
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = '';
    } else {
      el.textContent = msg;
      el.hidden = false;
    }
  }

  async function api(url, opts = {}) {
    const fetchOpts = {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {})
      }
    };
    if (opts.body !== undefined) {
      fetchOpts.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }

    const res = await fetch(url, fetchOpts);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.status === 401 && !opts.allow401) {
      handleSessionLost('Your admin session expired. Please sign in again.');
      const err = new Error((data && data.error) || 'Authentication required');
      err.status = 401;
      err.data = data;
      throw err;
    }

    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  function handleSessionLost(message) {
    state.authenticated = false;
    state.catalog = [];
    state.orders = [];
    state.importItems = [];
    state.importSummary = null;
    renderAuthState();
    setRegionMsg($('#loginError'), message || '');
  }

  function renderAuthState() {
    const loginView = $('#loginView');
    const workspaceView = $('#workspaceView');
    const logoutBtn = $('#logoutBtn');
    const sessionBadge = $('#sessionBadge');

    if (state.authenticated) {
      loginView.hidden = true;
      workspaceView.hidden = false;
      logoutBtn.hidden = false;
      sessionBadge.hidden = false;
    } else {
      workspaceView.hidden = true;
      loginView.hidden = false;
      logoutBtn.hidden = true;
      sessionBadge.hidden = true;
      const pwInput = $('#adminPassword');
      if (pwInput) pwInput.focus();
    }
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    $$('[role="tab"]').forEach(btn => {
      const active = btn.dataset.tab === tabName;
      btn.classList.toggle('on', active);
      btn.setAttribute('aria-selected', String(active));
    });
    const targetPanel = $(`#panel-${tabName}`);
    if (targetPanel && typeof targetPanel.scrollIntoView === 'function') {
      targetPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function renderStats() {
    const st = state.stats || {};
    const avail = st.availableCount != null ? st.availableCount : state.catalog.filter(p => p.status === 'available').length;
    const resv = st.reservedCount != null ? st.reservedCount : state.catalog.filter(p => p.status === 'reserved').length;
    const sold = st.soldCount != null ? st.soldCount : state.catalog.filter(p => p.status === 'sold').length;
    const units = st.totalUnits != null ? st.totalUnits : state.catalog.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
    const value = st.totalValue != null ? st.totalValue : state.catalog.reduce((sum, p) => sum + (p.status === 'sold' ? 0 : (Number(p.price) || 0) * (Number(p.quantity) || 0)), 0);

    $('#statAvailable').textContent = String(avail);
    $('#statReserved').textContent = String(resv);
    $('#statSold').textContent = String(sold);
    $('#statUnits').textContent = String(units);
    $('#statValue').textContent = fmtZar(value);
    $('#statOrders').textContent = String(state.orders.length);
    $('#tabCountInventory').textContent = String(state.catalog.length);
    $('#tabCountOrders').textContent = String(state.orders.length);
  }

  function renderInventory() {
    const tbody = $('#inventoryBody');
    const q = ($('#invSearch').value || '').trim().toLowerCase();
    const statusFilter = $('#invStatus').value || 'all';

    const list = state.catalog.filter(p => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (!q) return true;
      const hay = [p.id, p.title, p.maker, p.category, p.instagramShortcode].join(' ').toLowerCase();
      return hay.includes(q);
    });

    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="adm-empty-state">No catalog pieces match the current filter.</div></td></tr>';
      return;
    }

    tbody.innerHTML = list.map(p => {
      const imgSrc = safeImgUrl(p.image);
      const igHref = safeExtUrl(p.instagramUrl);
      const catOpts = CATEGORIES.map(c =>
        `<option value="${esc(c.id)}"${p.category === c.id ? ' selected' : ''}>${esc(c.label)}</option>`
      ).join('');
      const statusOpts = PRODUCT_STATUSES.map(st =>
        `<option value="${esc(st)}"${p.status === st ? ' selected' : ''}>${esc(st)}</option>`
      ).join('');

      return `
        <tr data-product-id="${esc(p.id)}" data-dirty="false">
          <td>
            <div class="adm-thumb">
              ${imgSrc ? `<img src="${esc(imgSrc)}" alt="${esc(p.title)}" onerror="this.hidden=true;this.nextElementSibling.hidden=false">` : ''}
              <span class="adm-thumb-ph"${imgSrc ? ' hidden' : ''}>No image</span>
            </div>
          </td>
          <td>
            <div class="adm-cell-title">
              <input class="input" type="text" data-field="title" value="${esc(p.title)}" aria-label="Title (${esc(p.id)})">
              <div class="adm-meta-line">
                <span>${esc(p.id)}</span>
                ${p.maker ? `<span>· ${esc(p.maker)}</span>` : ''}
                ${igHref ? `<a href="${esc(igHref)}" target="_blank" rel="noopener noreferrer">IG ↗</a>` : ''}
              </div>
            </div>
          </td>
          <td>
            <select class="input" data-field="category" aria-label="Category (${esc(p.id)})">${catOpts}</select>
          </td>
          <td>
            <input class="input adm-price-input" type="number" min="0" step="1" data-field="price" value="${esc(p.price)}" aria-label="Price in ZAR (${esc(p.id)})">
          </td>
          <td>
            <input class="input adm-qty-input" type="number" min="0" step="1" data-field="quantity" value="${esc(p.quantity)}" aria-label="Quantity (${esc(p.id)})">
          </td>
          <td>
            <select class="input" data-field="status" aria-label="Status (${esc(p.id)})">${statusOpts}</select>
          </td>
          <td>
            <button type="button" class="btn" data-save-product="${esc(p.id)}">Save</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function loadCatalog() {
    const data = await api('/api/admin/catalog');
    state.catalog = Array.isArray(data.products) ? data.products : [];
    state.stats = data.stats || null;
    renderStats();
    renderInventory();
  }

  async function loadOrders() {
    const data = await api('/api/admin/orders');
    state.orders = Array.isArray(data.orders) ? data.orders : [];
    renderStats();
    renderOrders();
  }

  async function loadWorkspaceData() {
    setRegionMsg($('#adminAlert'), '');
    try {
      await Promise.all([loadCatalog(), loadOrders()]);
    } catch (err) {
      if (err.status !== 401) {
        setRegionMsg($('#adminAlert'), err.message || 'Failed to load admin data');
      }
    }
  }

  function renderOrders() {
    const container = $('#ordersBody');
    const filter = $('#ordersStatusFilter').value || 'all';
    const list = state.orders.filter(o => filter === 'all' || o.status === filter);

    if (!list.length) {
      container.innerHTML = '<div class="adm-empty-state">No orders found for the selected filter.</div>';
      return;
    }

    container.innerHTML = list.map(o => {
      const cust = o.customer || {};
      const addr = o.shippingAddress;
      const items = Array.isArray(o.items) ? o.items : [];
      const statusOpts = ORDER_STATUSES.map(st =>
        `<option value="${esc(st)}"${o.status === st ? ' selected' : ''}>${esc(formatOrderStatusLabel(st))}</option>`
      ).join('');
      const isCancelled = o.status === 'cancelled';

      return `
        <article class="adm-order-card" data-order-ref="${esc(o.orderRef)}">
          <div class="adm-order-head">
            <div>
              <div class="adm-order-ref">${esc(o.orderRef)}</div>
              <div class="adm-meta-line">
                <span>${esc((o.createdAt || '').slice(0, 19).replace('T', ' '))}</span>
                <span>· Total: <strong>${esc(fmtZar(o.totalZar))}</strong></span>
                ${o.stockRestoredAt ? '<span>· Stock restored</span>' : ''}
              </div>
            </div>
            <div class="adm-order-controls">
              <select class="input" data-order-status aria-label="Order status for ${esc(o.orderRef)}"${isCancelled ? ' disabled' : ''}>
                ${statusOpts}
              </select>
              <button type="button" class="btn" data-save-order="${esc(o.orderRef)}"${isCancelled ? ' disabled' : ''}>Update</button>
            </div>
          </div>
          <div class="adm-order-grid">
            <div class="adm-order-col">
              <h4>Customer</h4>
              <p>${esc(cust.name || '')}</p>
              <p>${esc(cust.email || '')}</p>
              <p>${esc(cust.phone || '')}</p>
            </div>
            <div class="adm-order-col">
              <h4>Fulfillment &amp; Payment</h4>
              <p>Fulfillment: ${esc(o.fulfillment || '')}</p>
              <p>Payment: ${esc(formatOrderStatusLabel(o.paymentMethod || ''))}</p>
              ${addr ? `<p>${esc([addr.street, addr.suburb, addr.city, addr.province, addr.postalCode].filter(Boolean).join(', '))}</p>` : ''}
              ${o.notes ? `<p>Note: ${esc(o.notes)}</p>` : ''}
            </div>
            <div class="adm-order-col">
              <h4>Line Items</h4>
              <ul>
                ${items.map(it => `<li>${esc(it.quantity)} × ${esc(it.title || it.id)} (${esc(fmtZar(it.lineTotalZar != null ? it.lineTotalZar : (it.price || 0) * (it.quantity || 1)))})</li>`).join('')}
              </ul>
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  function setImportMode(mode) {
    state.importMode = mode;
    const modeSelect = $('#importModeSelect');
    if (modeSelect && modeSelect.value !== mode) {
      modeSelect.value = mode;
    }
    $$('[data-import-mode]').forEach(btn => {
      const active = btn.dataset.importMode === mode;
      btn.classList.toggle('on', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    const exportWrap = $('#exportFileWrap');
    if (exportWrap) {
      exportWrap.hidden = mode !== 'export';
    }
  }

  function updateCommitCount() {
    const selected = state.importItems.filter(it => it.include).length;
    $('#commitSelectionCount').textContent = `${selected} of ${state.importItems.length} selected`;
    $('#commitImportBtn').disabled = selected === 0;
  }

  function renderImportPreview() {
    const section = $('#importPreviewSection');
    if (!state.importItems.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;

    const sum = state.importSummary || { total: state.importItems.length, valid: 0, duplicates: 0, invalid: 0, nonProduct: 0 };
    $('#importSummary').innerHTML = `
      <span class="adm-pill">Total: ${esc(sum.total)}</span>
      <span class="adm-pill">Valid: ${esc(sum.valid)}</span>
      <span class="adm-pill">Duplicates: ${esc(sum.duplicates)}</span>
      <span class="adm-pill">Invalid: ${esc(sum.invalid)}</span>
      <span class="adm-pill">Non-product: ${esc(sum.nonProduct)}</span>
    `;

    $('#importPreviewBody').innerHTML = state.importItems.map((item, idx) => {
      const c = item.candidate || {};
      const previewSrc = safeImgUrl(c.imageData || c.image || c.remoteImageUrl || '');
      const catOpts = CATEGORIES.map(cat =>
        `<option value="${esc(cat.id)}"${c.category === cat.id ? ' selected' : ''}>${esc(cat.label)}</option>`
      ).join('');
      const statusOpts = PRODUCT_STATUSES.map(st =>
        `<option value="${esc(st)}"${c.status === st ? ' selected' : ''}>${esc(st)}</option>`
      ).join('');

      const errList = (item.errors || []).map(e => `<li class="adm-msg-err">Error: ${esc(e)}</li>`).join('');
      const warnList = (item.warnings || []).map(w => `<li class="adm-msg-warn">Note: ${esc(w)}</li>`).join('');

      return `
        <div class="adm-cand" data-cand-index="${idx}" data-preview-row="${idx}">
          <div class="adm-cand-head">
            <label class="adm-check">
              <input type="checkbox" data-cand-include="${idx}" aria-label="Include candidate ${esc(c.title || item.tempId)}"${item.include ? ' checked' : ''}>
              <span><strong>${esc(item.tempId)}</strong></span>
            </label>
            <span class="adm-badge adm-badge--${esc(item.action)}">${esc(item.action)}</span>
          </div>
          <div class="adm-cand-body">
            <div class="adm-cand-media">
              <div class="adm-cand-thumb">
                ${previewSrc ? `<img src="${esc(previewSrc)}" alt="${esc(c.title || 'Candidate preview')}" onerror="this.hidden=true;this.nextElementSibling.hidden=false">` : ''}
                <span class="adm-thumb-ph"${previewSrc ? ' hidden' : ''}>No image</span>
              </div>
              <div class="field">
                <label for="cand-file-${idx}">Upload local image</label>
                <input id="cand-file-${idx}" class="input adm-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-cand-file="${idx}" aria-label="Upload local image for ${esc(c.title || item.tempId)}">
              </div>
            </div>
            <div class="adm-cand-grid">
              <div class="field adm-span-2">
                <label for="cand-title-${idx}">Title</label>
                <input id="cand-title-${idx}" class="input" type="text" data-cand-field="title" value="${esc(c.title || '')}" aria-label="Candidate title for ${esc(item.tempId)}">
              </div>
              <div class="field">
                <label for="cand-id-${idx}">Product ID slug</label>
                <input id="cand-id-${idx}" class="input" type="text" data-cand-field="id" value="${esc(c.id || '')}" aria-label="Candidate id for ${esc(item.tempId)}">
              </div>
              <div class="field">
                <label for="cand-maker-${idx}">Maker / Artist</label>
                <input id="cand-maker-${idx}" class="input" type="text" data-cand-field="maker" value="${esc(c.maker || '')}" aria-label="Candidate maker for ${esc(item.tempId)}">
              </div>
              <div class="field">
                <label for="cand-origin-${idx}">Origin</label>
                <input id="cand-origin-${idx}" class="input" type="text" data-cand-field="origin" value="${esc(c.origin || '')}" aria-label="Candidate origin for ${esc(item.tempId)}">
              </div>
              <div class="field">
                <label for="cand-era-${idx}">Era</label>
                <input id="cand-era-${idx}" class="input" type="text" data-cand-field="era" value="${esc(c.era || '')}" aria-label="Candidate era for ${esc(item.tempId)}">
              </div>
              <div class="field">
                <label for="cand-cat-${idx}">Category</label>
                <select id="cand-cat-${idx}" class="input" data-cand-field="category" aria-label="Candidate category for ${esc(item.tempId)}">${catOpts}</select>
              </div>
              <div class="field">
                <label for="cand-price-${idx}">Price (ZAR)</label>
                <input id="cand-price-${idx}" class="input" type="number" min="0" step="1" data-cand-field="price" value="${esc(c.price || 0)}" aria-label="Candidate price for ${esc(item.tempId)}">
              </div>
              <div class="field">
                <label for="cand-qty-${idx}">Quantity</label>
                <input id="cand-qty-${idx}" class="input" type="number" min="0" step="1" data-cand-field="quantity" value="${esc(c.quantity != null ? c.quantity : 1)}" aria-label="Candidate quantity for ${esc(item.tempId)}">
              </div>
              <div class="field">
                <label for="cand-status-${idx}">Status</label>
                <select id="cand-status-${idx}" class="input" data-cand-field="status" aria-label="Candidate status for ${esc(item.tempId)}">${statusOpts}</select>
              </div>
              <div class="field adm-span-2">
                <label for="cand-ig-${idx}">Instagram URL</label>
                <input id="cand-ig-${idx}" class="input" type="url" data-cand-field="instagramUrl" value="${esc(c.instagramUrl || '')}" aria-label="Candidate Instagram URL for ${esc(item.tempId)}">
              </div>
              <div class="field adm-span-3">
                <label for="cand-remote-${idx}">Remote image URL (downloaded locally on commit)</label>
                <input id="cand-remote-${idx}" class="input" type="url" data-cand-field="remoteImageUrl" value="${esc(c.remoteImageUrl || '')}" aria-label="Candidate remote image URL for ${esc(item.tempId)}">
              </div>
              <div class="field adm-span-3">
                <label for="cand-lede-${idx}">Lede</label>
                <input id="cand-lede-${idx}" class="input" type="text" data-cand-field="lede" value="${esc(c.lede || '')}" aria-label="Candidate lede for ${esc(item.tempId)}">
              </div>
            </div>
          </div>
          ${(errList || warnList) ? `<ul class="adm-row-msgs">${errList}${warnList}</ul>` : ''}
        </div>
      `;
    }).join('');

    updateCommitCount();
  }

  // Event Wiring
  $('#loginForm').addEventListener('submit', async evt => {
    evt.preventDefault();
    setRegionMsg($('#loginError'), '');
    const pwEl = $('#adminPassword');
    const password = pwEl.value;
    if (!password) {
      setRegionMsg($('#loginError'), 'Please enter the admin password.');
      pwEl.focus();
      return;
    }
    const btn = $('#loginBtn');
    btn.disabled = true;
    try {
      await api('/api/admin/login', {
        method: 'POST',
        body: { password },
        allow401: true
      });
      pwEl.value = '';
      state.authenticated = true;
      renderAuthState();
      await loadWorkspaceData();
      showToast('Signed in to RETROMOD Admin');
    } catch (err) {
      setRegionMsg($('#loginError'), err.message || 'Sign in failed');
      pwEl.focus();
    } finally {
      btn.disabled = false;
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/admin/logout', { method: 'POST', allow401: true });
    } catch {
      // ignore
    }
    state.authenticated = false;
    state.catalog = [];
    state.orders = [];
    state.importItems = [];
    state.importSummary = null;
    renderAuthState();
    setRegionMsg($('#loginError'), '');
    showToast('Logged out');
  });

  $$('[role="tab"]').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      switchTab(tabBtn.dataset.tab);
    });
  });

  $('#invSearch').addEventListener('input', () => renderInventory());
  $('#invStatus').addEventListener('change', () => renderInventory());
  $('#invRefreshBtn').addEventListener('click', () => loadCatalog().then(() => showToast('Inventory refreshed')));

  // Sync quantity <-> status in inventory table and handle Save
  $('#inventoryBody').addEventListener('change', evt => {
    const row = evt.target.closest('tr[data-product-id]');
    if (!row) return;
    row.dataset.dirty = 'true';
    const qtyEl = row.querySelector('[data-field="quantity"]');
    const statusEl = row.querySelector('[data-field="status"]');

    if (evt.target === statusEl) {
      if (statusEl.value === 'sold') {
        qtyEl.value = '0';
      } else if (Number(qtyEl.value) <= 0) {
        qtyEl.value = '1';
      }
    } else if (evt.target === qtyEl) {
      const q = Math.max(0, Math.floor(Number(qtyEl.value) || 0));
      qtyEl.value = String(q);
      if (q === 0) {
        statusEl.value = 'sold';
      } else if (statusEl.value === 'sold') {
        statusEl.value = 'available';
      }
    }
  });

  $('#inventoryBody').addEventListener('click', async evt => {
    const btn = evt.target.closest('[data-save-product]');
    if (!btn) return;
    const id = btn.dataset.saveProduct;
    const row = btn.closest('tr[data-product-id]');
    if (!row) return;

    setRegionMsg($('#invFeedback'), '');
    setRegionMsg($('#invError'), '');

    const title = row.querySelector('[data-field="title"]').value.trim();
    const category = row.querySelector('[data-field="category"]').value;
    const price = Number(row.querySelector('[data-field="price"]').value);
    const quantity = Number(row.querySelector('[data-field="quantity"]').value);
    const status = row.querySelector('[data-field="status"]').value;

    if (!title) {
      setRegionMsg($('#invError'), 'Product title cannot be empty.');
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setRegionMsg($('#invError'), 'Price must be a non-negative number.');
      return;
    }
    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 0) {
      setRegionMsg($('#invError'), 'Quantity must be a non-negative whole number.');
      return;
    }

    btn.disabled = true;
    try {
      const res = await api(`/api/admin/products/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { title, category, price, quantity, status }
      });
      const updated = res.product;
      const idx = state.catalog.findIndex(p => p.id === id);
      if (idx !== -1) state.catalog[idx] = updated;
      await loadCatalog();
      setRegionMsg($('#invFeedback'), `Saved "${updated.title}"`);
      showToast(`Saved ${updated.title}`);
    } catch (err) {
      setRegionMsg($('#invError'), err.message || 'Failed to save product');
    } finally {
      btn.disabled = false;
    }
  });

  // Import Mode Switcher
  $$('[data-import-mode]').forEach(btn => {
    btn.addEventListener('click', () => setImportMode(btn.dataset.importMode));
  });
  const importModeSelect = $('#importModeSelect');
  if (importModeSelect) {
    importModeSelect.addEventListener('change', () => setImportMode(importModeSelect.value));
  }

  $('#importExportFile').addEventListener('change', evt => {
    const file = evt.target.files && evt.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $('#importUrls').value = String(reader.result || '');
      setRegionMsg($('#importStatus'), `Loaded "${file.name}" (${file.size} bytes). Click Preview to inspect candidates.`);
    };
    reader.onerror = () => {
      setRegionMsg($('#importError'), 'Could not read the selected export file.');
    };
    reader.readAsText(file);
  });

  $('#clearImportBtn').addEventListener('click', () => {
    $('#importUrls').value = '';
    if ($('#importExportFile')) $('#importExportFile').value = '';
    state.importItems = [];
    state.importSummary = null;
    setRegionMsg($('#importError'), '');
    setRegionMsg($('#importStatus'), '');
    setRegionMsg($('#importCommitReport'), '');
    setRegionMsg($('#importCommitErrors'), '');
    renderImportPreview();
  });

  $('#previewImportBtn').addEventListener('click', async () => {
    setRegionMsg($('#importError'), '');
    setRegionMsg($('#importStatus'), '');
    setRegionMsg($('#importCommitReport'), '');
    setRegionMsg($('#importCommitErrors'), '');

    const mode = state.importMode;
    const body = { mode };
    const rawInput = ($('#importUrls').value || '').trim();

    if (mode === 'urls') {
      const urls = rawInput
        .split(/[\r\n,]+/)
        .map(s => s.trim())
        .filter(Boolean);
      if (!urls.length) {
        setRegionMsg($('#importError'), 'Enter at least one Instagram post URL.');
        $('#importUrls').focus();
        return;
      }
      body.urls = urls;
    } else if (mode === 'export') {
      if (!rawInput) {
        setRegionMsg($('#importError'), 'Upload or paste a JSON or CSV export payload.');
        $('#importUrls').focus();
        return;
      }
      if (rawInput.startsWith('{') || rawInput.startsWith('[')) {
        try {
          body.payload = JSON.parse(rawInput);
        } catch {
          setRegionMsg($('#importError'), 'Export JSON is invalid.');
          return;
        }
      } else {
        body.payload = rawInput;
      }
    } else {
      if (!rawInput) {
        setRegionMsg($('#importError'), 'Paste at least one @retromod.za caption.');
        $('#importUrls').focus();
        return;
      }
      body.payload = rawInput;
    }

    const btn = $('#previewImportBtn');
    btn.disabled = true;
    try {
      const res = await api('/api/admin/import/preview', {
        method: 'POST',
        body
      });
      state.importItems = (Array.isArray(res.items) ? res.items : []).map(it => ({
        ...it,
        include: it.action === 'create' || it.action === 'update'
      }));
      state.importSummary = res.summary || null;
      renderImportPreview();
      setRegionMsg($('#importStatus'), `Previewed ${state.importItems.length} item(s). Review fields below and commit selected pieces.`);
    } catch (err) {
      setRegionMsg($('#importError'), err.message || 'Preview failed');
    } finally {
      btn.disabled = false;
    }
  });

  $('#selectValidBtn').addEventListener('click', () => {
    state.importItems.forEach(it => {
      it.include = it.action === 'create' || it.action === 'update';
    });
    renderImportPreview();
  });

  $('#deselectAllBtn').addEventListener('click', () => {
    state.importItems.forEach(it => {
      it.include = false;
    });
    renderImportPreview();
  });

  $('#importPreviewBody').addEventListener('change', evt => {
    if (evt.target.dataset.candInclude !== undefined) {
      const idx = Number(evt.target.dataset.candInclude);
      if (state.importItems[idx]) {
        state.importItems[idx].include = evt.target.checked;
        updateCommitCount();
      }
      return;
    }

    if (evt.target.dataset.candFile !== undefined) {
      const idx = Number(evt.target.dataset.candFile);
      const file = evt.target.files && evt.target.files[0];
      if (!file || !state.importItems[idx]) return;

      const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      if (!allowed.includes(file.type)) {
        setRegionMsg($('#importError'), 'Please upload a JPEG, PNG, WEBP, or GIF image.');
        evt.target.value = '';
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        setRegionMsg($('#importError'), 'Image file must be 5 MB or smaller.');
        evt.target.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const dataUri = String(reader.result || '');
        state.importItems[idx].candidate.imageData = dataUri;
        state.importItems[idx].candidate.remoteImageUrl = '';
        if (state.importItems[idx].action === 'invalid') {
          state.importItems[idx].action = 'create';
          state.importItems[idx].include = true;
        }
        renderImportPreview();
      };
      reader.readAsDataURL(file);
      return;
    }

    const candWrap = evt.target.closest('[data-cand-index]');
    const field = evt.target.dataset.candField;
    if (candWrap && field) {
      const idx = Number(candWrap.dataset.candIndex);
      const item = state.importItems[idx];
      if (!item || !item.candidate) return;
      let val = evt.target.value;
      if (field === 'price' || field === 'quantity') {
        val = Number(val);
      }
      item.candidate[field] = val;
      if (field === 'status' && val === 'sold') {
        item.candidate.quantity = 0;
        const qEl = candWrap.querySelector('[data-cand-field="quantity"]');
        if (qEl) qEl.value = '0';
      } else if (field === 'status' && val !== 'sold' && Number(item.candidate.quantity) <= 0) {
        item.candidate.quantity = 1;
        const qEl = candWrap.querySelector('[data-cand-field="quantity"]');
        if (qEl) qEl.value = '1';
      }
    }
  });

  $('#importPreviewBody').addEventListener('input', evt => {
    const candWrap = evt.target.closest('[data-cand-index]');
    const field = evt.target.dataset.candField;
    if (!candWrap || !field) return;
    const idx = Number(candWrap.dataset.candIndex);
    const item = state.importItems[idx];
    if (!item || !item.candidate) return;
    item.candidate[field] = (field === 'price' || field === 'quantity')
      ? Number(evt.target.value)
      : evt.target.value;
  });

  $('#commitImportBtn').addEventListener('click', async () => {
    setRegionMsg($('#importError'), '');
    setRegionMsg($('#importCommitReport'), '');
    setRegionMsg($('#importCommitErrors'), '');

    const selected = state.importItems.filter(it => it.include);
    if (!selected.length) {
      setRegionMsg($('#importError'), 'Select at least one candidate to commit.');
      return;
    }

    const payloadItems = selected.map(it => ({
      tempId: it.tempId,
      action: it.action === 'invalid' ? 'create' : it.action,
      matchedProductId: it.matchedProductId || null,
      include: true,
      candidate: it.candidate
    }));

    const btn = $('#commitImportBtn');
    btn.disabled = true;
    try {
      const res = await api('/api/admin/import/commit', {
        method: 'POST',
        body: {
          items: payloadItems,
          downloadImages: Boolean($('#importDownloadImages').checked)
        }
      });

      setRegionMsg(
        $('#importCommitReport'),
        `Commit complete: ${res.created || 0} created, ${res.updated || 0} updated, ${res.rejected || 0} rejected.`
      );
      if (Array.isArray(res.errors) && res.errors.length > 0) {
        setRegionMsg(
          $('#importCommitErrors'),
          res.errors.map(e => `${e.id || e.tempId}: ${e.reason}`).join(' | ')
        );
      }
      await loadCatalog();
      showToast(`Import committed (${res.created || 0} created, ${res.updated || 0} updated)`);
    } catch (err) {
      setRegionMsg($('#importError'), err.message || 'Commit failed');
    } finally {
      btn.disabled = false;
    }
  });

  // Orders events
  $('#ordersStatusFilter').addEventListener('change', () => renderOrders());
  $('#ordersRefreshBtn').addEventListener('click', () => loadOrders().then(() => showToast('Orders refreshed')));

  $('#ordersBody').addEventListener('click', async evt => {
    const btn = evt.target.closest('[data-save-order]');
    if (!btn) return;
    const orderRef = btn.dataset.saveOrder;
    const card = btn.closest('[data-order-ref]');
    if (!card) return;
    const nextStatus = card.querySelector('[data-order-status]').value;

    setRegionMsg($('#ordersFeedback'), '');
    setRegionMsg($('#ordersError'), '');
    btn.disabled = true;

    try {
      const res = await api(`/api/admin/orders/${encodeURIComponent(orderRef)}`, {
        method: 'PATCH',
        body: { status: nextStatus }
      });
      await Promise.all([loadOrders(), loadCatalog()]);
      const msg = res.order && res.order.status === 'cancelled'
        ? `Order ${orderRef} cancelled and stock restored to floor inventory.`
        : `Order ${orderRef} updated to ${formatOrderStatusLabel(nextStatus)}.`;
      setRegionMsg($('#ordersFeedback'), msg);
      showToast(`Order ${orderRef} updated`);
    } catch (err) {
      setRegionMsg($('#ordersError'), err.message || 'Failed to update order');
    } finally {
      btn.disabled = false;
    }
  });

  // Bootstrap session check
  (async () => {
    try {
      const session = await api('/api/admin/session', { allow401: true });
      state.authenticated = Boolean(session && session.authenticated);
      renderAuthState();
      if (state.authenticated) {
        await loadWorkspaceData();
      }
    } catch {
      state.authenticated = false;
      renderAuthState();
    }
  })();
})();
