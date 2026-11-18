'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { HttpError } = require('./http');

const VALID_CATEGORIES = new Set(['audio', 'lighting', 'cameras', 'furniture', 'art']);
const VALID_STATUSES = new Set(['available', 'reserved', 'sold']);
const INSTAGRAM_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'instagr.am',
  'www.instagr.am'
]);

const GOOGLEBOT_UA = 'Googlebot/2.1 (+http://www.google.com/bot.html)';
const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SAFE_LOCAL_IMAGE_RE = /^(?:$|assets\/stock\/[a-z0-9._-]+\.(?:jpg|jpeg|png|webp|gif|avif)|\/media\/[a-z0-9._-]+\.(?:jpg|jpeg|png|webp|gif))$/i;
const IG_POST_PATH_RE = /^\/(?:[A-Za-z0-9._-]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{3,40})(?:\/|$)/i;

const KNOWN_MAKERS = [
  'Bang & Olufsen',
  'Boston Acoustics',
  'Herman Miller',
  'Louis Poulsen',
  'G Plan',
  'Marantz',
  'Pioneer',
  'NAD',
  'Sansui',
  'Technics',
  'Yamaha',
  'Sony',
  'Kenwood',
  'Rotel',
  'Luxman',
  'Revox',
  'JBL',
  'KEF',
  'B&W',
  'Kartell',
  'Artemide',
  'Flos',
  'Fujifilm',
  'Leica',
  'Nikon',
  'Canon',
  'Olympus',
  'Hasselblad',
  'Pentax',
  'Rollei',
  'Cassina',
  'Knoll',
  'Vitra',
  'Frystark',
  'Thonet'
];

const PRESERVED_UPPER = new Set([
  'USA', 'UK', 'SA', 'ZAR', 'NAD', 'JBL', 'KEF', 'LED', 'PMMA', 'RMS',
  'HI-FI', 'HIFI', 'SLR', 'DSLR', 'CD', 'FM', 'AM', 'DVD', 'X100V', 'II', 'III', 'IV'
]);

const LOWER_JOINERS = new Set(['in', 'on', 'at', 'by', 'of', 'the', 'and', 'for', 'with', 'to', 'from', 'a', 'an']);

function getAllowHosts() {
  const raw = process.env.RETROMOD_IMPORT_ALLOW_HOSTS;
  if (typeof raw !== 'string' || !raw.trim()) {
    return new Set();
  }
  return new Set(
    raw
      .split(',')
      .map(s => s.trim().toLowerCase().replace(/^\[|\]$/g, ''))
      .filter(Boolean)
  );
}

function isBlockedIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return true;
  const nums = parts.map(p => Number(p));
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = nums;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
  return false;
}

function expandIpv6(rawIp) {
  const noZone = String(rawIp || '').split('%')[0].toLowerCase();
  if (!noZone) return null;

  let working = noZone;
  // Convert trailing dotted IPv4 segment (e.g. ::ffff:127.0.0.1) into two hex groups
  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const v4Part = working.slice(lastColon + 1);
    const v4Octets = v4Part.split('.').map(n => Number(n));
    if (
      v4Octets.length !== 4 ||
      v4Octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      return null;
    }
    const gHigh = ((v4Octets[0] << 8) | v4Octets[1]).toString(16);
    const gLow = ((v4Octets[2] << 8) | v4Octets[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${gHigh}:${gLow}`;
  }

  const dbl = working.indexOf('::');
  if (dbl !== -1) {
    if (working.indexOf('::', dbl + 2) !== -1) return null;
    const left = working.slice(0, dbl) ? working.slice(0, dbl).split(':') : [];
    const right = working.slice(dbl + 2) ? working.slice(dbl + 2).split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    const groups = [...left, ...Array(missing).fill('0'), ...right];
    if (groups.length !== 8) return null;
    return groups.map(g => parseInt(g, 16));
  }

  const groups = working.split(':');
  if (groups.length !== 8) return null;
  return groups.map(g => parseInt(g, 16));
}

function isBlockedIpv6(ip) {
  const groups = expandIpv6(ip);
  if (!groups || groups.some(g => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return true;
  }

  const allZero = groups.every(g => g === 0);
  if (allZero) return true; // ::/128

  const isLoopback = groups.slice(0, 7).every(g => g === 0) && groups[7] === 1;
  if (isLoopback) return true; // ::1/128

  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // ::ffff:0:0/96 IPv4-mapped or ::/96 IPv4-compatible or 64:ff9b::/96 NAT64
  const isV4Mapped = groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff;
  const isV4Compat = groups.slice(0, 6).every(g => g === 0);
  const isNat64 = groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every(g => g === 0);
  if (isV4Mapped || isV4Compat || isNat64) {
    const a = (groups[6] >> 8) & 0xff;
    const b = groups[6] & 0xff;
    const c = (groups[7] >> 8) & 0xff;
    const d = groups[7] & 0xff;
    return isBlockedIpv4(`${a}.${b}.${c}.${d}`);
  }

  return false;
}

function isBlockedIp(ip) {
  const clean = String(ip || '').split('%')[0].trim();
  const kind = net.isIP(clean);
  if (kind === 4) return isBlockedIpv4(clean);
  if (kind === 6) return isBlockedIpv6(clean);
  return true;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata' ||
    host === 'metadata.google.internal' ||
    host === '0.0.0.0'
  ) {
    return true;
  }
  return false;
}

class SsrfBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfBlockedError';
    this.code = 'SSRF_BLOCKED';
  }
}

async function assertSafeUrl(urlStr, options = {}) {
  const allowHosts = options.allowHosts instanceof Set ? options.allowHosts : getAllowHosts();
  const lookupFn = typeof options.lookup === 'function' ? options.lookup : dns.promises.lookup;

  let parsed;
  try {
    parsed = new URL(String(urlStr || '').trim());
  } catch {
    throw new SsrfBlockedError('Invalid URL format');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(`Blocked URL scheme: ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError('URL credentials are not allowed');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) {
    throw new SsrfBlockedError('Missing URL hostname');
  }

  const isAllowlisted = allowHosts.has(hostname);

  if (options.requireInstagramHost && !INSTAGRAM_HOSTS.has(hostname) && !isAllowlisted) {
    throw new SsrfBlockedError(`Unsupported Instagram host: ${hostname}`);
  }

  if (!isAllowlisted) {
    if (isBlockedHostname(hostname)) {
      throw new SsrfBlockedError(`Blocked private or internal hostname: ${hostname}`);
    }

    const ipType = net.isIP(hostname);
    if (ipType) {
      if (isBlockedIp(hostname)) {
        throw new SsrfBlockedError(`Blocked private or reserved IP: ${hostname}`);
      }
      return {
        url: parsed,
        hostname,
        isAllowlisted,
        resolvedRecords: [{ address: hostname, family: ipType }]
      };
    }

    let records;
    try {
      records = await lookupFn(hostname, { all: true });
    } catch {
      throw new SsrfBlockedError(`Failed to resolve host: ${hostname}`);
    }

    if (!Array.isArray(records) || records.length === 0) {
      throw new SsrfBlockedError(`No DNS records found for host: ${hostname}`);
    }

    for (const rec of records) {
      if (!rec || !rec.address || isBlockedIp(rec.address)) {
        throw new SsrfBlockedError(`Blocked private/reserved DNS target for ${hostname}`);
      }
    }

    return {
      url: parsed,
      hostname,
      isAllowlisted,
      resolvedRecords: records.map(r => ({
        address: r.address,
        family: r.family || (net.isIP(r.address) || 4)
      }))
    };
  }

  // Allowlisted host (e.g. 127.0.0.1 in offline tests)
  const ipType = net.isIP(hostname);
  if (ipType) {
    return {
      url: parsed,
      hostname,
      isAllowlisted: true,
      resolvedRecords: [{ address: hostname, family: ipType }]
    };
  }

  return {
    url: parsed,
    hostname,
    isAllowlisted: true,
    resolvedRecords: null
  };
}

function makePinnedLookup(resolvedRecords) {
  if (!Array.isArray(resolvedRecords) || resolvedRecords.length === 0) {
    return undefined;
  }
  return function pinnedLookup(_hostname, opts, cb) {
    let callback = cb;
    let options = opts;
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (options && options.all) {
      callback(null, resolvedRecords);
      return;
    }
    const family = options && options.family ? Number(options.family) : 0;
    const match = family
      ? resolvedRecords.find(r => r.family === family) || resolvedRecords[0]
      : resolvedRecords[0];
    callback(null, match.address, match.family);
  };
}

function requestOnce(urlObj, { headers, timeoutMs, maxBytes, resolvedRecords }) {
  return new Promise((resolve, reject) => {
    const client = urlObj.protocol === 'https:' ? https : http;
    const pinnedLookup = makePinnedLookup(resolvedRecords);
    const reqOpts = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname.replace(/^\[|\]$/g, ''),
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: `${urlObj.pathname}${urlObj.search}`,
      method: 'GET',
      headers,
      timeout: timeoutMs
    };
    if (pinnedLookup) {
      reqOpts.lookup = pinnedLookup;
    }

    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = client.request(reqOpts, res => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (!settled) {
          settled = true;
          resolve({
            status,
            headers: res.headers,
            location: res.headers.location,
            body: Buffer.alloc(0)
          });
        }
        return;
      }

      const chunks = [];
      let total = 0;

      res.on('data', chunk => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          fail(new Error(`Response exceeded maxBytes (${maxBytes})`));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          status,
          headers: res.headers,
          location: null,
          body: Buffer.concat(chunks)
        });
      });

      res.on('error', err => fail(err));
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on('error', err => fail(err));
    req.end();
  });
}

async function safeFetch(urlStr, options = {}) {
  const maxBytes = options.maxBytes || 4 * 1024 * 1024;
  const timeoutMs = options.timeoutMs || 10000;
  const maxRedirects = options.maxRedirects !== undefined ? options.maxRedirects : 5;
  const allowHosts = options.allowHosts instanceof Set ? options.allowHosts : getAllowHosts();
  const headers = {
    'User-Agent': GOOGLEBOT_UA,
    'Accept-Language': 'en-US,en;q=0.9',
    ...(options.headers || {})
  };

  let currentUrl = String(urlStr || '').trim();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const checked = await assertSafeUrl(currentUrl, {
      allowHosts,
      lookup: options.lookup,
      requireInstagramHost: hop === 0 && Boolean(options.requireInstagramHost)
    });

    const resp = await requestOnce(checked.url, {
      headers,
      timeoutMs,
      maxBytes,
      resolvedRecords: checked.resolvedRecords
    });

    if (resp.location) {
      if (hop >= maxRedirects) {
        throw new Error('Too many redirects');
      }
      currentUrl = new URL(resp.location, checked.url).toString();
      continue;
    }

    return {
      status: resp.status,
      headers: resp.headers,
      body: resp.body,
      finalUrl: checked.url.toString()
    };
  }

  throw new Error('Too many redirects');
}

function detectImageFormat(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 6) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpg';
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  const head6 = buf.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return 'gif';
  }
  return null;
}

function decodeDataUriImage(dataUri, maxBytes = 5 * 1024 * 1024) {
  const m = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUri || '').trim());
  if (!m) {
    throw new Error('Unsupported or unsafe image data URI (raster JPEG, PNG, WEBP, GIF only)');
  }
  const rawB64 = m[2].replace(/\s+/g, '');
  const buf = Buffer.from(rawB64, 'base64');
  if (!buf.length) {
    throw new Error('Empty image upload');
  }
  if (buf.length > maxBytes) {
    throw new Error(`Uploaded image exceeds ${Math.round(maxBytes / (1024 * 1024))} MB limit`);
  }
  const ext = detectImageFormat(buf);
  if (!ext) {
    throw new Error('Uploaded image bytes do not match a valid raster image (JPEG, PNG, WEBP, or GIF)');
  }
  return { buffer: buf, ext };
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/gi, '&');
}

function fixMetaMojibake(str) {
  const input = String(str || '');
  if (!/[\u00c2-\u00f4][\u0080-\u00bf]/.test(input)) {
    return input;
  }
  try {
    const bytes = [];
    for (let i = 0; i < input.length; i++) {
      const code = input.charCodeAt(i);
      if (code > 0xff) return input;
      bytes.push(code);
    }
    const decoded = Buffer.from(bytes).toString('utf8');
    if (!decoded.includes('\ufffd')) {
      return decoded;
    }
  } catch {
    // ignore
  }
  return input;
}

function extractMetaTags(html) {
  const tags = {};
  const metaRe = /<meta\b([^>]+)>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const attrs = {};
    const attrRe = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let a;
    while ((a = attrRe.exec(m[1])) !== null) {
      const k = a[1].toLowerCase();
      const v = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : a[4]);
      attrs[k] = decodeHtmlEntities(v || '');
    }
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content !== undefined && !tags[key]) {
      tags[key] = attrs.content;
    }
  }
  return tags;
}

function findMediaNodeInJson(root, targetShortcode) {
  const stack = [root];
  const visited = new Set();
  let fallbackCandidate = null;

  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (visited.has(cur)) continue;
    visited.add(cur);

    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) {
        stack.push(cur[i]);
      }
      continue;
    }

    const code = typeof cur.code === 'string'
      ? cur.code
      : (typeof cur.shortcode === 'string' ? cur.shortcode : '');
    const hasMedia =
      cur.__isXIGPolarisMedia !== undefined ||
      cur.image_versions2 !== undefined ||
      cur.display_uri !== undefined ||
      cur.display_url !== undefined ||
      cur.carousel_media !== undefined ||
      cur.edge_media_to_caption !== undefined;

    if (hasMedia && (cur.caption !== undefined || cur.edge_media_to_caption !== undefined)) {
      if (targetShortcode && code === targetShortcode) {
        return cur;
      }
      if (!fallbackCandidate) {
        fallbackCandidate = cur;
      }
    }

    if (cur.graphql && cur.graphql.shortcode_media) {
      stack.push(cur.graphql.shortcode_media);
    }

    for (const key of Object.keys(cur)) {
      const val = cur[key];
      if (val && typeof val === 'object') {
        stack.push(val);
      }
    }
  }

  return fallbackCandidate;
}

function pickCandidateImageUrl(node) {
  if (!node || typeof node !== 'object') return '';
  if (Array.isArray(node.carousel_media) && node.carousel_media.length > 0) {
    const first = node.carousel_media[0];
    const cands = first && first.image_versions2 && Array.isArray(first.image_versions2.candidates)
      ? first.image_versions2.candidates
      : [];
    if (cands.length > 0 && cands[0].url) return String(cands[0].url);
    if (first && (first.display_uri || first.display_url)) {
      return String(first.display_uri || first.display_url);
    }
  }
  const cands = node.image_versions2 && Array.isArray(node.image_versions2.candidates)
    ? node.image_versions2.candidates
    : [];
  if (cands.length > 0 && cands[0].url) return String(cands[0].url);
  if (node.display_uri) return String(node.display_uri);
  if (node.display_url) return String(node.display_url);
  return '';
}

function parseOgCaptionWrapper(raw) {
  const text = String(raw || '').trim();
  if (!text) return { caption: '', added: '' };

  // Pattern: `34 likes, 1 comments - retromod.za on November 11, 2026: "CAPTION"`
  const descMatch = /^(?:[\d,.]+\s+likes?(?:,\s*[\d,.]+\s+comments?)?\s*[-–—]\s*)?[^\s:]+(?:\s+on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4}))?:\s*"([\s\S]*)"\.?\s*$/i.exec(text);
  if (descMatch) {
    let added = '';
    if (descMatch[1]) {
      const d = new Date(descMatch[1] + ' UTC');
      if (!Number.isNaN(d.getTime())) {
        added = d.toISOString().slice(0, 10);
      }
    }
    return { caption: descMatch[2].trim(), added };
  }

  // Pattern: `RETROMOD. on Instagram: "CAPTION"`
  const titleMatch = /^.+?\s+on\s+Instagram:\s*"([\s\S]*)"\s*$/i.exec(text);
  if (titleMatch) {
    return { caption: titleMatch[1].trim(), added: '' };
  }

  return { caption: text, added: '' };
}

function extractInstagramPostFromHtml(html, shortcode, finalUrl = '') {
  const source = String(html || '');
  let caption = '';
  let remoteImageUrl = '';
  let added = '';
  let productType = '';
  let canonicalUrl = '';

  const scriptRe = /<script\b[^>]*type\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(source)) !== null) {
    const rawJson = sm[1] && sm[1].trim();
    if (!rawJson) continue;
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      continue;
    }
    const node = findMediaNodeInJson(parsed, shortcode);
    if (node) {
      if (typeof node.caption === 'string') {
        caption = node.caption;
      } else if (node.caption && typeof node.caption.text === 'string') {
        caption = node.caption.text;
      } else if (
        node.edge_media_to_caption &&
        Array.isArray(node.edge_media_to_caption.edges) &&
        node.edge_media_to_caption.edges[0] &&
        node.edge_media_to_caption.edges[0].node &&
        typeof node.edge_media_to_caption.edges[0].node.text === 'string'
      ) {
        caption = node.edge_media_to_caption.edges[0].node.text;
      }

      remoteImageUrl = pickCandidateImageUrl(node) || remoteImageUrl;
      const ts = Number(node.taken_at || node.taken_at_timestamp);
      if (Number.isFinite(ts) && ts > 0) {
        added = new Date(ts * 1000).toISOString().slice(0, 10);
      }
      if (typeof node.product_type === 'string') {
        productType = node.product_type.toLowerCase();
      } else if (node.media_type === 2 || node.is_video) {
        productType = 'clips';
      }
      if (caption || remoteImageUrl) break;
    }
  }

  const meta = extractMetaTags(source);
  if (!caption) {
    const fromDesc = parseOgCaptionWrapper(meta['og:description'] || meta.description || '');
    const fromTitle = parseOgCaptionWrapper(meta['og:title'] || '');
    caption = fromDesc.caption || fromTitle.caption || '';
    if (!added && fromDesc.added) {
      added = fromDesc.added;
    }
  }
  if (!remoteImageUrl && meta['og:image']) {
    remoteImageUrl = meta['og:image'];
  }
  if (meta['og:url']) {
    canonicalUrl = meta['og:url'];
  }

  const loginWall =
    /\/accounts\/login/i.test(String(finalUrl || '')) ||
    (!caption && !remoteImageUrl && /(?:login\s*•\s*instagram|name="username"|accounts\/login)/i.test(source));

  return {
    caption,
    remoteImageUrl,
    added,
    productType,
    canonicalUrl,
    loginWall
  };
}

function toProductTitleCase(raw) {
  const clean = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';

  // If mixed case already (not all-caps), preserve intentional casing while normalizing whitespace
  const hasLower = /[a-z]/.test(clean);
  const hasUpper = /[A-Z]/.test(clean);
  if (hasLower && hasUpper) {
    return clean;
  }

  const tokens = clean.split(' ');
  return tokens
    .map((tok, idx) => {
      const m = /^([^A-Za-z0-9]*)([A-Za-z0-9'-]+)([^A-Za-z0-9]*)$/.exec(tok);
      if (!m) return tok;
      const [, pre, core, post] = m;
      const upper = core.toUpperCase();
      if (PRESERVED_UPPER.has(upper) || (/^[A-Z0-9-]+$/.test(upper) && /\d/.test(upper) && upper.length <= 8)) {
        return pre + upper + post;
      }
      const lower = core.toLowerCase();
      if (idx > 0 && idx < tokens.length - 1 && LOWER_JOINERS.has(lower)) {
        return pre + lower + post;
      }
      return pre + lower.charAt(0).toUpperCase() + lower.slice(1) + post;
    })
    .join(' ');
}

function slugifyId(title, shortcode = '') {
  const base = String(title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u201c\u201d'"]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (base) {
    if (base.length <= 64) return base;
    const cut = base.slice(0, 64).replace(/-[^-]*$/, '');
    return cut || base.slice(0, 64);
  }
  if (shortcode) {
    return `ig-${String(shortcode).toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
  }
  return '';
}

function parseZarPrice(text) {
  const src = String(text || '');
  const lineMatch = /(?:^|\n)\s*price\s*:\s*([^\n]+)/i.exec(src);
  if (lineMatch) {
    const val = lineMatch[1].trim();
    if (/\bsold\b/i.test(val) && !/\d/.test(val)) {
      return { price: 0, found: true, soldText: true };
    }
    const numMatch = /(?:R|ZAR)?\s*(\d[\d\s,\u00A0\u202F]*(?:\.\d{1,2})?)/i.exec(val);
    if (numMatch) {
      const normalized = numMatch[1].replace(/[\s,\u00A0\u202F]/g, '');
      const parsed = Math.round(Number(normalized));
      if (Number.isFinite(parsed) && parsed > 0) {
        return { price: parsed, found: true, soldText: false };
      }
    }
  }

  // Fallback: standalone or inline ZAR price like `R6,950`, `R 4 500.00`, or `. R12 500.`
  const inlineMatch = /(?:^|[\s(—–-])(?:R|ZAR)\s*(\d{1,3}(?:[\s,\u00A0\u202F]\d{3})+(?:\.\d{1,2})?|\d{3,7}(?:\.\d{1,2})?)(?=$|[\s.,;!)])/im.exec(src);
  if (inlineMatch) {
    const normalized = inlineMatch[1].replace(/[\s,\u00A0\u202F]/g, '');
    const parsed = Math.round(Number(normalized));
    if (Number.isFinite(parsed) && parsed > 0) {
      return { price: parsed, found: true, soldText: false };
    }
  }

  return { price: 0, found: false, soldText: false };
}

function inferCategory(title, fullText) {
  const haystack = `${title} ${fullText}`.toLowerCase();
  const rules = [
    ['audio', /\b(receiver|amplifier|amp|turntable|record player|speaker|speakers|surround|hi-?fi|stereo|cassette|tuner|subwoofer|marantz|pioneer|nad|technics|sansui|boston acoustics|yamaha|rotel|luxman|revox)\b/],
    ['lighting', /\b(lamp|table lamp|floor lamp|pendant|sconce|chandelier|lighting|kartell|artemide|flos|louis poulsen)\b/],
    ['cameras', /\b(camera|lens|slr|dslr|rangefinder|fujifilm|leica|nikon|canon|olympus|hasselblad|pentax|rollei|x100v?)\b/],
    ['art', /\b(watercolour|watercolor|oil on|acrylic|lithograph|etching|painting|sculpture|art size|frame size|signed,\s*framed|canvas|gallery print)\b/],
    ['furniture', /\b(chair|armchair|sideboard|credenza|table|desk|sofa|couch|stool|bench|cabinet|bookcase|shelf|mirror|dresser|dining|teak|kiaat|rosewood|cassina|frystark|knoll|vitra)\b/]
  ];

  for (const [cat, re] of rules) {
    if (re.test(haystack)) {
      return { category: cat, defaulted: false };
    }
  }
  return { category: 'furniture', defaulted: true };
}

function normalizeEra(rawEra) {
  const s = String(rawEra || '').trim();
  if (!s) return '';
  return s
    .replace(/\bCIRCA\.?\s*/gi, 'Circa ')
    .replace(/\bMADE\s+IN\s+/gi, '')
    .replace(/\bEARLY\b/gi, 'early')
    .replace(/\bMID\b/gi, 'mid')
    .replace(/\bLATE\b/gi, 'late')
    .replace(/(\d{4})[\u2018\u2019']s\b/gi, '$1s')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOrigin(rawOrigin) {
  const clean = String(rawOrigin || '').trim();
  if (!clean) return '';
  if (/^usa$/i.test(clean)) return 'USA';
  if (/^uk$/i.test(clean)) return 'UK';
  return toProductTitleCase(clean);
}

function inferMaker(rawTitle, designer = '') {
  const titleStr = String(rawTitle || '').trim();
  const byMatch = /\bBY\s+([A-Za-z0-9 &'.-]+)$/i.exec(titleStr);
  let brand = '';
  if (byMatch) {
    brand = toProductTitleCase(byMatch[1].trim());
  } else {
    const lower = titleStr.toLowerCase();
    for (const known of KNOWN_MAKERS) {
      if (lower.includes(known.toLowerCase())) {
        brand = known;
        break;
      }
    }
  }
  if (!brand && titleStr) {
    const words = titleStr.split(/\s+/);
    const skipFirst = new Set(['vintage', 'mid-century', 'mid', 'modern', 'antique', 'rare', 'retro', 'original']);
    const first = words[0].replace(/[^A-Za-z0-9&'-]/g, '');
    if (first && !skipFirst.has(first.toLowerCase())) {
      brand = toProductTitleCase(first);
    }
  }
  if (brand && designer && !brand.toLowerCase().includes(designer.toLowerCase())) {
    return `${brand} · ${designer}`;
  }
  return brand || designer || '';
}

function detectNonProduct(caption, meta = {}, hasPrice = false, hasPipeHeader = false, hasSizeSpec = false) {
  const text = String(caption || '').trim();
  if (!text) return null;

  if (!hasPrice) {
    const promoRe = /\b(we\s+buy|wanted|buying\s+now|turn\s+your\s+.+\s+into\s+cash|dm\s+(?:us\s+)?to\s+sell|looking\s+to\s+buy|showroom\s+hours|giveaway|competition|closed\s+for)\b/i;
    if (promoRe.test(text)) {
      return 'Non-product buying or showroom announcement post';
    }
    if (meta.productType === 'clips' || /\/reel(?:s)?\//i.test(String(meta.sourceUrl || ''))) {
      return 'Reel / video post without product price';
    }
    if (!hasPipeHeader && !hasSizeSpec) {
      return 'Post lacks product pricing and structured listing header';
    }
  }
  return null;
}

function parseRetromodCaption(rawCaption, meta = {}) {
  const warnings = [];
  const errors = [];
  const normalizedText = String(rawCaption || '').replace(/\r\n/g, '\n').trim();

  if (!normalizedText) {
    return {
      isNonProduct: false,
      nonProductReason: '',
      warnings,
      errors: ['Empty caption or post text'],
      candidate: {
        id: slugifyId('', meta.instagramShortcode || ''),
        title: '',
        maker: '',
        origin: '',
        era: '',
        category: 'furniture',
        price: 0,
        quantity: 1,
        status: 'available',
        added: meta.added || new Date().toISOString().slice(0, 10),
        lede: '',
        body: [],
        specs: [],
        image: meta.image || '',
        remoteImageUrl: meta.remoteImageUrl || '',
        instagramUrl: meta.instagramUrl || '',
        instagramShortcode: meta.instagramShortcode || ''
      }
    };
  }

  const rawLines = normalizedText.split('\n');
  const firstNonEmptyIdx = rawLines.findIndex(l => l.trim().length > 0);
  let headerLine = firstNonEmptyIdx >= 0 ? rawLines[firstNonEmptyIdx].trim() : '';

  // Sold detection
  let isSold = false;
  if (/^\s*(?:\*{0,2}|\[)?sold(?:\]{1}|\*{0,2})?(?:\s*[-–—|:]\s*|\s*$)/im.test(normalizedText) || /\bSOLD\b/.test(normalizedText)) {
    isSold = true;
  }
  if (/^\s*(?:\*{0,2}|\[)?sold(?:\]{1}|\*{0,2})?\s*[-–—|:]\s*/i.test(headerLine)) {
    isSold = true;
    headerLine = headerLine.replace(/^\s*(?:\*{0,2}|\[)?sold(?:\]{1}|\*{0,2})?\s*[-–—|:]\s*/i, '').trim();
  }
  if (/\s*[-–—|:]\s*(?:\[)?sold(?:\])?\s*$/i.test(headerLine)) {
    isSold = true;
    headerLine = headerLine.replace(/\s*[-–—|:]\s*(?:\[)?sold(?:\])?\s*$/i, '').trim();
  }

  const priceInfo = parseZarPrice(normalizedText);
  if (priceInfo.soldText) {
    isSold = true;
  }

  const hasPipeHeader = headerLine.includes('|');
  const hasSizeSpec = /^\s*(?:size|frame\s+size|art\s+size|dimensions)\s*:/im.test(normalizedText);

  const nonProductReason = detectNonProduct(
    normalizedText,
    meta,
    priceInfo.found && priceInfo.price > 0,
    hasPipeHeader,
    hasSizeSpec
  );

  // Parse header segments
  let title = '';
  let maker = '';
  let origin = '';
  let era = '';
  let designer = '';

  const segments = headerLine.split('|').map(s => s.trim()).filter(Boolean);
  const artHeaderMatch = segments.length === 2
    ? /^(.+?)\s*\(([^,)]+),\s*([^)]+)\)$/.exec(segments[0])
    : null;

  if (artHeaderMatch) {
    maker = toProductTitleCase(artHeaderMatch[1].trim());
    origin = normalizeOrigin(artHeaderMatch[2].trim());
    title = `${maker} — ${toProductTitleCase(segments[1])}`;
    const bodyAfterHeader = rawLines.slice(firstNonEmptyIdx + 1).join('\n');
    const datedMatch =
      /\b(?:dated|circa)[,:\s]*((?:19|20)\d{2})\b/i.exec(normalizedText) ||
      /\b((?:19|20)\d{2})\b/.exec(bodyAfterHeader);
    era = datedMatch ? datedMatch[1] : '';
  } else if (segments.length >= 1) {
    const rawTitle = segments[0];
    title = toProductTitleCase(rawTitle);

    if (segments.length >= 3) {
      const mid = segments[1];
      const desMatch = /^designed\s+by\s+(.+)/i.exec(mid);
      if (desMatch) {
        designer = toProductTitleCase(desMatch[1].trim());
      }
    }

    if (segments.length >= 2) {
      const tail = segments[segments.length - 1];
      const designMadeMatch = /^DESIGNED\s+(\d{4})\s*,\s*MADE\s+IN\s+(.+)$/i.exec(tail);
      if (designMadeMatch) {
        era = `Designed ${designMadeMatch[1]}`;
        origin = normalizeOrigin(designMadeMatch[2]);
      } else if (tail.includes(',')) {
        const commaIdx = tail.indexOf(',');
        const left = tail.slice(0, commaIdx).trim();
        const right = tail.slice(commaIdx + 1).trim();
        origin = normalizeOrigin(left);
        era = normalizeEra(right);
      } else if (/\b(?:circa|19\d{2}|20\d{2}|\d{4}s)\b/i.test(tail)) {
        era = normalizeEra(tail);
      } else {
        origin = normalizeOrigin(tail);
      }
    }

    maker = inferMaker(rawTitle, designer);
  }

  // Handle single-line em-dash headers like "Technics SL-1200MK2 Direct-Drive Turntable — Japan, 1984. R12 500..."
  if (!hasPipeHeader && segments.length === 1 && /\s+[—–]\s+/.test(headerLine)) {
    const dashParts = headerLine.split(/\s+[—–]\s+/);
    const rawHeadTitle = dashParts[0].trim();
    title = toProductTitleCase(rawHeadTitle);
    const afterDash = (dashParts[1] || '').split(/[.!\n]/)[0].trim();
    if (afterDash.includes(',')) {
      const cIdx = afterDash.indexOf(',');
      origin = normalizeOrigin(afterDash.slice(0, cIdx).trim());
      era = normalizeEra(afterDash.slice(cIdx + 1).trim());
    } else if (/\b(?:circa|19\d{2}|20\d{2}|\d{4}s)\b/i.test(afterDash)) {
      era = normalizeEra(afterDash);
    } else if (afterDash && !/^(?:R|ZAR)\s*\d/i.test(afterDash) && !/^sold$/i.test(afterDash)) {
      origin = normalizeOrigin(afterDash);
    }
    maker = inferMaker(rawHeadTitle, designer);
  }

  // Extract specs & filter boilerplate lines for lede/body
  const specs = [];
  if (designer) {
    specs.push(['Designer', designer]);
  }
  let hasShipping = false;
  const specLineRe = /^(Size|Frame Size|Art Size|Dimensions|Condition|Finish|Material|Designer|Output|Series|Type|Model|Edition|Production No\.?|[A-Za-z0-9 .]+?Production No\.?)\s*:\s*(.+)$/i;
  const bodyLines = [];

  for (let i = 0; i < rawLines.length; i++) {
    if (i === firstNonEmptyIdx && (hasPipeHeader || headerLine.length > 0)) {
      // Skip header line from body if it looks like a listing header (all caps or pipe-delimited)
      if (hasPipeHeader || headerLine === headerLine.toUpperCase()) {
        continue;
      }
    }
    const line = rawLines[i].trim();
    if (!line) {
      bodyLines.push('');
      continue;
    }
    if (/^\s*price\s*:/i.test(line)) continue;
    if (/^\s*(?:R|ZAR)\s*\d[\d\s,\u00A0\u202F]*(?:\.\d{1,2})?\s*$/i.test(line)) continue;
    if (/^\s*(?:\*{0,2}|\[)?sold(?:\]{1}|\*{0,2})?\s*$/i.test(line)) continue;
    if (/nationwide\s+shipping\s+available/i.test(line)) {
      hasShipping = true;
      continue;
    }
    if (/kindly\s+send\s+@?retromod\.za\s+a\s+dm/i.test(line)) continue;
    if (/^dm\s+@?retromod\.za\b/i.test(line)) continue;
    if (/^(?:#\S+\s*)+$/.test(line)) continue;

    const sm = specLineRe.exec(line);
    if (sm) {
      const k = toProductTitleCase(sm[1].replace(/\.$/, '').trim());
      const v = sm[2].trim();
      if (k && v) {
        specs.push([k, v]);
      }
      continue;
    }

    bodyLines.push(line);
  }

  if (hasShipping && !specs.some(([k]) => k.toLowerCase() === 'shipping')) {
    specs.push(['Shipping', 'Nationwide']);
  }

  const paragraphs = bodyLines
    .join('\n')
    .split(/\n{2,}/)
    .map(p => p.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  let lede = '';
  let body = [];
  if (paragraphs.length >= 2) {
    lede = paragraphs[0];
    body = paragraphs.slice(1);
  } else if (paragraphs.length === 1) {
    const single = paragraphs[0];
    const sentMatch = /^(.+?[.!?])\s+([\s\S]+)$/.exec(single);
    if (sentMatch) {
      lede = sentMatch[1].trim();
      body = [sentMatch[2].trim()];
    } else {
      lede = single;
      body = [single];
    }
  }

  if (!title && lede) {
    title = lede.split(/[.!?]/)[0].slice(0, 72).trim();
  }

  const catInfo = inferCategory(title, normalizedText);
  if (catInfo.defaulted && !nonProductReason) {
    warnings.push('Category defaulted to furniture; verify before commit');
  }

  const id = slugifyId(title, meta.instagramShortcode || '');
  const status = isSold ? 'sold' : 'available';
  const qtyMatch = /\bqty\s*:\s*(\d+)\b/i.exec(normalizedText);
  const parsedQty = qtyMatch ? Math.max(1, parseInt(qtyMatch[1], 10)) : 1;
  const quantity = isSold ? 0 : parsedQty;

  // Extract inline Instagram URL / shortcode if not provided in meta
  let igUrl = meta.instagramUrl || '';
  let igShortcode = meta.instagramShortcode || '';
  if (!igShortcode) {
    const inlineIg = /https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._-]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{3,40})\/?/i.exec(normalizedText);
    if (inlineIg) {
      igShortcode = inlineIg[1];
      if (!igUrl) igUrl = inlineIg[0];
    }
  }

  if (!nonProductReason) {
    if (!title) {
      errors.push('Missing product title');
    }
    if ((!priceInfo.found || priceInfo.price <= 0) && !isSold) {
      errors.push('Missing or invalid ZAR price (e.g. Price : R6 950.00)');
    }
  }

  return {
    isNonProduct: Boolean(nonProductReason),
    nonProductReason: nonProductReason || '',
    warnings,
    errors,
    candidate: {
      id,
      title,
      maker,
      origin,
      era,
      category: catInfo.category,
      price: priceInfo.price,
      quantity,
      status,
      added: meta.added || new Date().toISOString().slice(0, 10),
      lede,
      body,
      specs,
      image: meta.image || '',
      remoteImageUrl: meta.remoteImageUrl || '',
      instagramUrl: igUrl,
      instagramShortcode: igShortcode
    }
  };
}

function parseCsvText(csvText) {
  const input = String(csvText || '').replace(/^\uFEFF/, '');
  if (!input.trim()) return [];

  // Detect delimiter from first line if comma isn't present outside quotes
  const firstLine = input.split(/\r?\n/)[0] || '';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const delim = commaCount === 0 && semiCount > 0 ? ';' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmptyRows = rows.filter(r => r.some(cell => String(cell).trim() !== ''));
  if (nonEmptyRows.length < 2) return [];

  const headers = nonEmptyRows[0].map(h =>
    String(h || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  );

  const records = [];
  for (let r = 1; r < nonEmptyRows.length; r++) {
    const cells = nonEmptyRows[r];
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      obj[key] = cells[c] !== undefined ? String(cells[c]).trim() : '';
    }
    records.push(obj);
  }
  return records;
}

function extractShortcodeFromUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    const m = IG_POST_PATH_RE.exec(u.pathname);
    return m ? { type: m[1].toLowerCase(), shortcode: m[2], url: u } : null;
  } catch {
    return null;
  }
}

function getStringMapField(entry, keyName) {
  const map = entry && entry.string_map_data;
  if (!map || typeof map !== 'object') return '';
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === keyName.toLowerCase() && v && v.value !== undefined) {
      return String(v.value);
    }
  }
  return '';
}

function normalizeStructuredItem(raw, idx) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const warnings = [];
  const errors = [];

  const rawCaption = src.caption || src.description || '';
  const rawTitle = src.title || src.name || '';
  const rawUrl = src.instagramUrl || src.instagram_url || src.url || src.permalink || '';
  const extractedSc = extractShortcodeFromUrl(rawUrl);
  const instagramShortcode = String(
    src.instagramShortcode || src.shortcode || (extractedSc ? extractedSc.shortcode : '')
  ).trim();
  const instagramUrl = String(
    rawUrl || (instagramShortcode ? `https://www.instagram.com/retromod.za/p/${instagramShortcode}/` : '')
  ).trim();

  let added = src.added || src.date || '';
  if (!added && src.creation_timestamp) {
    const ts = Number(src.creation_timestamp);
    if (Number.isFinite(ts) && ts > 0) {
      added = new Date(ts * 1000).toISOString().slice(0, 10);
    }
  }
  if (!added) {
    added = new Date().toISOString().slice(0, 10);
  }

  let remoteImageUrl = String(src.remoteImageUrl || src.image_url || '').trim();
  let localImage = String(src.image || '').trim();
  if (/^https?:\/\//i.test(localImage)) {
    if (!remoteImageUrl) remoteImageUrl = localImage;
    localImage = '';
  }

  // If caption is provided without structured title or price, parse caption first
  let parsed = null;
  if (rawCaption && (!rawTitle || src.price === undefined)) {
    parsed = parseRetromodCaption(fixMetaMojibake(rawCaption), {
      instagramUrl,
      instagramShortcode,
      added,
      image: localImage,
      remoteImageUrl
    });
  }

  const base = parsed ? parsed.candidate : {};
  const title = String(rawTitle || base.title || '').trim();
  const maker = String(src.maker || src.brand || src.designer || base.maker || '').trim();
  const origin = String(src.origin || src.country || base.origin || '').trim();
  const era = String(src.era || src.year || base.era || '').trim();
  const category = String(src.category || base.category || inferCategory(title, rawCaption).category).trim().toLowerCase();

  let price = base.price || 0;
  const rawPrice = src.price !== undefined ? src.price : (src.price_zar !== undefined ? src.price_zar : src.amount);
  if (rawPrice !== undefined && rawPrice !== '') {
    const cleaned = String(rawPrice).replace(/[^\d.-]/g, '');
    const n = Number(cleaned);
    price = Number.isFinite(n) ? Math.round(n) : NaN;
  }

  let status = String(src.status || base.status || 'available').trim().toLowerCase();
  let quantity = base.quantity !== undefined ? base.quantity : 1;
  const rawQty = src.quantity !== undefined ? src.quantity : (src.qty !== undefined ? src.qty : src.stock);
  if (rawQty !== undefined && rawQty !== '') {
    const qn = Number(rawQty);
    quantity = Number.isFinite(qn) ? Math.floor(qn) : NaN;
  }
  if (status === 'sold') {
    quantity = 0;
  } else if (Number.isFinite(quantity) && quantity <= 0) {
    quantity = 0;
    status = 'sold';
  }

  const lede = String(src.lede || base.lede || (rawCaption && rawTitle ? rawCaption : '')).trim();
  let body = base.body || [];
  if (Array.isArray(src.body)) {
    body = src.body.map(b => String(b).trim()).filter(Boolean);
  } else if (typeof src.body === 'string' && src.body.trim()) {
    body = src.body.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  } else if (!body.length && lede) {
    body = [lede];
  }

  let specs = Array.isArray(base.specs) ? base.specs : [];
  if (Array.isArray(src.specs)) {
    specs = src.specs
      .filter(pair => Array.isArray(pair) && pair.length >= 2)
      .map(([k, v]) => [String(k).trim(), String(v).trim()]);
  } else if (src.size || src.dimensions) {
    specs = [...specs, ['Size', String(src.size || src.dimensions).trim()]];
  }

  const id = String(src.id || slugifyId(title, instagramShortcode) || `import-${idx + 1}`).trim().toLowerCase();

  if (parsed && parsed.warnings.length) warnings.push(...parsed.warnings);
  if (parsed && parsed.errors.length && !rawTitle && !rawPrice) {
    errors.push(...parsed.errors);
  }

  return {
    isNonProduct: Boolean(parsed && parsed.isNonProduct && !rawTitle && rawPrice === undefined),
    nonProductReason: parsed ? parsed.nonProductReason : '',
    warnings,
    errors,
    candidate: {
      id,
      title,
      maker,
      origin,
      era,
      category,
      price,
      quantity,
      status,
      added,
      lede,
      body,
      specs,
      image: localImage,
      remoteImageUrl,
      instagramUrl,
      instagramShortcode
    }
  };
}

function parseMetaPostsArray(arr) {
  const results = [];
  for (let i = 0; i < arr.length; i++) {
    const post = arr[i];
    if (!post || typeof post !== 'object') continue;
    const mediaList = Array.isArray(post.media) ? post.media : [];
    const firstMedia = mediaList[0] && typeof mediaList[0] === 'object' ? mediaList[0] : {};
    const rawCaption = fixMetaMojibake(
      post.title ||
      firstMedia.title ||
      getStringMapField(post, 'Title') ||
      getStringMapField(post, 'Caption') ||
      ''
    );
    const ts = Number(
      post.creation_timestamp ||
      firstMedia.creation_timestamp ||
      getStringMapField(post, 'Creation Timestamp') ||
      0
    );
    const added = Number.isFinite(ts) && ts > 0
      ? new Date(ts * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const uri = String(firstMedia.uri || post.uri || '').trim();
    const rawUrl = String(post.url || post.permalink || post.instagramUrl || getStringMapField(post, 'URL') || '').trim();
    const extracted = extractShortcodeFromUrl(rawUrl);
    const instagramShortcode = String(
      post.instagramShortcode || post.shortcode || (extracted ? extracted.shortcode : '')
    ).trim();
    const instagramUrl = rawUrl || (instagramShortcode ? `https://www.instagram.com/retromod.za/p/${instagramShortcode}/` : '');

    let remoteImageUrl = '';
    const extraWarnings = [];
    if (/^https?:\/\//i.test(uri)) {
      remoteImageUrl = uri;
    } else if (uri) {
      extraWarnings.push(`Export references local archive file "${uri}"; upload image before or after import`);
    }

    const parsed = parseRetromodCaption(rawCaption, {
      instagramUrl,
      instagramShortcode,
      added,
      remoteImageUrl
    });
    parsed.warnings.push(...extraWarnings);
    results.push(parsed);
  }
  return results;
}

function parseExportPayload(payload) {
  let data = payload;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) {
      throw new HttpError(400, 'Export payload is empty');
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        data = JSON.parse(trimmed);
      } catch {
        throw new HttpError(400, 'Invalid JSON export payload');
      }
    } else {
      const csvRows = parseCsvText(trimmed);
      if (!csvRows.length) {
        throw new HttpError(400, 'CSV export has no data rows');
      }
      return csvRows.map((row, idx) => normalizeStructuredItem(row, idx));
    }
  }

  if (Array.isArray(data)) {
    const looksLikeMeta = data.some(
      x => x && typeof x === 'object' && (Array.isArray(x.media) || x.creation_timestamp !== undefined || x.string_map_data !== undefined)
    );
    if (looksLikeMeta) {
      return parseMetaPostsArray(data);
    }
    return data.map((row, idx) => normalizeStructuredItem(row, idx));
  }

  if (data && typeof data === 'object') {
    const list = data.products || data.items || data.posts || data.ig_posts;
    if (Array.isArray(list)) {
      const looksLikeMeta = list.some(
        x => x && typeof x === 'object' && (Array.isArray(x.media) || x.creation_timestamp !== undefined || x.string_map_data !== undefined)
      );
      if (looksLikeMeta) {
        return parseMetaPostsArray(list);
      }
      return list.map((row, idx) => normalizeStructuredItem(row, idx));
    }
    throw new HttpError(400, 'Export JSON must be an array or contain products/items/posts');
  }

  throw new HttpError(400, 'Unsupported export payload');
}

function splitCaptionBlocks(rawText) {
  const text = String(rawText || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  if (/^\s*---+\s*$/m.test(text)) {
    return text.split(/^\s*---+\s*$/m).map(s => s.trim()).filter(Boolean);
  }

  // Split multi-post pastes where a new `TITLE | ...` line follows a completed listing block
  const lines = text.split('\n');
  const blocks = [];
  let current = [];
  let sawPostEnd = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      sawPostEnd &&
      trimmed &&
      trimmed.includes('|') &&
      !/^\s*(?:price|size|frame\s+size|art\s+size|kindly\s+send)/i.test(trimmed)
    ) {
      blocks.push(current.join('\n').trim());
      current = [line];
      sawPostEnd = false;
      continue;
    }
    current.push(line);
    if (/^\s*price\s*:/i.test(trimmed) || /kindly\s+send\s+@?retromod\.za\s+a\s+dm/i.test(trimmed)) {
      sawPostEnd = true;
    }
  }
  if (current.length) {
    const joined = current.join('\n').trim();
    if (joined) blocks.push(joined);
  }

  return blocks.length ? blocks : [text];
}

function detectMode(body) {
  const explicit = body && typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : 'auto';
  if (explicit && explicit !== 'auto') {
    if (explicit === 'csv') return 'export';
    if (!['urls', 'export', 'caption'].includes(explicit)) {
      throw new HttpError(400, 'Invalid import mode (expected auto, urls, export, csv, or caption)');
    }
    return explicit;
  }

  if (Array.isArray(body && body.urls) && body.urls.length > 0) {
    return 'urls';
  }

  const payload = body ? body.payload : undefined;
  if (payload && typeof payload === 'object') {
    return 'export';
  }

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) {
      throw new HttpError(400, 'Provide Instagram URLs, export data, or caption text');
    }
    const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every(l => /^https?:\/\//i.test(l))) {
      return 'urls';
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return 'export';
    }
    const firstLine = lines[0] || '';
    if (lines.length >= 2 && /[,;]/.test(firstLine) && /\b(title|name|caption|price|url|shortcode)\b/i.test(firstLine)) {
      return 'export';
    }
    return 'caption';
  }

  throw new HttpError(400, 'Provide Instagram URLs, export data, or caption text');
}

function isSafeImageRef(imageVal) {
  const str = String(imageVal || '').trim();
  if (!str) return true;
  if (/^data:image\//i.test(str)) {
    try {
      decodeDataUriImage(str);
      return true;
    } catch {
      return false;
    }
  }
  if (str.includes('..') || str.includes('\\')) return false;
  return SAFE_LOCAL_IMAGE_RE.test(str);
}

async function validateRemoteImageCandidate(remoteUrl, allowHosts, lookup) {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return { ok: true, url: '' };
  try {
    await assertSafeUrl(raw, { allowHosts, lookup });
    return { ok: true, url: raw };
  } catch (err) {
    return { ok: false, reason: err.message || 'Unsafe remote image URL' };
  }
}

function validateCandidateFields(candidate, { requireImageSafety = true } = {}) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') {
    return ['Missing candidate object'];
  }

  const id = String(candidate.id || '').trim();
  if (!id || !SAFE_ID_RE.test(id)) {
    errors.push('Invalid or missing product id slug');
  }

  const title = String(candidate.title || '').trim();
  if (!title) {
    errors.push('Missing product title');
  }

  const cat = String(candidate.category || '').trim().toLowerCase();
  if (!VALID_CATEGORIES.has(cat)) {
    errors.push(`Invalid category "${candidate.category || ''}"`);
  }

  const status = String(candidate.status || 'available').trim().toLowerCase();
  if (!VALID_STATUSES.has(status)) {
    errors.push(`Invalid status "${candidate.status || ''}"`);
  }

  const price = Number(candidate.price);
  if (!Number.isFinite(price) || price < 0 || (status !== 'sold' && price <= 0)) {
    errors.push('Price must be greater than 0 ZAR (or >= 0 for sold items)');
  }

  const qty = Number(candidate.quantity);
  if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 0) {
    errors.push('Quantity must be a whole number >= 0');
  }

  if (requireImageSafety && !isSafeImageRef(candidate.image)) {
    errors.push('Unsafe or unsupported local image reference');
  }

  return errors;
}

function areCandidatesEquivalent(cand, existing) {
  return (
    Math.round(Number(cand.price) || 0) === Math.round(Number(existing.price) || 0) &&
    String(cand.status || '') === String(existing.status || '') &&
    Math.floor(Number(cand.quantity) || 0) === Math.floor(Number(existing.quantity) || 0) &&
    String(cand.title || '').trim() === String(existing.title || '').trim()
  );
}

async function previewSingleUrl(rawUrl, index, options = {}) {
  const trimmed = String(rawUrl || '').trim();
  const tempId = `imp-${index + 1}`;
  const allowHosts = options.allowHosts instanceof Set ? options.allowHosts : getAllowHosts();

  if (!trimmed) {
    return {
      tempId,
      action: 'invalid',
      warnings: [],
      errors: ['Empty URL'],
      matchedProductId: null,
      candidate: {
        id: '',
        title: '',
        maker: '',
        origin: '',
        era: '',
        category: 'furniture',
        price: 0,
        quantity: 1,
        status: 'available',
        added: new Date().toISOString().slice(0, 10),
        lede: '',
        body: [],
        specs: [],
        image: '',
        remoteImageUrl: '',
        instagramUrl: '',
        instagramShortcode: ''
      }
    };
  }

  // Validate SSRF + Instagram URL shape before any fetch
  let checked;
  try {
    checked = await assertSafeUrl(trimmed, {
      allowHosts,
      lookup: options.lookup,
      requireInstagramHost: true
    });
  } catch (err) {
    return {
      tempId,
      action: 'invalid',
      warnings: [],
      errors: [err.message || 'URL blocked by security policy'],
      matchedProductId: null,
      candidate: {
        id: '',
        title: '',
        maker: '',
        origin: '',
        era: '',
        category: 'furniture',
        price: 0,
        quantity: 1,
        status: 'available',
        added: new Date().toISOString().slice(0, 10),
        lede: '',
        body: [],
        specs: [],
        image: '',
        remoteImageUrl: '',
        instagramUrl: '',
        instagramShortcode: ''
      }
    };
  }

  const scMatch = IG_POST_PATH_RE.exec(checked.url.pathname);
  if (!scMatch) {
    return {
      tempId,
      action: 'invalid',
      warnings: [],
      errors: ['URL is not a valid Instagram post (/p/<shortcode>/ or /reel/<shortcode>/)'],
      matchedProductId: null,
      candidate: {
        id: '',
        title: '',
        maker: '',
        origin: '',
        era: '',
        category: 'furniture',
        price: 0,
        quantity: 1,
        status: 'available',
        added: new Date().toISOString().slice(0, 10),
        lede: '',
        body: [],
        specs: [],
        image: '',
        remoteImageUrl: '',
        instagramUrl: trimmed,
        instagramShortcode: ''
      }
    };
  }

  const pathType = scMatch[1].toLowerCase();
  const shortcode = scMatch[2];
  const canonicalIgUrl = pathType === 'reel' || pathType === 'reels'
    ? `https://www.instagram.com/retromod.za/reel/${shortcode}/`
    : `https://www.instagram.com/retromod.za/p/${shortcode}/`;

  let resp;
  try {
    resp = await safeFetch(trimmed, {
      allowHosts,
      lookup: options.lookup,
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 10000,
      requireInstagramHost: true
    });
  } catch (err) {
    // Distinguish SSRF redirect block vs transient network failure
    if (err instanceof SsrfBlockedError) {
      return {
        tempId,
        action: 'invalid',
        warnings: [],
        errors: [err.message],
        matchedProductId: null,
        candidate: {
          id: `ig-${shortcode.toLowerCase()}`,
          title: '',
          maker: '',
          origin: '',
          era: '',
          category: 'furniture',
          price: 0,
          quantity: 1,
          status: 'available',
          added: new Date().toISOString().slice(0, 10),
          lede: '',
          body: [],
          specs: [],
          image: '',
          remoteImageUrl: '',
          instagramUrl: canonicalIgUrl,
          instagramShortcode: shortcode
        }
      };
    }

    return {
      tempId,
      action: 'invalid',
      warnings: ['Assisted draft created from URL shortcode'],
      errors: [`Unable to fetch Instagram post (${err.message || 'network error'}); complete missing fields manually or paste the caption.`],
      matchedProductId: null,
      candidate: {
        id: `ig-${shortcode.toLowerCase()}`,
        title: '',
        maker: '',
        origin: '',
        era: '',
        category: 'furniture',
        price: 0,
        quantity: 1,
        status: 'available',
        added: new Date().toISOString().slice(0, 10),
        lede: '',
        body: [],
        specs: [],
        image: '',
        remoteImageUrl: '',
        instagramUrl: canonicalIgUrl,
        instagramShortcode: shortcode
      }
    };
  }

  if (resp.status === 401 || resp.status === 403 || resp.status === 404 || resp.status === 429 || resp.status >= 500 || resp.status < 200) {
    return {
      tempId,
      action: 'invalid',
      warnings: ['Assisted draft created from URL shortcode'],
      errors: [`Instagram returned HTTP ${resp.status}; complete missing fields manually or paste the caption.`],
      matchedProductId: null,
      candidate: {
        id: `ig-${shortcode.toLowerCase()}`,
        title: '',
        maker: '',
        origin: '',
        era: '',
        category: 'furniture',
        price: 0,
        quantity: 1,
        status: 'available',
        added: new Date().toISOString().slice(0, 10),
        lede: '',
        body: [],
        specs: [],
        image: '',
        remoteImageUrl: '',
        instagramUrl: canonicalIgUrl,
        instagramShortcode: shortcode
      }
    };
  }

  const html = resp.body.toString('utf8');
  const extracted = extractInstagramPostFromHtml(html, shortcode, resp.finalUrl);

  if (extracted.loginWall || (!extracted.caption && !extracted.remoteImageUrl)) {
    return {
      tempId,
      action: 'invalid',
      warnings: ['Assisted draft created from URL shortcode'],
      errors: ['Instagram showed a login wall or empty payload; complete missing fields manually or paste the caption.'],
      matchedProductId: null,
      candidate: {
        id: `ig-${shortcode.toLowerCase()}`,
        title: '',
        maker: '',
        origin: '',
        era: '',
        category: 'furniture',
        price: 0,
        quantity: 1,
        status: 'available',
        added: new Date().toISOString().slice(0, 10),
        lede: '',
        body: [],
        specs: [],
        image: '',
        remoteImageUrl: '',
        instagramUrl: canonicalIgUrl,
        instagramShortcode: shortcode
      }
    };
  }

  // Validate extracted remoteImageUrl against SSRF policy
  let safeRemoteImg = '';
  const extraWarnings = [];
  if (extracted.remoteImageUrl) {
    const checkImg = await validateRemoteImageCandidate(extracted.remoteImageUrl, allowHosts, options.lookup);
    if (checkImg.ok) {
      safeRemoteImg = checkImg.url;
    } else {
      extraWarnings.push(`Ignored unsafe remote image URL: ${checkImg.reason}`);
    }
  }

  const parsed = parseRetromodCaption(extracted.caption, {
    instagramUrl: extracted.canonicalUrl && INSTAGRAM_HOSTS.has(new URL(extracted.canonicalUrl).hostname.toLowerCase())
      ? extracted.canonicalUrl
      : canonicalIgUrl,
    instagramShortcode: shortcode,
    added: extracted.added || new Date().toISOString().slice(0, 10),
    remoteImageUrl: safeRemoteImg,
    productType: extracted.productType || (pathType === 'reel' || pathType === 'reels' ? 'clips' : 'feed'),
    sourceUrl: trimmed
  });

  parsed.warnings.push(...extraWarnings);

  return {
    tempId,
    isNonProduct: parsed.isNonProduct,
    nonProductReason: parsed.nonProductReason,
    warnings: parsed.warnings,
    errors: parsed.errors,
    matchedProductId: null,
    candidate: parsed.candidate
  };
}

async function previewImport(body, { store, lookup } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Preview payload must be a JSON object');
  }
  if (!store) {
    throw new Error('store is required');
  }

  const mode = detectMode(body);
  const allowHosts = getAllowHosts();
  let rawEntries = [];

  if (mode === 'urls') {
    let urls = Array.isArray(body.urls) ? body.urls : [];
    if (!urls.length && typeof body.payload === 'string') {
      urls = body.payload.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
    if (!urls.length) {
      throw new HttpError(400, 'At least one Instagram URL is required');
    }
    rawEntries = await Promise.all(
      urls.map((u, idx) => previewSingleUrl(u, idx, { allowHosts, lookup }))
    );
  } else if (mode === 'export') {
    const sourcePayload = body.payload !== undefined ? body.payload : body.items;
    if (sourcePayload === undefined) {
      throw new HttpError(400, 'Export payload is required');
    }
    rawEntries = parseExportPayload(sourcePayload);
  } else {
    const text = typeof body.payload === 'string' ? body.payload : '';
    if (!text.trim()) {
      throw new HttpError(400, 'Caption text is required');
    }
    const blocks = splitCaptionBlocks(text);
    rawEntries = blocks.map(block => parseRetromodCaption(block));
  }

  // Classify items against existing catalog & within-batch duplicates (read-only!)
  const catalog = await store.getCatalog();
  const existingProducts = Array.isArray(catalog.products) ? catalog.products : [];
  const byShortcode = new Map();
  const byId = new Map();
  for (const p of existingProducts) {
    if (p.instagramShortcode) byShortcode.set(String(p.instagramShortcode).toLowerCase(), p);
    if (p.id) byId.set(String(p.id).toLowerCase(), p);
  }

  const seenIds = new Set();
  const seenShortcodes = new Set();
  const items = [];
  const summary = { total: 0, valid: 0, invalid: 0, duplicates: 0, nonProduct: 0 };

  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i];
    const tempId = entry.tempId || `imp-${i + 1}`;
    const warnings = Array.isArray(entry.warnings) ? [...entry.warnings] : [];
    const errors = Array.isArray(entry.errors) ? [...entry.errors] : [];
    const cand = { ...entry.candidate };
    let matchedProductId = null;
    let action = entry.action || 'create';

    if (cand.remoteImageUrl) {
      const checkImg = await validateRemoteImageCandidate(cand.remoteImageUrl, allowHosts, lookup);
      if (!checkImg.ok) {
        errors.push(`Unsafe remoteImageUrl: ${checkImg.reason}`);
        cand.remoteImageUrl = '';
      }
    }

    if (entry.isNonProduct) {
      action = 'non_product';
      if (entry.nonProductReason) {
        warnings.unshift(entry.nonProductReason);
      }
      summary.nonProduct += 1;
    } else {
      const fieldErrors = validateCandidateFields(cand);
      for (const fe of fieldErrors) {
        if (!errors.includes(fe)) errors.push(fe);
      }

      if (errors.length > 0) {
        action = 'invalid';
        summary.invalid += 1;
      } else {
        const scKey = cand.instagramShortcode ? cand.instagramShortcode.toLowerCase() : '';
        const idKey = cand.id ? cand.id.toLowerCase() : '';

        if ((scKey && seenShortcodes.has(scKey)) || (idKey && seenIds.has(idKey))) {
          action = 'duplicate';
          errors.push('Duplicate item within import batch');
          summary.duplicates += 1;
        } else {
          if (scKey) seenShortcodes.add(scKey);
          if (idKey) seenIds.add(idKey);

          const existing = (scKey && byShortcode.get(scKey)) || (idKey && byId.get(idKey)) || null;
          if (existing) {
            matchedProductId = existing.id;
            cand.id = existing.id;
            if (!cand.image && existing.image) {
              cand.image = existing.image;
            }
            if (areCandidatesEquivalent(cand, existing)) {
              action = 'duplicate';
              warnings.push(`Already exists in catalog as "${existing.id}" (no changes detected)`);
              summary.duplicates += 1;
            } else {
              action = 'update';
              warnings.push(`Matches existing product "${existing.id}" and will update it`);
              summary.valid += 1;
            }
          } else {
            action = 'create';
            summary.valid += 1;
          }
        }
      }
    }

    summary.total += 1;
    items.push({
      tempId,
      action,
      warnings,
      errors,
      matchedProductId,
      candidate: cand
    });
  }

  return {
    mode,
    items,
    summary
  };
}

function writeMediaBufferAtomic(mediaDir, fileName, buffer) {
  fs.mkdirSync(mediaDir, { recursive: true });
  const destPath = path.join(mediaDir, fileName);
  const tmpPath = `${destPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, buffer);
  try {
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
  return destPath;
}

function extractCommitItem(raw, idx) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { malformed: true, tempId: `row-${idx + 1}`, id: '', reason: 'Malformed import item' };
  }
  if (raw.include === false) {
    return { skip: true, tempId: raw.tempId || `row-${idx + 1}` };
  }
  const hasNested = raw.candidate && typeof raw.candidate === 'object' && !Array.isArray(raw.candidate);
  const cand = hasNested ? { ...raw.candidate } : { ...raw };
  const tempId = String(raw.tempId || cand.tempId || `row-${idx + 1}`);
  const action = String(raw.action || cand.action || 'create').toLowerCase();
  const matchedProductId = raw.matchedProductId || cand.matchedProductId || null;

  delete cand.tempId;
  delete cand.action;
  delete cand.include;
  delete cand.matchedProductId;

  return {
    malformed: false,
    skip: false,
    tempId,
    action,
    matchedProductId,
    candidate: cand
  };
}

async function commitImport(body, { store, lookup } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Commit payload must be a JSON object');
  }
  if (!Array.isArray(body.items)) {
    throw new HttpError(400, 'items must be an array');
  }
  if (!store) {
    throw new Error('store is required');
  }

  const downloadImages = body.downloadImages !== false;
  const allowHosts = getAllowHosts();

  // Phase 1: Pre-fetch & decode images OUTSIDE store.withTransaction
  const prepared = [];
  for (let i = 0; i < body.items.length; i++) {
    const parsed = extractCommitItem(body.items[i], i);
    if (parsed.skip) continue;
    if (parsed.malformed) {
      prepared.push(parsed);
      continue;
    }

    const cand = parsed.candidate;
    const preErrors = [];
    let pendingMedia = null;

    if (parsed.action === 'non_product') {
      preErrors.push('Non-product item cannot be committed');
    } else if (parsed.action === 'duplicate') {
      preErrors.push('Duplicate item skipped');
    } else {
      // Normalize candidate fields before validation
      cand.id = String(cand.id || slugifyId(cand.title, cand.instagramShortcode || '')).trim().toLowerCase();
      cand.title = String(cand.title || '').trim();
      cand.category = String(cand.category || 'furniture').trim().toLowerCase();
      cand.status = String(cand.status || 'available').trim().toLowerCase();
      if (cand.price !== undefined && cand.price !== '') {
        cand.price = Number(cand.price);
      }
      if (cand.quantity !== undefined && cand.quantity !== '') {
        cand.quantity = Number(cand.quantity);
      } else {
        cand.quantity = cand.status === 'sold' ? 0 : 1;
      }

      // Check local data URI image upload first
      const rawImageData = typeof cand.imageData === 'string' && cand.imageData
        ? cand.imageData
        : (typeof cand.image === 'string' && /^data:/i.test(cand.image.trim()) ? cand.image.trim() : '');

      if (rawImageData) {
        try {
          pendingMedia = decodeDataUriImage(rawImageData);
          cand.image = '';
        } catch (err) {
          preErrors.push(err.message || 'Invalid uploaded image data');
        }
      } else if (typeof cand.image === 'string' && cand.image.trim() && !isSafeImageRef(cand.image)) {
        preErrors.push('Unsafe image path or scheme rejected');
      } else if (downloadImages && typeof cand.remoteImageUrl === 'string' && cand.remoteImageUrl.trim()) {
        const remoteUrl = cand.remoteImageUrl.trim();
        try {
          const resp = await safeFetch(remoteUrl, {
            allowHosts,
            lookup,
            maxBytes: 8 * 1024 * 1024,
            timeoutMs: 10000
          });
          if (resp.status < 200 || resp.status >= 300) {
            preErrors.push(`Failed to download remote image (HTTP ${resp.status})`);
          } else {
            const ext = detectImageFormat(resp.body);
            if (!ext) {
              preErrors.push('Remote image bytes are not a valid raster image (JPEG, PNG, WEBP, GIF)');
            } else {
              pendingMedia = { buffer: resp.body, ext };
            }
          }
        } catch (err) {
          preErrors.push(`Remote image error: ${err.message || 'download failed'}`);
        }
      }

      if (!preErrors.length) {
        const fieldErrors = validateCandidateFields(cand);
        preErrors.push(...fieldErrors);
      }
    }

    prepared.push({
      ...parsed,
      preErrors,
      pendingMedia
    });
  }

  // Phase 2: Atomic store transaction
  const nowIso = new Date().toISOString();
  return store.withTransaction(async ({ catalog, importLogs, mediaDir, writeMedia }) => {
    const saveMedia = typeof writeMedia === 'function'
      ? (fileName, buffer) => writeMedia(fileName, buffer)
      : async (fileName, buffer) => writeMediaBufferAtomic(mediaDir, fileName, buffer);
    const products = Array.isArray(catalog.products) ? catalog.products : [];
    const byId = new Map();
    const byShortcode = new Map();
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      if (p.id) byId.set(String(p.id).toLowerCase(), i);
      if (p.instagramShortcode) byShortcode.set(String(p.instagramShortcode).toLowerCase(), i);
    }

    const batchSeenIds = new Set();
    const batchSeenShortcodes = new Set();
    let created = 0;
    let updated = 0;
    let rejected = 0;
    const errors = [];
    const logItems = [];

    for (const item of prepared) {
      if (item.malformed) {
        rejected += 1;
        errors.push({ tempId: item.tempId, id: item.id, reason: item.reason });
        logItems.push({ tempId: item.tempId, id: item.id, action: 'invalid', outcome: 'rejected', reason: item.reason });
        continue;
      }

      const cand = item.candidate;
      const candId = String(cand.id || '').toLowerCase();
      const candSc = String(cand.instagramShortcode || '').toLowerCase();

      if (item.preErrors && item.preErrors.length > 0) {
        const reason = item.preErrors.join('; ');
        rejected += 1;
        errors.push({ tempId: item.tempId, id: candId, reason });
        logItems.push({ tempId: item.tempId, id: candId, action: item.action, outcome: 'rejected', reason });
        continue;
      }

      if ((candId && batchSeenIds.has(candId)) || (candSc && batchSeenShortcodes.has(candSc))) {
        const reason = 'Duplicate item in commit batch';
        rejected += 1;
        errors.push({ tempId: item.tempId, id: candId, reason });
        logItems.push({ tempId: item.tempId, id: candId, action: item.action, outcome: 'rejected', reason });
        continue;
      }

      try {
        let existingIdx = -1;
        if (item.matchedProductId && byId.has(String(item.matchedProductId).toLowerCase())) {
          existingIdx = byId.get(String(item.matchedProductId).toLowerCase());
        } else if (candSc && byShortcode.has(candSc)) {
          existingIdx = byShortcode.get(candSc);
        } else if (candId && byId.has(candId)) {
          existingIdx = byId.get(candId);
        }

        if (existingIdx !== -1) {
          const existing = products[existingIdx];
          if (item.action !== 'update') {
            const reason = `Product "${existing.id}" already exists in catalog`;
            rejected += 1;
            errors.push({ tempId: item.tempId, id: candId, reason });
            logItems.push({ tempId: item.tempId, id: candId, action: item.action, outcome: 'rejected', reason });
            continue;
          }

          let nextImage = existing.image || '';
          if (item.pendingMedia) {
            const fileName = `${existing.id}.${item.pendingMedia.ext}`;
            await saveMedia(fileName, item.pendingMedia.buffer);
            nextImage = `/media/${fileName}`;
          } else if (cand.image && isSafeImageRef(cand.image) && SAFE_LOCAL_IMAGE_RE.test(cand.image)) {
            nextImage = cand.image;
          }

          const merged = {
            ...existing,
            title: cand.title || existing.title,
            maker: cand.maker !== undefined ? cand.maker : existing.maker,
            origin: cand.origin !== undefined ? cand.origin : existing.origin,
            era: cand.era !== undefined ? cand.era : existing.era,
            category: VALID_CATEGORIES.has(cand.category) ? cand.category : existing.category,
            price: cand.price,
            quantity: cand.quantity,
            status: cand.status,
            lede: cand.lede !== undefined && cand.lede !== '' ? cand.lede : existing.lede,
            body: Array.isArray(cand.body) && cand.body.length ? cand.body : existing.body,
            specs: Array.isArray(cand.specs) && cand.specs.length ? cand.specs : existing.specs,
            instagramUrl: cand.instagramUrl || existing.instagramUrl,
            instagramShortcode: cand.instagramShortcode || existing.instagramShortcode,
            image: nextImage,
            updatedAt: nowIso
          };

          const normalized = store.normalizeProduct(merged, existing);
          if (!SAFE_LOCAL_IMAGE_RE.test(normalized.image)) {
            throw new Error('Unsafe resulting image path');
          }
          products[existingIdx] = normalized;
          batchSeenIds.add(existing.id.toLowerCase());
          if (normalized.instagramShortcode) {
            batchSeenShortcodes.add(normalized.instagramShortcode.toLowerCase());
          }
          updated += 1;
          logItems.push({ tempId: item.tempId, id: normalized.id, action: 'update', outcome: 'updated' });
        } else {
          let nextImage = '';
          if (item.pendingMedia) {
            const fileName = `${candId}.${item.pendingMedia.ext}`;
            await saveMedia(fileName, item.pendingMedia.buffer);
            nextImage = `/media/${fileName}`;
          } else if (cand.image && isSafeImageRef(cand.image) && SAFE_LOCAL_IMAGE_RE.test(cand.image)) {
            nextImage = cand.image;
          }

          const normalized = store.normalizeProduct({
            id: candId,
            title: cand.title,
            maker: cand.maker || '',
            origin: cand.origin || '',
            era: cand.era || '',
            category: cand.category,
            price: cand.price,
            quantity: cand.quantity,
            status: cand.status,
            added: cand.added || nowIso.slice(0, 10),
            image: nextImage,
            instagramUrl: cand.instagramUrl || '',
            instagramShortcode: cand.instagramShortcode || '',
            lede: cand.lede || '',
            body: Array.isArray(cand.body) ? cand.body : [],
            specs: Array.isArray(cand.specs) ? cand.specs : [],
            updatedAt: nowIso
          });

          if (!SAFE_LOCAL_IMAGE_RE.test(normalized.image)) {
            throw new Error('Unsafe resulting image path');
          }

          const newIdx = products.length;
          products.push(normalized);
          byId.set(normalized.id.toLowerCase(), newIdx);
          if (normalized.instagramShortcode) {
            byShortcode.set(normalized.instagramShortcode.toLowerCase(), newIdx);
          }
          batchSeenIds.add(normalized.id.toLowerCase());
          if (normalized.instagramShortcode) {
            batchSeenShortcodes.add(normalized.instagramShortcode.toLowerCase());
          }
          created += 1;
          logItems.push({ tempId: item.tempId, id: normalized.id, action: 'create', outcome: 'created' });
        }
      } catch (err) {
        const reason = err.message || 'Failed to persist item';
        rejected += 1;
        errors.push({ tempId: item.tempId, id: candId, reason });
        logItems.push({ tempId: item.tempId, id: candId, action: item.action, outcome: 'rejected', reason });
      }
    }

    catalog.products = products;
    if (!importLogs || typeof importLogs !== 'object') {
      importLogs = { version: 1, logs: [] };
    }
    if (!Array.isArray(importLogs.logs)) {
      importLogs.logs = [];
    }
    importLogs.logs.push({
      id: `imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: nowIso,
      created,
      updated,
      rejected,
      items: logItems
    });

    const saveCatalog = created > 0 || updated > 0;
    return {
      saveCatalog,
      saveImportLogs: true,
      result: {
        created,
        updated,
        rejected,
        errors,
        products: saveCatalog ? products.map(p => store.normalizeProduct(p)) : products
      }
    };
  });
}

module.exports = {
  VALID_CATEGORIES,
  VALID_STATUSES,
  INSTAGRAM_HOSTS,
  SAFE_LOCAL_IMAGE_RE,
  SsrfBlockedError,
  getAllowHosts,
  isBlockedIp,
  isBlockedIpv4,
  isBlockedIpv6,
  assertSafeUrl,
  safeFetch,
  detectImageFormat,
  decodeDataUriImage,
  extractInstagramPostFromHtml,
  parseRetromodCaption,
  parseCsvText,
  parseExportPayload,
  splitCaptionBlocks,
  previewImport,
  commitImport
};
