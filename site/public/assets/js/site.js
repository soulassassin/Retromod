/* RETROMOD. — shared behaviour & live catalog hydration for every page */
(() => {
'use strict';
const D = window.RETROMOD || (window.RETROMOD = { links: {}, categories: [], products: [], followers: 55.3, posts: 471 });
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.documentElement.classList.add('js');

/* ---------- helpers exposed to page scripts ---------- */
const ICONS = {
  audio: '<svg viewBox="0 0 56 56" fill="none" stroke="#111" stroke-width="1.3"><rect x="5" y="18" width="46" height="20" rx="2"/><circle cx="41" cy="28" r="5"/><circle cx="41" cy="28" r="1.4" fill="#111"/><path d="M11 25h14M11 31h9"/><circle cx="29" cy="31" r="1.6"/><path d="M9 38v3M47 38v3"/></svg>',
  lighting: '<svg viewBox="0 0 56 56" fill="none" stroke="#111" stroke-width="1.3"><path d="M12 22c3-10 26-12 32 0"/><path d="M44 22c3 9 2 20-3 26"/><path d="M33 48h14"/><path d="M14 22h28" stroke-dasharray="2 3"/></svg>',
  cameras: '<svg viewBox="0 0 56 56" fill="none" stroke="#111" stroke-width="1.3"><rect x="6" y="16" width="44" height="28" rx="3"/><circle cx="30" cy="30" r="9"/><circle cx="30" cy="30" r="4.5"/><rect x="10" y="20" width="8" height="5" rx="1"/><path d="M38 16v-3h8v3"/></svg>',
  furniture: '<svg viewBox="0 0 56 56" fill="none" stroke="#111" stroke-width="1.3" stroke-linecap="round"><path d="M15 12c-2 8-2 17 1 24"/><path d="M16 36h22c3 0 4-2 4-5"/><path d="M28 37v7M20 48l8-4 8 4"/></svg>',
  art: '<svg viewBox="0 0 56 56" fill="none" stroke="#111" stroke-width="1.3"><rect x="9" y="9" width="38" height="38"/><rect x="15" y="15" width="26" height="26"/><circle cx="25" cy="27" r="5" fill="#111"/><path d="M15 41l10-9 8 6 8-7"/></svg>'
};

const CAT = {};
function syncCats(categories) {
  for (const k of Object.keys(CAT)) delete CAT[k];
  if (Array.isArray(categories)) {
    for (const c of categories) {
      if (c && c.id) CAT[c.id] = c.label || c.id;
    }
  }
}
syncCats(D.categories);

const esc = s => (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;'
}[c]));

const fmt = n => 'R' + Math.round(Number(n) || 0).toLocaleString('en-ZA').replace(/[\s\u00A0\u202F,]/g, '\u00A0');

const img = p => {
  if (!p) return 'assets/stock/placeholder.jpg';
  if (p.image) return String(p.image);
  return `assets/stock/${encodeURIComponent(p.id || '')}.jpg`;
};

const availQty = p => {
  if (!p || p.status === 'sold') return 0;
  if (p.quantity === undefined || p.quantity === null || p.quantity === '') return 1;
  const n = Math.floor(Number(p.quantity));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};

const isSold = p => !p || p.status === 'sold' || availQty(p) <= 0;
const isReserved = p => !isSold(p) && p.status === 'reserved';

const normSearch = s => String(s || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[\u2018\u2019']/g, '');

function matchesQuery(p, q) {
  const query = normSearch(String(q || '').trim());
  if (!query) return true;
  if (!p) return false;
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
}

const meta = p => [CAT[p.category] || p.category, p.origin, p.era].filter(Boolean).join(' · ');

const media = (p) => `
  <img src="${esc(img(p))}" alt="${esc(p.title)}" loading="eager" decoding="async" draggable="false"
       onerror="this.parentNode.classList.add('no-img')">
  <div class="ph" aria-hidden="true">${ICONS[p.category] || ICONS.furniture}<span>Photo on Instagram</span></div>`;

const card = (p, i = 0) => {
  const sold = isSold(p);
  const reserved = isReserved(p);
  const qty = availQty(p);
  const badgeClass = sold ? ' badge--sold' : reserved ? ' badge--reserved' : '';
  const badgeText = sold ? 'Sold' : reserved ? 'Reserved' : (qty > 1 ? `${qty} left` : 'Available');
  const cardStateClass = sold ? ' is-sold' : reserved ? ' is-reserved' : '';
  const href = `product.html?id=${encodeURIComponent(p.id)}`;

  return `
  <a class="pcard rv${cardStateClass}" style="--d:${(i % 4) * 60}ms" href="${href}" data-id="${esc(p.id)}" data-cat="${esc(p.category)}">
    <span class="badge${badgeClass}"><i></i>${esc(badgeText)}</span>
    <div class="pcard-media">${media(p)}</div>
    <div class="pcard-body">
      <span class="pcard-meta">${esc(meta(p))}</span>
      <h3>${esc(p.title)}</h3>
      <div class="pcard-link-row">
        <span class="price">${fmt(p.price)}</span>
        <span class="pcard-go" aria-hidden="true">↗</span>
      </div>
    </div>
  </a>`;
};

let toastEl, toastT;
function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const t = document.createElement('textarea');
    t.value = text;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}

// Instagram DMs can't be pre-filled, so copy the message then open the DM.
async function enquire(message) {
  const ok = await copy(message);
  toast(ok ? 'Message copied — paste it in the DM' : 'Opening Instagram DM…');
  const dmUrl = (D.links && D.links.dm) || 'https://ig.me/m/retromod.za';
  setTimeout(() => window.open(dmUrl, '_blank', 'noopener'), ok ? 450 : 0);
}

let revealIO;
// Scroll reveal. After the reveal finishes the element gets .rv-done, which drops the
// slow reveal transition so its own hover/press transitions apply again.
function revealed(el) {
  el.classList.add('in');
  const delay = parseFloat(getComputedStyle(el).getPropertyValue('--d')) || 0;
  setTimeout(() => el.classList.add('rv-done'), 950 + delay);
}
function reveal(root = document) {
  const els = $$('.rv:not(.in)', root);
  if (REDUCE || !('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('in', 'rv-done')); return; }
  revealIO = revealIO || new IntersectionObserver(ents => ents.forEach(en => {
    if (en.isIntersecting) { revealed(en.target); revealIO.unobserve(en.target); }
  }), { rootMargin: '0px 0px -8% 0px', threshold: .08 });
  els.forEach(e => revealIO.observe(e));
}

function ext(sel, url) {
  if (!url) return;
  $$(sel).forEach(a => { a.href = url; a.target = '_blank'; a.rel = 'noopener'; });
}

function hydrate(data) {
  if (data && typeof data === 'object') {
    if (data.links) D.links = data.links;
    if (Array.isArray(data.address)) D.address = data.address;
    if (data.followers != null) D.followers = data.followers;
    if (data.posts != null) D.posts = data.posts;
    if (Array.isArray(data.categories)) D.categories = data.categories;
    if (data.stats) D.stats = data.stats;
    if (Array.isArray(data.products)) D.products = data.products;
    syncCats(D.categories);
  }
  const L = D.links || {};
  ext('[data-ig]', L.instagram);
  ext('[data-dm]', L.dm);
  ext('[data-wa]', L.whatsapp);
  ext('[data-maps]', L.maps);
  $$('[data-year]').forEach(e => { e.textContent = new Date().getFullYear(); });
  if (D.followers != null) $$('[data-followers]').forEach(e => { e.textContent = D.followers + 'K'; });
  if (D.posts != null) $$('[data-posts]').forEach(e => { e.textContent = D.posts; });
  const prods = Array.isArray(D.products) ? D.products : [];
  const availableCount = prods.filter(p => !isSold(p)).length;
  $$('[data-stock-count]').forEach(e => { e.textContent = availableCount; });
  return D;
}

let inFlight = null;
async function loadCatalog({ force = false } = {}) {
  if (inFlight && !force) return inFlight;
  const req = (async () => {
    try {
      const res = await fetch('/api/products', { cache: 'no-store' });
      if (!res.ok) return D;
      const data = await res.json();
      if (data && Array.isArray(data.products)) {
        hydrate(data);
        window.dispatchEvent(new CustomEvent('rm:catalog', { detail: D }));
        window.dispatchEvent(new CustomEvent('retromod:catalog-updated', { detail: D }));
      }
    } catch {
      // Static/offline fallback: keep existing window.RETROMOD silently
    } finally {
      if (inFlight === req) inFlight = null;
    }
    return D;
  })();
  inFlight = req;
  return req;
}

function getCatalog() {
  return D;
}

function onCatalog(fn) {
  if (typeof fn !== 'function') return () => {};
  try { fn(D); } catch (err) { console.error(err); }
  const handler = e => fn((e && e.detail) || D);
  window.addEventListener('rm:catalog', handler);
  return () => window.removeEventListener('rm:catalog', handler);
}

window.RM = {
  $,
  $$,
  fmt,
  img,
  esc,
  meta,
  media,
  card,
  availQty,
  isSold,
  isReserved,
  normSearch,
  matchesQuery,
  hydrate,
  getCatalog,
  loadCatalog,
  refreshCatalog: () => loadCatalog({ force: true }),
  onCatalog,
  toast,
  copy,
  enquire,
  reveal,
  ICONS,
  CAT,
  REDUCE
};

/* ---------- initial hydration & live sync ---------- */
hydrate(D);
loadCatalog();
window.addEventListener('pageshow', e => {
  if (e.persisted) loadCatalog({ force: true });
});

/* ---------- header ---------- */
const page = document.body.dataset.page;
const nav = $('#nav'), ind = nav && $('.nav-ind', nav), links = nav ? $$('a', nav) : [];
const active = links.find(a => a.dataset.page === page) || null;
$$('[data-page]', document.querySelector('.site-header')).forEach(a => {
  if (a.dataset.page === page) { a.classList.add('on'); a.setAttribute('aria-current', 'page'); }
});
function place(a, instant) {
  if (!ind) return;
  if (!a) { ind.style.width = '0px'; links.forEach(l => l.classList.remove('on')); return; }
  ind.classList.toggle('instant', !!instant);
  ind.style.width = a.offsetWidth + 'px';
  ind.style.transform = `translateX(${a.offsetLeft}px)`;
  links.forEach(l => l.classList.toggle('on', l === a));
  if (instant) requestAnimationFrame(() => ind.classList.remove('instant'));
}
if (nav) {
  links.forEach(a => a.addEventListener('mouseenter', () => place(a)));
  nav.addEventListener('mouseleave', () => place(active));
  place(active, true);
  addEventListener('resize', () => place(active, true));
  document.fonts && document.fonts.ready.then(() => place(active, true));
}
const header = $('.site-header');
const onScroll = () => header && header.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true }); onScroll();

// mobile menu
const menuBtn = $('#menuBtn');
function setMenu(open) {
  document.body.classList.toggle('menu-open', open);
  menuBtn && menuBtn.setAttribute('aria-expanded', String(Boolean(open)));
}
menuBtn && menuBtn.addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
$$('#mnav a, #mnav button').forEach(a => a.addEventListener('click', () => setMenu(false)));
addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
matchMedia('(min-width: 761px)').addEventListener('change', e => e.matches && setMenu(false));

// enquiry buttons anywhere: <button data-enquire="message">
document.addEventListener('click', e => {
  const b = e.target.closest('[data-enquire]');
  if (!b) return;
  e.preventDefault();
  enquire(b.dataset.enquire || 'Hi RETROMOD., I found you through your website and would like to enquire.');
});

reveal();
})();
