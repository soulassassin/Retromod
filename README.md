# RETROMOD. (`@retromod.za`)

E-commerce storefront and assisted Instagram stock management platform for **RETROMOD.** (66 Grant Avenue, Norwood, Johannesburg).

## Requirements

- **Node.js `>=18`** (zero external npm runtime dependencies)

## Architecture

- **`server.js`**: Zero-dependency HTTP server serving `/api/*`, `/media/*` (uploaded/imported images from `RETROMOD_DATA_DIR/media`), dynamic `/assets/js/products.js`, and static storefront pages under `site/public/` with clean URLs and security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`).
- **`lib/store.js`**: File-backed atomic JSON store (`catalog.json`, `orders.json`, `import-logs.json`) serialized by a per-directory async mutex and written via temp-file + rename. Auto-seeds from `data/seed-catalog.json` when `catalog.json` does not exist.
- **`lib/http.js` & `lib/routes/`**: Modular JSON helpers and route handlers (`public.js`, `orders.js`, `admin.js`).
- **`site/public/`**: Swiss editorial gallery frontend (`index.html`, `shop.html`, `product.html`, `about.html`, `contact.html`) and local `@retromod.za` product photos under `site/public/assets/stock/`.

## Local Development & Startup

```bash
cp .env.example .env.local
npm start
```

If port `3000` is already in use locally, override `PORT`:

```bash
PORT=4101 npm start
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port bound by `server.js` |
| `RETROMOD_DATA_DIR` | `./data` | Directory for `catalog.json`, `orders.json`, `import-logs.json`, and `media/` |
| `RETROMOD_ADMIN_PASSWORD` | — | Admin password for `/admin` authentication |
| `RETROMOD_SESSION_SECRET` | — | Optional HMAC signing secret for `retromod_admin` cookies |

## Scripts

- `npm start` / `npm run dev` — Start `node server.js`
- `npm run build` — Syntax-check all JS files, validate `data/seed-catalog.json`, verify all seeded product images exist, and ensure `_frame.html` is excluded from `site/public/`
- `npm run lint` — Syntax-check JS, parse JSON configs, and reject expiring `scontent-` / `cdninstagram.com` URLs in `data/` and `site/public/`
- `npm test` / `npm run test:unit` — Run unit tests under `tests/unit/` via `node --test`

## API Routes

- `GET|HEAD /api/health` — Server health and catalog product count
- `GET|HEAD /api/products` — Catalog metadata, category/stock stats, and product list (supports `?category=`, `?q=`, `?status=`)
- `GET|HEAD /api/products/:id` — Single product record (`404` if missing)
- `/api/orders/*` — Order capture & receipt endpoints (stubbed `501` in M1; implemented in M2)
- `/api/admin/*` — Admin inventory & Instagram import endpoints (stubbed `501` in M1; implemented in M3)

## Deployment Notes

`vercel.json` configures static preview hosting for `site/public/` (`cleanUrls: true` + security headers), which does **not** run `server.js` or persist writes to `RETROMOD_DATA_DIR`. Full live e-commerce orders, `/api/*` routes, and Instagram stock imports require running `node server.js` (`npm start`) on a persistent Node.js host with persistent disk storage for `RETROMOD_DATA_DIR`.
