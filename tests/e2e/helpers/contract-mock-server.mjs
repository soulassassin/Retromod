import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

const SEED_PRODUCTS = [
  {
    id: 'marantz-twenty-nine',
    title: 'Marantz Model Twenty Nine Stereo Receiver',
    maker: 'Marantz',
    origin: 'USA / Japan',
    era: '1972',
    category: 'audio',
    price: 6950,
    quantity: 1,
    status: 'available',
    added: '2026-11-14',
    image: 'assets/stock/marantz-twenty-nine.jpg',
    instagramUrl: 'https://www.instagram.com/retromod.za/p/DfnF8-nkdJi/',
    instagramShortcode: 'DfnF8-nkdJi',
    lede: 'Brushed champagne aluminium faceplate with warm gyro-touch tuning.',
    body: ['Serviced and bench tested at our Norwood workshop.'],
    specs: [
      ['Output', '30W per channel into 8Ω'],
      ['Origin', 'USA / Japan'],
      ['Era', '1972']
    ],
    updatedAt: '2026-11-17T13:30:00Z'
  },
  {
    id: 'pioneer-sa-6300',
    title: 'Pioneer SA-6300 Integrated Stereo Amplifier',
    maker: 'Pioneer',
    origin: 'Japan',
    era: '1975',
    category: 'audio',
    price: 3950,
    quantity: 1,
    status: 'available',
    added: '2026-11-13',
    image: 'assets/stock/pioneer-sa-6300.jpg',
    instagramUrl: 'https://www.instagram.com/retromod.za/p/DfnJqn-kduJ/',
    instagramShortcode: 'DfnJqn-kduJ',
    lede: 'Crisp silver-face integrated amplifier with phono stage.',
    body: ['Clean pots, balanced channels, ready for vinyl playback.'],
    specs: [
      ['Output', '20W per channel'],
      ['Origin', 'Japan'],
      ['Era', '1975']
    ],
    updatedAt: '2026-11-17T13:30:00Z'
  },
  {
    id: 'nad-3020i',
    title: 'NAD 3020i Integrated Amplifier',
    maker: 'NAD',
    origin: 'UK / Taiwan',
    era: '1991',
    category: 'audio',
    price: 3750,
    quantity: 1,
    status: 'available',
    added: '2026-11-12',
    image: 'assets/stock/nad-3020i.jpg',
    instagramUrl: 'https://www.instagram.com/retromod.za/p/DfnHVD3kQvR/',
    instagramShortcode: 'DfnHVD3kQvR',
    lede: 'Classic audiophile giant-killer integrated amplifier.',
    body: ['Legendary high-current output stage with pre-out/main-in jumpers.'],
    specs: [
      ['Output', '20W continuous, high dynamic headroom'],
      ['Origin', 'UK / Taiwan'],
      ['Era', '1991']
    ],
    updatedAt: '2026-11-17T13:30:00Z'
  },
  {
    id: 'kartell-taj-lamp',
    title: 'Kartell Taj Table Lamp by Ferruccio Laviani',
    maker: 'Kartell',
    origin: 'Italy',
    era: '2012',
    category: 'lighting',
    price: 3850,
    quantity: 1,
    status: 'available',
    added: '2026-11-11',
    image: 'assets/stock/kartell-taj-lamp.jpg',
    instagramUrl: 'https://www.instagram.com/retromod.za/p/DfnIlytkcNS/',
    instagramShortcode: 'DfnIlytkcNS',
    lede: 'Sculptural LED PMMA arc table lamp.',
    body: ['Genuine Italian Kartell production piece.'],
    specs: [
      ['Designer', 'Ferruccio Laviani'],
      ['Origin', 'Italy'],
      ['Era', '2012']
    ],
    updatedAt: '2026-11-17T13:30:00Z'
  },
  {
    id: 'fujifilm-x100v',
    title: 'Fujifilm X100V Digital Camera',
    maker: 'Fujifilm',
    origin: 'Japan',
    era: '2020',
    category: 'cameras',
    price: 28950,
    quantity: 1,
    status: 'available',
    added: '2026-11-10',
    image: 'assets/stock/fujifilm-x100v.jpg',
    instagramUrl: 'https://www.instagram.com/retromod.za/p/DfnEsmxkXdf/',
    instagramShortcode: 'DfnEsmxkXdf',
    lede: 'Weather-sealed 23mm f/2 fixed-lens rangefinder-style camera.',
    body: ['Includes original box, strap, and battery.'],
    specs: [
      ['Sensor', '26.1MP APS-C X-Trans CMOS 4'],
      ['Origin', 'Japan'],
      ['Era', '2020']
    ],
    updatedAt: '2026-11-17T13:30:00Z'
  }
];

const CATEGORIES = ['all', 'audio', 'lighting', 'cameras', 'furniture', 'art'];

function makeJpegOver10Kb(sampleJpgBuffer) {
  // Insert a valid JFIF COM (FF FE) marker with 11KB padding right after SOI (FF D8)
  const padLen = 11200;
  const comSegment = Buffer.alloc(4 + padLen, 0x20);
  comSegment[0] = 0xff;
  comSegment[1] = 0xfe;
  comSegment.writeUInt16BE(2 + padLen, 2);
  return Buffer.concat([sampleJpgBuffer.subarray(0, 2), comSegment, sampleJpgBuffer.subarray(2)]);
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function extractShortcode(url) {
  const m = /\/(?:p|reel)\/([A-Za-z0-9_-]+)/.exec(String(url || ''));
  return m ? m[1] : '';
}

function parsePriceZar(text, allowBareNumber = false) {
  const s = String(text || '').trim();
  const m = /R\s*([\d][\d\s,]*)/i.exec(s);
  if (m) {
    const num = Number(m[1].replace(/[\s,]/g, ''));
    return Number.isFinite(num) && num > 0 ? num : null;
  }
  if (allowBareNumber && /^-?\d+(?:\.\d+)?$/.test(s)) {
    const num = Number(s);
    return Number.isFinite(num) && num > 0 ? num : null;
  }
  return null;
}

function inferCategory(text) {
  const lower = String(text || '').toLowerCase();
  if (/lamp|lighting|pendant|sconce|kartell|artemide|poulsen|flos/.test(lower)) return 'lighting';
  if (/camera|leica|fujifilm|nikon|canon|hasselblad|lens/.test(lower)) return 'cameras';
  if (/credenza|chair|table|sofa|desk|furniture|teak|typewriter/.test(lower)) return 'furniture';
  if (/art|print|sculpture|poster|lithograph/.test(lower)) return 'art';
  return 'audio';
}

function isNonProductText(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return false;
  if (/showroom hours|closed this|public holiday|heritage day|come listen|pop in/.test(lower) && !parsePriceZar(text)) {
    return true;
  }
  return false;
}

function isHostBlocked(urlStr, allowHostsSet) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return true;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  const host = parsed.hostname.toLowerCase();
  if (allowHostsSet.has(host)) return false;
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host === '169.254.169.254' ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return true;
  }
  return false;
}

function parseCsvRows(csvText) {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = parseLine(line);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] ?? '';
    });
    return row;
  });
}

function layoutHtml({ title, page, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — RETROMOD</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #fafafa; color: #111; }
    header, main, footer { max-width: 1200px; margin: 0 auto; padding: 16px; }
    .site-header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #ddd; }
    .nav { display: flex; gap: 16px; }
    #menuBtn, #mnav { display: none; }
    .pgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
    .pcard { display: block; background: #fff; border: 1px solid #e5e5e5; padding: 12px; color: inherit; text-decoration: none; }
    .pcard img { width: 100%; height: 180px; object-fit: cover; display: block; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
    dialog, [role="dialog"] { border: 1px solid #111; background: #fff; padding: 20px; position: fixed; right: 16px; top: 16px; width: 340px; max-width: 90vw; z-index: 50; }
    [hidden] { display: none !important; }
    @media (max-width: 760px) {
      .nav { display: none; }
      #menuBtn { display: inline-block; }
      #mnav.open { display: block; }
    }
  </style>
</head>
<body data-page="${page}">
  <header class="site-header">
    <a href="/">RETROMOD</a>
    <nav id="nav" class="nav" aria-label="Primary">
      <a href="/" data-page="home">Home</a>
      <a href="/shop" data-page="shop">Shop</a>
      <a href="/about" data-page="about">About</a>
      <a href="/contact" data-page="contact">Contact</a>
      <a href="/admin" data-page="admin">Admin</a>
    </nav>
    <div>
      <button id="cartBtn" type="button" aria-label="Open cart">Cart (<span id="cartBadge">0</span>)</button>
      <button id="menuBtn" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="mnav">Menu</button>
    </div>
  </header>
  <nav id="mnav" aria-label="Mobile Navigation">
    <a href="/">Home</a>
    <a href="/shop">Shop</a>
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
    <a href="/checkout">Checkout</a>
  </nav>
  <main id="main">${body}</main>
  <section id="cartDrawer" role="dialog" aria-label="Your Cart" hidden>
    <h2>Your Cart</h2>
    <div id="cartItems"></div>
    <p id="cartWarning" role="alert"></p>
    <p>Subtotal: <strong id="cartSubtotal">R0</strong></p>
    <a id="cartCheckoutLink" href="/checkout">Checkout</a>
    <button id="closeCartBtn" type="button">Close</button>
  </section>
  <script>
    window.RM_CART_KEY = 'retromod_cart';
    function fmtZar(n) {
      return 'R' + Math.round(n).toLocaleString('en-ZA').replace(/[\\s\\u00a0\\u202f,]/g, '\\u00a0');
    }
    function esc(s) {
      return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function readCart() {
      try {
        const parsed = JSON.parse(localStorage.getItem(window.RM_CART_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.filter(x => x && typeof x.id === 'string' && Number(x.quantity) > 0) : [];
      } catch {
        localStorage.removeItem(window.RM_CART_KEY);
        return [];
      }
    }
    function writeCart(items) {
      localStorage.setItem(window.RM_CART_KEY, JSON.stringify(items));
      updateCartBadge();
    }
    function updateCartBadge() {
      const items = readCart();
      const totalQty = items.reduce((s, i) => s + Number(i.quantity || 0), 0);
      const el = document.getElementById('cartBadge');
      if (el) el.textContent = String(totalQty);
    }
    async function revalidateAndRenderCart() {
      const items = readCart();
      const res = await fetch('/api/products');
      const data = await res.json();
      const byId = new Map((data.products || []).map(p => [p.id, p]));
      const container = document.getElementById('cartItems');
      const warn = document.getElementById('cartWarning');
      const subEl = document.getElementById('cartSubtotal');
      const checkoutLink = document.getElementById('cartCheckoutLink');
      warn.textContent = '';
      if (items.length === 0) {
        container.innerHTML = '<p>Cart is empty.</p>';
        subEl.textContent = fmtZar(0);
        checkoutLink.setAttribute('aria-disabled', 'true');
        checkoutLink.style.pointerEvents = 'none';
        return;
      }
      checkoutLink.removeAttribute('aria-disabled');
      checkoutLink.style.pointerEvents = '';
      let subtotal = 0;
      const validCleaned = [];
      const warnings = [];
      container.innerHTML = '';
      for (const item of items) {
        const p = byId.get(item.id);
        if (!p) {
          warnings.push(item.id + ' is no longer available.');
          continue;
        }
        const avail = p.status === 'sold' ? 0 : Number(p.quantity || 0);
        let qty = Number(item.quantity || 1);
        if (avail <= 0) {
          warnings.push(p.title + ' is sold out / unavailable.');
        } else if (qty > avail) {
          qty = avail;
          warnings.push('Only ' + avail + ' available for ' + p.title);
        }
        validCleaned.push({ id: p.id, quantity: qty });
        if (avail > 0) subtotal += p.price * qty;
        const row = document.createElement('div');
        row.dataset.cartItem = p.id;
        row.innerHTML = '<div><strong>' + esc(p.title) + '</strong> — ' + fmtZar(p.price) +
          (avail <= 0 ? ' <span>(Sold out)</span>' : '') + '</div>' +
          '<div>' +
          '<button type="button" aria-label="Decrease ' + esc(p.title) + '">-</button> ' +
          '<span data-qty>' + qty + '</span> ' +
          '<button type="button" aria-label="Increase ' + esc(p.title) + '">+</button> ' +
          '<button type="button" aria-label="Remove ' + esc(p.title) + '">Remove</button>' +
          '</div>';
        const btns = row.querySelectorAll('button');
        btns[0].onclick = () => {
          const cur = readCart();
          const f = cur.find(x => x.id === p.id);
          if (f && f.quantity > 1) { f.quantity -= 1; writeCart(cur); }
          else { writeCart(cur.filter(x => x.id !== p.id)); }
          revalidateAndRenderCart();
        };
        btns[1].onclick = () => {
          const cur = readCart();
          const f = cur.find(x => x.id === p.id);
          if (f) {
            if (f.quantity >= avail) {
              warn.textContent = 'Maximum available stock (' + avail + ') reached for ' + p.title;
              return;
            }
            f.quantity += 1;
            writeCart(cur);
            revalidateAndRenderCart();
          }
        };
        btns[2].onclick = () => {
          writeCart(readCart().filter(x => x.id !== p.id));
          revalidateAndRenderCart();
        };
        container.appendChild(row);
      }
      if (warnings.length) warn.textContent = warnings.join(' ');
      subEl.textContent = fmtZar(subtotal);
      writeCart(validCleaned);
    }
    window.addToCart = async function(id) {
      const res = await fetch('/api/products/' + encodeURIComponent(id));
      if (!res.ok) return;
      const { product } = await res.json();
      const avail = product.status === 'sold' ? 0 : Number(product.quantity || 0);
      if (avail <= 0) return;
      const cart = readCart();
      const existing = cart.find(x => x.id === id);
      const warn = document.getElementById('cartWarning');
      if (existing) {
        if (existing.quantity >= avail) {
          document.getElementById('cartDrawer').hidden = false;
          await revalidateAndRenderCart();
          warn.textContent = 'Only ' + avail + ' in stock for ' + product.title;
          return;
        }
        existing.quantity += 1;
      } else {
        cart.push({ id, quantity: 1 });
      }
      writeCart(cart);
      document.getElementById('cartDrawer').hidden = false;
      await revalidateAndRenderCart();
    };
    document.addEventListener('DOMContentLoaded', () => {
      const page = document.body.dataset.page;
      document.querySelectorAll('.site-header a[data-page]').forEach(a => {
        if (a.dataset.page === page) a.setAttribute('aria-current', 'page');
      });
      updateCartBadge();
      const cartBtn = document.getElementById('cartBtn');
      const closeBtn = document.getElementById('closeCartBtn');
      const drawer = document.getElementById('cartDrawer');
      cartBtn?.addEventListener('click', async () => {
        drawer.hidden = false;
        await revalidateAndRenderCart();
      });
      closeBtn?.addEventListener('click', () => { drawer.hidden = true; });
      const menuBtn = document.getElementById('menuBtn');
      const mnav = document.getElementById('mnav');
      menuBtn?.addEventListener('click', () => {
        const open = mnav.classList.toggle('open');
        menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });
  </script>
</body>
</html>`;
}

export function createContractMockApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.RETROMOD_DATA_DIR || fs.mkdtempSync('/tmp/retromod-mock-'));
  const adminPassword = options.adminPassword || process.env.RETROMOD_ADMIN_PASSWORD || 'retromod-e2e-admin-2026';
  const allowHostsRaw = options.allowHosts ?? process.env.RETROMOD_IMPORT_ALLOW_HOSTS ?? '127.0.0.1';
  const allowHosts = new Set(
    String(allowHostsRaw)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const hmacSecret = crypto.createHash('sha256').update(adminPassword + ':retromod-session').digest('hex');

  fs.mkdirSync(dataDir, { recursive: true });
  const mediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const catalogFile = path.join(dataDir, 'catalog.json');
  const ordersFile = path.join(dataDir, 'orders.json');

  if (!fs.existsSync(catalogFile)) {
    fs.writeFileSync(catalogFile, JSON.stringify(SEED_PRODUCTS, null, 2));
  }
  if (!fs.existsSync(ordersFile)) {
    fs.writeFileSync(ordersFile, JSON.stringify([], null, 2));
  }

  const readCatalog = () => JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  const writeCatalog = (products) => {
    const tmp = `${catalogFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(products, null, 2));
    fs.renameSync(tmp, catalogFile);
  };
  const readOrders = () => JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
  const writeOrders = (orders) => {
    const tmp = `${ordersFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(orders, null, 2));
    fs.renameSync(tmp, ordersFile);
  };

  let mutex = Promise.resolve();
  const withLock = (fn) => {
    const next = mutex.then(fn, fn);
    mutex = next.catch(() => {});
    return next;
  };

  const sampleJpg = fs.readFileSync(path.join(FIXTURES_DIR, 'valid-sample.jpg'));
  const largeStockJpg = makeJpegOver10Kb(sampleJpg);

  function computeStats(products) {
    return {
      total: products.length,
      available: products.filter((p) => p.status !== 'sold' && p.quantity > 0).length,
      sold: products.filter((p) => p.status === 'sold' || p.quantity <= 0).length
    };
  }

  function signSession() {
    const payload = Buffer.from(JSON.stringify({ admin: true, iat: Date.now() })).toString('base64url');
    const sig = crypto.createHmac('sha256', hmacSecret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  function verifySession(req) {
    const cookieHeader = req.headers.cookie || '';
    const match = /(?:^|;\s*)retromod_admin=([^;]+)/.exec(cookieHeader);
    if (!match) return false;
    const token = match[1];
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', hmacSecret).update(payload).digest('base64url');
    if (sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  function sendJson(res, status, data, extraHeaders = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      ...extraHeaders
    });
    res.end(body);
  }

  function sendHtml(res, status, html) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    res.end(html);
  }

  async function readJsonBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 1024 * 1024) {
        const err = new Error('Payload too large');
        err.status = 413;
        throw err;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      const err = new Error('Invalid JSON body');
      err.status = 400;
      throw err;
    }
  }

  function validateProductPatch(body) {
    if (!body || typeof body !== 'object') return 'Invalid payload';
    if (body.price !== undefined) {
      if (typeof body.price !== 'number' || !Number.isFinite(body.price) || body.price < 0) {
        return 'Invalid price';
      }
    }
    if (body.quantity !== undefined) {
      if (!Number.isInteger(body.quantity) || body.quantity < 0) {
        return 'Invalid quantity';
      }
    }
    if (body.status !== undefined) {
      if (!['available', 'reserved', 'sold'].includes(body.status)) {
        return 'Invalid status';
      }
    }
    return null;
  }

  async function parseImportEntries(body, catalog) {
    const mode = body.mode || 'auto';
    const candidates = [];
    const seenKeys = new Set();

    const pushCandidate = (raw, idx) => {
      const tempId = `tmp-${idx + 1}`;
      const shortcode = raw.instagramShortcode || extractShortcode(raw.instagramUrl);
      const title = String(raw.title || '').trim();
      const textBlob = `${title} ${raw.lede || ''} ${raw.caption || ''}`;
      const warnings = [];
      const errors = [];

      if (raw._fetchError) {
        errors.push(raw._fetchError);
        candidates.push({
          tempId,
          action: 'invalid',
          warnings,
          errors,
          candidate: { ...raw, instagramShortcode: shortcode }
        });
        return;
      }

      if (isNonProductText(textBlob) || raw._isReel) {
        candidates.push({
          tempId,
          action: 'non_product',
          warnings: ['Non-product post / showroom notice'],
          errors: [],
          candidate: { ...raw, instagramShortcode: shortcode }
        });
        return;
      }

      const price =
        typeof raw.price === 'number'
          ? raw.price
          : parsePriceZar(raw.priceText !== undefined ? raw.priceText : textBlob, raw.priceText !== undefined);
      const quantity =
        raw.quantity !== undefined && raw.quantity !== ''
          ? Number(raw.quantity)
          : /\bsold\b/i.test(textBlob)
            ? 0
            : 1;
      const status = quantity <= 0 || /\bsold\b/i.test(textBlob) ? 'sold' : raw.status || 'available';
      const id = raw.id || slugify(title) || (shortcode ? `ig-${shortcode.toLowerCase()}` : `item-${idx + 1}`);

      if (!title) errors.push('Missing product title');
      if (price === null || !Number.isFinite(price) || price <= 0) errors.push('Missing or invalid price');
      if (!Number.isInteger(quantity) || quantity < 0) errors.push('Invalid quantity');

      const existing = catalog.find(
        (p) => (shortcode && p.instagramShortcode === shortcode) || p.id === id
      );
      const dedupKey = shortcode || id;

      let action = 'create';
      if (errors.length > 0) {
        action = 'invalid';
      } else if (seenKeys.has(dedupKey)) {
        action = 'duplicate';
        warnings.push('Duplicate item within import batch');
      } else if (existing) {
        action = 'update';
        warnings.push(`Matches existing product ${existing.id}`);
      }
      if (dedupKey) seenKeys.add(dedupKey);

      candidates.push({
        tempId,
        action,
        warnings,
        errors,
        candidate: {
          id: existing ? existing.id : id,
          title,
          maker: raw.maker || (title.split(' ')[0] || 'RETROMOD'),
          origin: raw.origin || 'Imported',
          era: raw.era || 'Vintage',
          category: raw.category || inferCategory(textBlob),
          price: price ?? 0,
          quantity: Number.isFinite(quantity) ? quantity : 1,
          status,
          lede: raw.lede || title,
          body: raw.body || [raw.caption || title],
          specs: raw.specs || [['Source', 'Instagram @retromod.za']],
          image: existing ? existing.image : raw.image || '',
          remoteImageUrl: raw.remoteImageUrl || '',
          instagramUrl: raw.instagramUrl || '',
          instagramShortcode: shortcode
        }
      });
    };

    if (mode === 'urls' || (Array.isArray(body.urls) && body.urls.length > 0)) {
      const urls = Array.isArray(body.urls) ? body.urls : String(body.payload || '').split(/\r?\n/).filter(Boolean);
      for (let i = 0; i < urls.length; i++) {
        const url = String(urls[i]).trim();
        if (isHostBlocked(url, allowHosts)) {
          pushCandidate({ instagramUrl: url, _fetchError: `Blocked unsafe or disallowed URL: ${url}` }, i);
          continue;
        }
        try {
          const resp = await fetch(url, {
            headers: { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' },
            signal: AbortSignal.timeout(4000)
          });
          if (!resp.ok) {
            pushCandidate({ instagramUrl: url, _fetchError: `HTTP ${resp.status} fetching post` }, i);
            continue;
          }
          const html = await resp.text();
          if (/Login • Instagram/i.test(html) && !/og:description/i.test(html)) {
            pushCandidate({ instagramUrl: url, _fetchError: 'Instagram login wall encountered; manual entry required' }, i);
            continue;
          }
          const meta = (prop) => {
            const r = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
            const m = r.exec(html);
            return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : '';
          };
          const ogTitle = meta('og:title');
          const ogDesc = meta('og:description') || meta('description');
          const ogImg = meta('og:image');
          const ogType = meta('og:type');
          const isReel = /\/reel\//i.test(url) || ogType === 'video';
          const cleanTitle = ogTitle
            .replace(/^@retromod\.za on Instagram:\s*"?/i, '')
            .replace(/"$/g, '')
            .split(/\s+—\s+|\.\s*R\d/i)[0]
            .trim();
          pushCandidate(
            {
              instagramUrl: url,
              title: isReel ? '' : cleanTitle,
              caption: ogDesc,
              priceText: `${ogTitle} ${ogDesc}`,
              remoteImageUrl: ogImg,
              _isReel: isReel
            },
            i
          );
        } catch (err) {
          pushCandidate({ instagramUrl: url, _fetchError: err.message }, i);
        }
      }
    } else if (mode === 'export' || (Array.isArray(body.payload) || (typeof body.payload === 'string' && body.payload.trim().startsWith('[')))) {
      let arr = [];
      try {
        arr = typeof body.payload === 'string' ? JSON.parse(body.payload) : body.payload;
      } catch {
        arr = [];
      }
      arr.forEach((entry, i) => {
        const m = entry?.media?.[0] || entry || {};
        const text = String(m.title || '');
        const urlMatch = /https?:\/\/[^\s]+/i.exec(text);
        const titlePart = text.split(/\s+—\s+/)[0]?.trim() || '';
        pushCandidate(
          {
            title: titlePart,
            caption: text,
            priceText: text,
            instagramUrl: urlMatch ? urlMatch[0] : ''
          },
          i
        );
      });
    } else if (mode === 'csv' || (typeof body.payload === 'string' && body.payload.includes('instagram_url,'))) {
      const rows = parseCsvRows(body.payload);
      rows.forEach((r, i) => {
        pushCandidate(
          {
            instagramUrl: r.instagram_url,
            title: r.title,
            maker: r.maker,
            origin: r.origin,
            era: r.era,
            category: r.category,
            priceText: r.price,
            quantity: r.quantity,
            status: r.status,
            remoteImageUrl: r.image_url,
            caption: r.caption
          },
          i
        );
      });
    } else {
      const blocks = String(body.payload || '')
        .split(/\r?\n---\r?\n/)
        .map((b) => b.trim())
        .filter(Boolean);
      blocks.forEach((block, i) => {
        const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const urlMatch = /https?:\/\/[^\s]+/i.exec(block);
        const title = (lines[0] || '').split(/\s+—\s+/)[0].trim();
        pushCandidate(
          {
            title: isNonProductText(block) ? '' : title,
            caption: block,
            priceText: block,
            instagramUrl: urlMatch ? urlMatch[0] : ''
          },
          i
        );
      });
    }

    const summary = {
      total: candidates.length,
      valid: candidates.filter((c) => c.action === 'create' || c.action === 'update').length,
      invalid: candidates.filter((c) => c.action === 'invalid').length,
      duplicates: candidates.filter((c) => c.action === 'duplicate').length,
      nonProduct: candidates.filter((c) => c.action === 'non_product').length
    };
    return { items: candidates, summary };
  }

  const server = http.createServer(async (req, res) => {
    let urlObj;
    try {
      const rawUrl = req.url || '/';
      if (/%(?![0-9A-Fa-f]{2})/.test(rawUrl)) {
        sendJson(res, 400, { error: 'Malformed URL encoding' });
        return;
      }
      decodeURIComponent(rawUrl.split('?')[0]);
      urlObj = new URL(rawUrl, 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { error: 'Malformed URL' });
      return;
    }

    const pathname = urlObj.pathname;

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname.includes('..') || pathname === '/_frame.html' || pathname === '/_frame') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // Static text metadata
    if (pathname === '/robots.txt') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
      });
      res.end('User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: /sitemap.xml\n');
      return;
    }
    if (pathname === '/sitemap.xml') {
      res.writeHead(200, {
        'Content-Type': 'application/xml; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
      });
      res.end(
        '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>/</loc></url><url><loc>/shop</loc></url><url><loc>/about</loc></url><url><loc>/contact</loc></url></urlset>'
      );
      return;
    }

    // Stock and media images
    if (pathname.startsWith('/assets/stock/')) {
      const filename = path.basename(pathname);
      if (SEED_PRODUCTS.some((p) => p.image === `assets/stock/${filename}`)) {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(largeStockJpg.length),
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(largeStockJpg);
        return;
      }
      sendJson(res, 404, { error: 'Image not found' });
      return;
    }

    if (pathname.startsWith('/media/')) {
      const filename = path.basename(pathname);
      const target = path.join(mediaDir, filename);
      if (!target.startsWith(mediaDir) || !fs.existsSync(target)) {
        sendJson(res, 404, { error: 'Media not found' });
        return;
      }
      const ext = path.extname(filename).toLowerCase();
      const ctype = ext === '.png' ? 'image/png' : 'image/jpeg';
      const buf = fs.readFileSync(target);
      res.writeHead(200, {
        'Content-Type': ctype,
        'Content-Length': String(buf.length),
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(buf);
      return;
    }

    // Public APIs
    if (pathname === '/api/health' && req.method === 'GET') {
      const catalog = readCatalog();
      sendJson(res, 200, {
        ok: true,
        status: 'ok',
        productCount: catalog.length,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (pathname === '/api/products') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      let products = readCatalog();
      const cat = urlObj.searchParams.get('category');
      const q = urlObj.searchParams.get('q');
      const status = urlObj.searchParams.get('status');
      if (cat && cat !== 'all') products = products.filter((p) => p.category === cat);
      if (status) products = products.filter((p) => p.status === status);
      if (q) {
        const needle = q.toLowerCase();
        products = products.filter(
          (p) =>
            p.title.toLowerCase().includes(needle) ||
            (p.maker || '').toLowerCase().includes(needle) ||
            (p.lede || '').toLowerCase().includes(needle)
        );
      }
      sendJson(res, 200, {
        links: { instagram: 'https://www.instagram.com/retromod.za/' },
        categories: CATEGORIES,
        stats: computeStats(readCatalog()),
        products
      });
      return;
    }

    if (pathname.startsWith('/api/products/') && req.method === 'GET') {
      const id = decodeURIComponent(pathname.slice('/api/products/'.length));
      const product = readCatalog().find((p) => p.id === id);
      if (!product) {
        sendJson(res, 404, { error: 'Product not found' });
        return;
      }
      sendJson(res, 200, { product });
      return;
    }

    if (pathname === '/api/orders' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, err.status || 400, { error: err.message });
        return;
      }

      const fields = {};
      if (!body.customer?.name?.trim()) fields.name = 'Required';
      if (!body.customer?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.customer.email)) {
        fields.email = 'Valid email required';
      }
      if (!body.customer?.phone?.trim()) fields.phone = 'Required';
      if (!['collection', 'delivery'].includes(body.fulfillment)) fields.fulfillment = 'Invalid fulfillment';
      if (body.fulfillment === 'delivery') {
        const sa = body.shippingAddress || {};
        if (!sa.street?.trim()) fields.street = 'Required';
        if (!sa.suburb?.trim()) fields.suburb = 'Required';
        if (!sa.city?.trim()) fields.city = 'Required';
        if (!sa.province?.trim()) fields.province = 'Required';
        if (!sa.postalCode?.trim()) fields.postalCode = 'Required';
      }
      if (!['eft', 'pay_on_collection', 'card_order_request'].includes(body.paymentMethod)) {
        fields.paymentMethod = 'Invalid payment method';
      }
      if (!Array.isArray(body.items) || body.items.length === 0) {
        fields.items = 'Cart cannot be empty';
      } else {
        for (const item of body.items) {
          if (!item?.id || !Number.isInteger(item.quantity) || item.quantity <= 0) {
            fields.items = 'Each item must have a valid positive integer quantity';
          }
        }
      }
      if (Object.keys(fields).length > 0) {
        sendJson(res, 400, { error: 'Validation failed', fields });
        return;
      }

      const outcome = await withLock(() => {
        const catalog = readCatalog();
        const orders = readOrders();
        const byId = new Map(catalog.map((p) => [p.id, p]));
        let subtotalZar = 0;
        const resolvedItems = [];

        for (const reqItem of body.items) {
          const prod = byId.get(reqItem.id);
          if (!prod) return { status: 404, body: { error: `Unknown product ${reqItem.id}` } };
          const avail = prod.status === 'sold' ? 0 : prod.quantity;
          if (avail < reqItem.quantity) {
            return {
              status: 409,
              body: {
                error: `Insufficient stock for ${prod.title}`,
                itemId: prod.id,
                availableQuantity: avail
              }
            };
          }
        }

        for (const reqItem of body.items) {
          const prod = byId.get(reqItem.id);
          prod.quantity -= reqItem.quantity;
          if (prod.quantity <= 0) {
            prod.quantity = 0;
            prod.status = 'sold';
          }
          prod.updatedAt = new Date().toISOString();
          subtotalZar += prod.price * reqItem.quantity;
          resolvedItems.push({
            id: prod.id,
            title: prod.title,
            priceZar: prod.price,
            quantity: reqItem.quantity
          });
        }

        const shippingZar = body.fulfillment === 'delivery' ? 250 : 0;
        const order = {
          orderRef: `RM-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`,
          accessToken: crypto.randomBytes(12).toString('hex'),
          status: 'pending',
          customer: body.customer,
          fulfillment: body.fulfillment,
          shippingAddress: body.fulfillment === 'delivery' ? body.shippingAddress : null,
          paymentMethod: body.paymentMethod,
          notes: body.notes || '',
          items: resolvedItems,
          subtotalZar,
          shippingZar,
          totalZar: subtotalZar + shippingZar,
          createdAt: new Date().toISOString()
        };
        orders.push(order);
        writeCatalog(catalog);
        writeOrders(orders);
        return { status: 201, body: { order } };
      });

      sendJson(res, outcome.status, outcome.body);
      return;
    }

    if (pathname.startsWith('/api/orders/') && req.method === 'GET') {
      const orderRef = decodeURIComponent(pathname.slice('/api/orders/'.length));
      const token = urlObj.searchParams.get('token') || '';
      const order = readOrders().find((o) => o.orderRef === orderRef);
      if (!order) {
        sendJson(res, 404, { error: 'Order not found' });
        return;
      }
      if (!token || token !== order.accessToken) {
        sendJson(res, 403, { error: 'Invalid or missing order token' });
        return;
      }
      sendJson(res, 200, { order });
      return;
    }

    // Admin auth
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, err.status || 400, { error: err.message });
        return;
      }
      if (body.password !== adminPassword) {
        sendJson(res, 401, { error: 'Invalid admin password' });
        return;
      }
      const token = signSession();
      sendJson(
        res,
        200,
        { authenticated: true },
        { 'Set-Cookie': `retromod_admin=${token}; HttpOnly; SameSite=Lax; Path=/` }
      );
      return;
    }

    if (pathname === '/api/admin/logout' && req.method === 'POST') {
      sendJson(
        res,
        200,
        { authenticated: false },
        { 'Set-Cookie': 'retromod_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' }
      );
      return;
    }

    if (pathname === '/api/admin/session' && req.method === 'GET') {
      sendJson(res, 200, { authenticated: verifySession(req) });
      return;
    }

    if (pathname.startsWith('/api/admin/')) {
      if (!verifySession(req)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      if (pathname === '/api/admin/catalog' && req.method === 'GET') {
        const products = readCatalog();
        sendJson(res, 200, { products, stats: computeStats(products) });
        return;
      }

      if (pathname.startsWith('/api/admin/products/') && req.method === 'PATCH') {
        const id = decodeURIComponent(pathname.slice('/api/admin/products/'.length));
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
          return;
        }
        const errMsg = validateProductPatch(body);
        if (errMsg) {
          sendJson(res, 400, { error: errMsg });
          return;
        }
        const outcome = await withLock(() => {
          const catalog = readCatalog();
          const prod = catalog.find((p) => p.id === id);
          if (!prod) return { status: 404, body: { error: 'Product not found' } };
          if (body.title !== undefined) prod.title = String(body.title).trim();
          if (body.price !== undefined) prod.price = body.price;
          if (body.quantity !== undefined) prod.quantity = body.quantity;
          if (body.status !== undefined) prod.status = body.status;
          if (prod.quantity <= 0) {
            prod.quantity = 0;
            prod.status = 'sold';
          } else if (body.quantity !== undefined && body.quantity > 0 && body.status === undefined && prod.status === 'sold') {
            prod.status = 'available';
          }
          prod.updatedAt = new Date().toISOString();
          writeCatalog(catalog);
          return { status: 200, body: { product: prod } };
        });
        sendJson(res, outcome.status, outcome.body);
        return;
      }

      if (pathname === '/api/admin/orders' && req.method === 'GET') {
        sendJson(res, 200, { orders: readOrders() });
        return;
      }

      if (pathname.startsWith('/api/admin/orders/') && req.method === 'PATCH') {
        const orderRef = decodeURIComponent(pathname.slice('/api/admin/orders/'.length));
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
          return;
        }
        const outcome = await withLock(() => {
          const orders = readOrders();
          const catalog = readCatalog();
          const order = orders.find((o) => o.orderRef === orderRef);
          if (!order) return { status: 404, body: { error: 'Order not found' } };
          const nextStatus = body.status;
          if (!['pending', 'confirmed', 'fulfilled', 'cancelled'].includes(nextStatus)) {
            return { status: 400, body: { error: 'Invalid order status' } };
          }
          if (nextStatus === 'cancelled' && order.status !== 'cancelled') {
            for (const item of order.items) {
              const prod = catalog.find((p) => p.id === item.id);
              if (prod) {
                prod.quantity += item.quantity;
                if (prod.quantity > 0 && prod.status === 'sold') prod.status = 'available';
                prod.updatedAt = new Date().toISOString();
              }
            }
            writeCatalog(catalog);
          }
          order.status = nextStatus;
          writeOrders(orders);
          return { status: 200, body: { order } };
        });
        sendJson(res, outcome.status, outcome.body);
        return;
      }

      if (pathname === '/api/admin/import/preview' && req.method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
          return;
        }
        const result = await parseImportEntries(body, readCatalog());
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/admin/import/commit' && req.method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
          return;
        }
        if (!body || !Array.isArray(body.items)) {
          sendJson(res, 400, { error: 'items must be an array' });
          return;
        }

        const downloadImages = body.downloadImages !== false;
        const prepared = [];
        const errors = [];
        let rejected = 0;

        for (const row of body.items) {
          const tempId = row?.tempId || 'unknown';
          const action = row?.action || 'create';
          const cand = row?.candidate || row || {};
          const id = String(cand.id || slugify(cand.title) || '').trim();

          if (action === 'invalid' || action === 'non_product' || action === 'duplicate') {
            rejected++;
            errors.push({ tempId, id, reason: `Skipped ${action}` });
            continue;
          }
          if (!id || !cand.title || typeof cand.price !== 'number' || cand.price <= 0 || !Number.isInteger(cand.quantity) || cand.quantity < 0) {
            rejected++;
            errors.push({ tempId, id, reason: 'Invalid or incomplete candidate fields' });
            continue;
          }

          let imagePath = cand.image || '';
          if (downloadImages && cand.remoteImageUrl) {
            if (isHostBlocked(cand.remoteImageUrl, allowHosts)) {
              rejected++;
              errors.push({ tempId, id, reason: 'Blocked remoteImageUrl' });
              continue;
            }
            try {
              const imgRes = await fetch(cand.remoteImageUrl, { signal: AbortSignal.timeout(4000) });
              const ctype = (imgRes.headers.get('content-type') || '').toLowerCase();
              const buf = Buffer.from(await imgRes.arrayBuffer());
              const isJpg = buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8;
              const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
              if (imgRes.status !== 200 || !ctype.startsWith('image/') || (!isJpg && !isPng)) {
                errors.push({ tempId, id, reason: 'Invalid or missing remote image' });
              } else {
                const ext = isPng ? '.png' : '.jpg';
                const fileName = `${id}${ext}`;
                fs.writeFileSync(path.join(mediaDir, fileName), buf);
                imagePath = `/media/${fileName}`;
              }
            } catch (err) {
              errors.push({ tempId, id, reason: `Image download failed: ${err.message}` });
            }
          }

          prepared.push({ tempId, action, cand, id, imagePath });
        }

        const outcome = await withLock(() => {
          const catalog = readCatalog();
          let created = 0;
          let updated = 0;
          for (const entry of prepared) {
            const existing = catalog.find(
              (p) =>
                p.id === entry.id ||
                (entry.cand.instagramShortcode && p.instagramShortcode === entry.cand.instagramShortcode)
            );
            const qty = entry.cand.quantity;
            const status = qty <= 0 ? 'sold' : entry.cand.status || 'available';
            if (existing) {
              existing.title = entry.cand.title;
              existing.price = entry.cand.price;
              existing.quantity = qty;
              existing.status = status;
              if (entry.imagePath) existing.image = entry.imagePath;
              if (entry.cand.instagramUrl) existing.instagramUrl = entry.cand.instagramUrl;
              if (entry.cand.instagramShortcode) existing.instagramShortcode = entry.cand.instagramShortcode;
              existing.updatedAt = new Date().toISOString();
              updated++;
            } else {
              catalog.push({
                id: entry.id,
                title: entry.cand.title,
                maker: entry.cand.maker || 'RETROMOD',
                origin: entry.cand.origin || 'Imported',
                era: entry.cand.era || 'Vintage',
                category: entry.cand.category || 'audio',
                price: entry.cand.price,
                quantity: qty,
                status,
                added: new Date().toISOString().slice(0, 10),
                image: entry.imagePath || `assets/stock/marantz-twenty-nine.jpg`,
                instagramUrl: entry.cand.instagramUrl || '',
                instagramShortcode: entry.cand.instagramShortcode || '',
                lede: entry.cand.lede || entry.cand.title,
                body: Array.isArray(entry.cand.body) ? entry.cand.body : [String(entry.cand.body || '')],
                specs: Array.isArray(entry.cand.specs) ? entry.cand.specs : [['Source', '@retromod.za']],
                updatedAt: new Date().toISOString()
              });
              created++;
            }
          }
          writeCatalog(catalog);
          return { created, updated, rejected, errors, products: catalog };
        });

        sendJson(res, 200, outcome);
        return;
      }

      sendJson(res, 404, { error: 'Unknown admin route' });
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Unknown API route' });
      return;
    }

    // HTML Storefront Pages (Semantic WAI-ARIA + Accessible Labels)
    if (pathname === '/' || pathname === '/index.html') {
      sendHtml(
        res,
        200,
        layoutHtml({
          title: 'Home',
          page: 'home',
          body: `
            <section id="heroFrame" aria-roledescription="carousel" aria-label="Featured pieces">
              <div id="heroSlides"></div>
              <button id="hPrev" type="button" aria-label="Previous piece">Prev</button>
              <button id="hNext" type="button" aria-label="Next piece">Next</button>
            </section>
            <h1>RETROMOD Floor</h1>
            <section id="homeGrid" class="pgrid"></section>
            <script>
              document.addEventListener('DOMContentLoaded', async () => {
                const res = await fetch('/api/products');
                const { products } = await res.json();
                const hero = document.getElementById('heroSlides');
                const grid = document.getElementById('homeGrid');
                if (products[0]) {
                  hero.innerHTML = '<div class="hslide on"><img src="/' + products[0].image.replace(/^\\//,'') + '" alt="' + esc(products[0].title) + '"></div>';
                }
                grid.innerHTML = products.map(p =>
                  '<a class="pcard" href="/product.html?id=' + encodeURIComponent(p.id) + '">' +
                    '<img src="/' + p.image.replace(/^\\//,'') + '" alt="' + esc(p.title) + '">' +
                    '<span>' + (p.status === 'sold' ? 'Sold' : 'Available') + '</span>' +
                    '<h3>' + esc(p.title) + '</h3>' +
                    '<span class="price">' + fmtZar(p.price) + '</span>' +
                  '</a>'
                ).join('');
              });
            </script>
          `
        })
      );
      return;
    }

    if (pathname === '/shop' || pathname === '/shop.html') {
      sendHtml(
        res,
        200,
        layoutHtml({
          title: 'Shop',
          page: 'shop',
          body: `
            <h1>Shop the Floor</h1>
            <div>
              <div id="chips" role="tablist" aria-label="Category">
                <button type="button" role="tab" data-cat="all" aria-selected="true">All</button>
                <button type="button" role="tab" data-cat="audio" aria-selected="false">Audio</button>
                <button type="button" role="tab" data-cat="lighting" aria-selected="false">Lighting</button>
                <button type="button" role="tab" data-cat="cameras" aria-selected="false">Cameras</button>
                <button type="button" role="tab" data-cat="furniture" aria-selected="false">Furniture</button>
              </div>
              <label for="q" class="sr-only">Search the shop</label>
              <input id="q" type="search" placeholder="Search Marantz, lamp...">
              <label for="sort" class="sr-only">Sort</label>
              <select id="sort">
                <option value="new">Newest</option>
                <option value="low">Price: low to high</option>
                <option value="high">Price: high to low</option>
              </select>
              <button id="reset" type="button">Clear filters</button>
            </div>
            <p id="countLbl"></p>
            <section id="grid" class="pgrid"></section>
            <p id="empty" hidden>Nothing matches that yet.</p>
            <script>
              document.addEventListener('DOMContentLoaded', async () => {
                const res = await fetch('/api/products');
                const { products } = await res.json();
                const params = new URLSearchParams(location.search);
                let activeCat = ['all','audio','lighting','cameras','furniture','art'].includes(params.get('cat')) ? params.get('cat') : 'all';
                const qInput = document.getElementById('q');
                const sortSel = document.getElementById('sort');
                qInput.value = params.get('q') || '';
                if (['new','low','high'].includes(params.get('sort'))) sortSel.value = params.get('sort');
                function render() {
                  const q = qInput.value.trim().toLowerCase();
                  const sort = sortSel.value;
                  document.querySelectorAll('#chips [role="tab"]').forEach(t => {
                    t.setAttribute('aria-selected', t.dataset.cat === activeCat ? 'true' : 'false');
                  });
                  let list = products.filter(p => {
                    if (activeCat !== 'all' && p.category !== activeCat) return false;
                    if (q && !p.title.toLowerCase().includes(q) && !(p.maker||'').toLowerCase().includes(q)) return false;
                    return true;
                  });
                  list.sort((a, b) => {
                    const aSold = a.status === 'sold' ? 1 : 0;
                    const bSold = b.status === 'sold' ? 1 : 0;
                    if (aSold !== bSold) return aSold - bSold;
                    if (sort === 'low') return a.price - b.price;
                    if (sort === 'high') return b.price - a.price;
                    return 0;
                  });
                  const grid = document.getElementById('grid');
                  const empty = document.getElementById('empty');
                  document.getElementById('countLbl').textContent = list.length + ' pieces';
                  if (list.length === 0) {
                    grid.innerHTML = '';
                    empty.hidden = false;
                  } else {
                    empty.hidden = true;
                    grid.innerHTML = '';
                    for (const p of list) {
                      const card = document.createElement('a');
                      card.className = 'pcard';
                      card.href = '/product.html?id=' + encodeURIComponent(p.id);
                      const img = document.createElement('img');
                      img.src = '/' + p.image.replace(/^\\//,'');
                      img.alt = p.title;
                      const badge = document.createElement('span');
                      badge.textContent = p.status === 'sold' ? 'Sold' : 'Available';
                      const h3 = document.createElement('h3');
                      h3.textContent = p.title;
                      const price = document.createElement('span');
                      price.textContent = fmtZar(p.price);
                      card.append(img, badge, h3, price);
                      grid.appendChild(card);
                    }
                  }
                  const sp = new URLSearchParams();
                  if (activeCat !== 'all') sp.set('cat', activeCat);
                  if (qInput.value.trim()) sp.set('q', qInput.value.trim());
                  if (sortSel.value !== 'new') sp.set('sort', sortSel.value);
                  const qs = sp.toString();
                  history.replaceState(null, '', qs ? ('?' + qs) : location.pathname);
                }
                document.querySelectorAll('#chips [role="tab"]').forEach(btn => {
                  btn.addEventListener('click', () => { activeCat = btn.dataset.cat; render(); });
                });
                qInput.addEventListener('input', render);
                sortSel.addEventListener('change', render);
                document.getElementById('reset').addEventListener('click', () => {
                  activeCat = 'all'; qInput.value = ''; sortSel.value = 'new'; render();
                });
                render();
              });
            </script>
          `
        })
      );
      return;
    }

    if (pathname === '/product' || pathname === '/product.html') {
      sendHtml(
        res,
        200,
        layoutHtml({
          title: 'Product',
          page: 'shop',
          body: `
            <div id="productMount"></div>
            <script>
              document.addEventListener('DOMContentLoaded', async () => {
                const id = new URLSearchParams(location.search).get('id') || '';
                const mount = document.getElementById('productMount');
                const res = await fetch('/api/products/' + encodeURIComponent(id));
                if (!res.ok) {
                  mount.innerHTML = '<section><h1>This piece has moved on.</h1><a href="/shop">Back to the shop</a></section>';
                  return;
                }
                const { product: p } = await res.json();
                const isSold = p.status === 'sold' || p.quantity <= 0;
                const specsHtml = (p.specs || []).map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('');
                mount.innerHTML =
                  '<article>' +
                    '<div id="pdImg" role="button" aria-label="Zoom photo"><img src="/' + p.image.replace(/^\\//,'') + '" alt="' + esc(p.title) + '"></div>' +
                    '<p><strong>' + (isSold ? 'Sold' : 'Available') + '</strong> (' + p.quantity + ' in stock)</p>' +
                    '<h1>' + esc(p.title) + '</h1>' +
                    '<p class="pd-price">' + fmtZar(p.price) + '</p>' +
                    '<p>' + esc(p.lede || '') + '</p>' +
                    '<div>' +
                      (isSold
                        ? '<button type="button" disabled>Sold</button>'
                        : '<button id="addCartBtn" type="button">Add to Cart</button>') +
                      ' <button type="button" data-enquire>' + (isSold ? 'Find me something similar' : 'DM to buy') + '</button>' +
                      ' <button id="shareBtn" type="button">Copy link</button>' +
                    '</div>' +
                    '<dl>' + specsHtml + '</dl>' +
                  '</article>';
                document.getElementById('addCartBtn')?.addEventListener('click', () => window.addToCart(p.id));
              });
            </script>
          `
        })
      );
      return;
    }

    if (pathname === '/about' || pathname === '/about.html') {
      sendHtml(
        res,
        200,
        layoutHtml({
          title: 'About',
          page: 'about',
          body: `
            <h1>About RETROMOD</h1>
            <p>Showroom at 66 Grant Ave, Norwood. Live pieces: <b id="aboutCount">0</b></p>
            <img src="/assets/stock/kartell-taj-lamp.jpg" alt="Norwood showroom piece">
            <script>
              document.addEventListener('DOMContentLoaded', async () => {
                const res = await fetch('/api/products');
                const { stats } = await res.json();
                document.getElementById('aboutCount').textContent = String(stats.total);
              });
            </script>
          `
        })
      );
      return;
    }

    if (pathname === '/contact' || pathname === '/contact.html') {
      sendHtml(
        res,
        200,
        layoutHtml({
          title: 'Contact',
          page: 'contact',
          body: `
            <h1>Contact RETROMOD</h1>
            <div role="group" aria-label="What is this about?">
              <button type="button" data-intent="buy" aria-pressed="true">Buying a piece</button>
              <button type="button" data-intent="sell" aria-pressed="false">Selling a piece</button>
              <button type="button" data-intent="source" aria-pressed="false">Sourcing request</button>
              <button type="button" data-intent="other" aria-pressed="false">Something else</button>
            </div>
            <form id="contactForm" novalidate>
              <label for="fName">Your name</label><input id="fName" type="text">
              <label for="fCity">City / suburb</label><input id="fCity" type="text">
              <div id="pieceWrap"><label for="fPiece">Which piece?</label><input id="fPiece" type="text"></div>
              <label for="fMsg">Message</label><textarea id="fMsg"></textarea>
              <p id="fErr" role="alert" aria-live="polite"></p>
              <p id="preview"></p>
              <button type="submit">Copy &amp; open DM</button>
            </form>
            <script>
              document.addEventListener('DOMContentLoaded', () => {
                let intent = 'buy';
                const btns = document.querySelectorAll('[data-intent]');
                const msg = document.getElementById('fMsg');
                const err = document.getElementById('fErr');
                const preview = document.getElementById('preview');
                const pieceWrap = document.getElementById('pieceWrap');
                const updatePreview = () => {
                  preview.textContent = '[' + intent.toUpperCase() + '] ' + (document.getElementById('fName').value || 'Collector') + ': ' + msg.value;
                };
                btns.forEach(b => b.addEventListener('click', () => {
                  intent = b.dataset.intent;
                  btns.forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
                  pieceWrap.hidden = intent !== 'buy';
                  updatePreview();
                }));
                msg.addEventListener('input', updatePreview);
                document.getElementById('contactForm').addEventListener('submit', (e) => {
                  e.preventDefault();
                  err.textContent = '';
                  msg.removeAttribute('aria-invalid');
                  if (intent !== 'buy' && !msg.value.trim()) {
                    msg.setAttribute('aria-invalid', 'true');
                    err.textContent = 'Please tell us what you have or are looking for.';
                    return;
                  }
                  preview.dataset.sent = '1';
                });
              });
            </script>
          `
        })
      );
      return;
    }

    if (pathname === '/checkout' || pathname === '/checkout.html') {
      sendHtml(
        res,
        200,
        layoutHtml({
          title: 'Checkout',
          page: 'checkout',
          body: `
            <h1>Checkout</h1>
            <div id="checkoutSummary"></div>
            <p id="checkoutErr" role="alert"></p>
            <form id="checkoutForm" novalidate>
              <div><label for="cName">Full name</label><input id="cName" type="text"></div>
              <div><label for="cEmail">Email</label><input id="cEmail" type="email"></div>
              <div><label for="cPhone">Phone</label><input id="cPhone" type="tel"></div>
              <fieldset>
                <legend>Fulfillment</legend>
                <label><input type="radio" name="fulfillment" value="collection" checked> Norwood Collection (66 Grant Ave)</label>
                <label><input type="radio" name="fulfillment" value="delivery"> SA Courier Delivery</label>
              </fieldset>
              <div id="addrFields" hidden>
                <div><label for="aStreet">Street address</label><input id="aStreet" type="text"></div>
                <div><label for="aSuburb">Suburb</label><input id="aSuburb" type="text"></div>
                <div><label for="aCity">City</label><input id="aCity" type="text"></div>
                <div><label for="aProvince">Province</label><input id="aProvince" type="text"></div>
                <div><label for="aPostal">Postal code</label><input id="aPostal" type="text"></div>
              </div>
              <fieldset>
                <legend>Payment</legend>
                <label><input type="radio" name="paymentMethod" value="eft" checked> EFT Bank Transfer</label>
                <label><input type="radio" name="paymentMethod" value="pay_on_collection"> Pay on Collection</label>
              </fieldset>
              <button id="placeOrderBtn" type="submit">Place Order</button>
            </form>
            <section id="receipt" hidden></section>
            <script>
              document.addEventListener('DOMContentLoaded', async () => {
                const items = readCart();
                const summary = document.getElementById('checkoutSummary');
                const errEl = document.getElementById('checkoutErr');
                const addrWrap = document.getElementById('addrFields');
                const res = await fetch('/api/products');
                const { products } = await res.json();
                const byId = new Map(products.map(p => [p.id, p]));
                let sub = 0;
                const lines = [];
                for (const item of items) {
                  const p = byId.get(item.id);
                  if (!p) continue;
                  sub += p.price * item.quantity;
                  lines.push('<li>' + esc(p.title) + ' x ' + item.quantity + ' (' + fmtZar(p.price * item.quantity) + ')' +
                    (p.status === 'sold' ? ' — SOLD OUT' : '') + '</li>');
                }
                summary.innerHTML = items.length ? ('<ul>' + lines.join('') + '</ul><p>Subtotal: ' + fmtZar(sub) + '</p>') : '<p>Cart is empty.</p>';
                document.querySelectorAll('input[name="fulfillment"]').forEach(r => {
                  r.addEventListener('change', () => {
                    addrWrap.hidden = document.querySelector('input[name="fulfillment"]:checked').value !== 'delivery';
                  });
                });
                document.getElementById('checkoutForm').addEventListener('submit', async (e) => {
                  e.preventDefault();
                  errEl.textContent = '';
                  const fulfillment = document.querySelector('input[name="fulfillment"]:checked').value;
                  const paymentMethod = document.querySelector('input[name="paymentMethod"]:checked').value;
                  const payload = {
                    customer: {
                      name: document.getElementById('cName').value.trim(),
                      email: document.getElementById('cEmail').value.trim(),
                      phone: document.getElementById('cPhone').value.trim()
                    },
                    fulfillment,
                    paymentMethod,
                    items: readCart()
                  };
                  if (fulfillment === 'delivery') {
                    payload.shippingAddress = {
                      street: document.getElementById('aStreet').value.trim(),
                      suburb: document.getElementById('aSuburb').value.trim(),
                      city: document.getElementById('aCity').value.trim(),
                      province: document.getElementById('aProvince').value.trim(),
                      postalCode: document.getElementById('aPostal').value.trim()
                    };
                  }
                  const resp = await fetch('/api/orders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                  });
                  const data = await resp.json();
                  if (!resp.ok) {
                    errEl.textContent = data.error || 'Order failed';
                    return;
                  }
                  localStorage.removeItem(window.RM_CART_KEY);
                  updateCartBadge();
                  document.getElementById('checkoutForm').hidden = true;
                  const rec = document.getElementById('receipt');
                  rec.hidden = false;
                  rec.innerHTML = '<h2>Order Confirmed</h2><p>Reference: <strong>' + esc(data.order.orderRef) + '</strong></p><p>Total: ' + fmtZar(data.order.totalZar) + '</p>';
                });
              });
            </script>
          `
        })
      );
      return;
    }

    if (pathname === '/admin' || pathname === '/admin.html') {
      sendHtml(
        res,
        200,
        layoutHtml({
          title: 'Admin',
          page: 'admin',
          body: `
            <h1>RETROMOD Admin</h1>
            <form id="loginForm">
              <label for="adminPass">Password</label>
              <input id="adminPass" type="password">
              <button type="submit">Log in</button>
              <p id="loginErr" role="alert"></p>
            </form>
            <div id="adminConsole" hidden>
              <button id="logoutBtn" type="button">Log out</button>
              <section>
                <h2>Inventory</h2>
                <div id="invList"></div>
              </section>
              <section>
                <h2>Orders</h2>
                <div id="ordList"></div>
              </section>
              <section>
                <h2>Instagram Stock Import</h2>
                <label for="impMode">Mode</label>
                <select id="impMode">
                  <option value="auto">Auto</option>
                  <option value="urls">URLs</option>
                  <option value="export">Export JSON</option>
                  <option value="csv">CSV</option>
                  <option value="caption">Caption</option>
                </select>
                <label for="impInput">Import Payload / URLs</label>
                <textarea id="impInput" rows="5" cols="60"></textarea>
                <button id="previewBtn" type="button">Preview</button>
                <div id="previewSummary"></div>
                <div id="previewRows"></div>
                <button id="commitBtn" type="button" hidden>Commit</button>
                <p id="commitResult" role="status"></p>
              </section>
            </div>
            <script>
              document.addEventListener('DOMContentLoaded', async () => {
                const loginForm = document.getElementById('loginForm');
                const consoleEl = document.getElementById('adminConsole');
                let lastPreviewItems = [];
                async function loadConsole() {
                  const [catRes, ordRes] = await Promise.all([fetch('/api/admin/catalog'), fetch('/api/admin/orders')]);
                  if (!catRes.ok) return;
                  const { products } = await catRes.json();
                  const { orders } = await ordRes.json();
                  const inv = document.getElementById('invList');
                  inv.innerHTML = '';
                  for (const p of products) {
                    const row = document.createElement('div');
                    row.dataset.productId = p.id;
                    row.innerHTML = '<strong>' + esc(p.title) + '</strong> (' + esc(p.id) + ') ' +
                      '<label>Price <input type="number" data-field="price" value="' + p.price + '"></label> ' +
                      '<label>Quantity <input type="number" data-field="quantity" value="' + p.quantity + '"></label> ' +
                      '<label>Status <select data-field="status">' +
                        '<option value="available"' + (p.status==='available'?' selected':'') + '>available</option>' +
                        '<option value="reserved"' + (p.status==='reserved'?' selected':'') + '>reserved</option>' +
                        '<option value="sold"' + (p.status==='sold'?' selected':'') + '>sold</option>' +
                      '</select></label> ' +
                      '<button type="button">Save</button>';
                    row.querySelector('button').onclick = async () => {
                      await fetch('/api/admin/products/' + encodeURIComponent(p.id), {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          price: Number(row.querySelector('[data-field="price"]').value),
                          quantity: Number(row.querySelector('[data-field="quantity"]').value),
                          status: row.querySelector('[data-field="status"]').value
                        })
                      });
                      await loadConsole();
                    };
                    inv.appendChild(row);
                  }
                  const ord = document.getElementById('ordList');
                  ord.innerHTML = '';
                  for (const o of orders) {
                    const row = document.createElement('div');
                    row.dataset.orderRef = o.orderRef;
                    row.innerHTML = '<span>' + esc(o.orderRef) + ' (' + esc(o.status) + ') — ' + fmtZar(o.totalZar) + '</span> ' +
                      '<select data-field="orderStatus">' +
                        '<option value="pending"' + (o.status==='pending'?' selected':'') + '>pending</option>' +
                        '<option value="confirmed"' + (o.status==='confirmed'?' selected':'') + '>confirmed</option>' +
                        '<option value="fulfilled"' + (o.status==='fulfilled'?' selected':'') + '>fulfilled</option>' +
                        '<option value="cancelled"' + (o.status==='cancelled'?' selected':'') + '>cancelled</option>' +
                      '</select> ' +
                      '<button type="button">Update Order</button>';
                    row.querySelector('button').onclick = async () => {
                      await fetch('/api/admin/orders/' + encodeURIComponent(o.orderRef), {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: row.querySelector('[data-field="orderStatus"]').value })
                      });
                      await loadConsole();
                    };
                    ord.appendChild(row);
                  }
                }
                const ses = await (await fetch('/api/admin/session')).json();
                if (ses.authenticated) {
                  loginForm.hidden = true;
                  consoleEl.hidden = false;
                  await loadConsole();
                }
                loginForm.addEventListener('submit', async (e) => {
                  e.preventDefault();
                  const r = await fetch('/api/admin/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: document.getElementById('adminPass').value })
                  });
                  if (!r.ok) {
                    document.getElementById('loginErr').textContent = 'Invalid password';
                    return;
                  }
                  loginForm.hidden = true;
                  consoleEl.hidden = false;
                  await loadConsole();
                });
                document.getElementById('logoutBtn').addEventListener('click', async () => {
                  await fetch('/api/admin/logout', { method: 'POST' });
                  consoleEl.hidden = true;
                  loginForm.hidden = false;
                });
                document.getElementById('previewBtn').addEventListener('click', async () => {
                  const mode = document.getElementById('impMode').value;
                  const payload = document.getElementById('impInput').value;
                  const body = mode === 'urls' ? { mode, urls: payload.split(/\\r?\\n/).map(s=>s.trim()).filter(Boolean) } : { mode, payload };
                  const r = await fetch('/api/admin/import/preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                  });
                  const data = await r.json();
                  lastPreviewItems = data.items || [];
                  document.getElementById('previewSummary').textContent =
                    'Total: ' + data.summary.total + ', Valid: ' + data.summary.valid + ', Invalid: ' + data.summary.invalid;
                  const rowsEl = document.getElementById('previewRows');
                  rowsEl.innerHTML = '';
                  lastPreviewItems.forEach((item, idx) => {
                    const div = document.createElement('div');
                    div.dataset.previewRow = String(idx);
                    div.innerHTML = '<span>[' + esc(item.action) + ']</span> ' +
                      '<label>Title <input type="text" data-pfield="title" value="' + esc(item.candidate?.title || '') + '"></label> ' +
                      '<label>Price <input type="number" data-pfield="price" value="' + Number(item.candidate?.price || 0) + '"></label>';
                    div.querySelector('[data-pfield="title"]').oninput = (ev) => { item.candidate.title = ev.target.value; };
                    div.querySelector('[data-pfield="price"]').oninput = (ev) => { item.candidate.price = Number(ev.target.value); };
                    rowsEl.appendChild(div);
                  });
                  document.getElementById('commitBtn').hidden = lastPreviewItems.length === 0;
                });
                document.getElementById('commitBtn').addEventListener('click', async () => {
                  const r = await fetch('/api/admin/import/commit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: lastPreviewItems, downloadImages: true })
                  });
                  const data = await r.json();
                  document.getElementById('commitResult').textContent =
                    'Created: ' + data.created + ', Updated: ' + data.updated + ', Rejected: ' + data.rejected;
                  await loadConsole();
                });
              });
            </script>
          `
        })
      );
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  return server;
}

export async function startContractMockServer(options = {}) {
  const port = options.port ?? 0;
  const server = createContractMockApp(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    port: boundPort,
    baseUrl: `http://127.0.0.1:${boundPort}`,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

// Allow spawning directly as a child process via helpers/server.mjs during --self-check
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 0;
  const server = createContractMockApp({});
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    console.log(`RETROMOD contract mock listening on http://127.0.0.1:${addr.port}`);
  });
}
