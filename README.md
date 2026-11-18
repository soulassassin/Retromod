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
| `SUPABASE_URL` | — | Supabase project URL. With the service key set, it switches to live Supabase mode |
| `SUPABASE_SERVICE_ROLE_KEY` | — | **Secret** server-side key for the database and Storage |
| `SUPABASE_ANON_KEY` | — | Publishable key used for staff sign-in |
| `RETROMOD_ADMIN_PASSWORD` | — | Local-mode shared admin password for `/admin` |
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
- `/api/admin/*` — Staff login/session, inventory (`PATCH`/`DELETE /api/admin/products/:id`), orders, and Instagram import preview/commit
- `GET /api/catalog-script` — Live catalogue as `window.RETROMOD` for storefront pages

## Stock Management (Instagram → Shop)

Sign in at **`/admin`** with your staff email and password.

- **Import tab**: paste one or more `instagram.com/p/…` or `/reel/…` links (one per line) and click **Preview**. The photo, title, ZAR price, maker, era and category are read from the post caption into editable drafts. Fix anything Instagram didn't give us, then **Publish**. The piece appears on the shop immediately and its photo is stored in Supabase Storage (`/media/*`).
- **Stock tab**: edit title, category, price and quantity. Set the status to **Available**, **Reserved** or **Sold**; sold pieces stay on the site with a SOLD tag. **Delete** removes the piece and its imported photo from the site. Click it twice to confirm.
- **Orders tab**: checkout orders, with status updates. Cancelling an order restores its stock.

### Staff logins

Staff accounts use Supabase Auth, and only emails on the `staff` allowlist can open the console. There is no public sign-up.

```bash
npm run staff:add -- name@example.com     # prompts for a password (min 10 chars)
npm run staff:list
npm run staff:remove -- name@example.com
```

## Data & Deployment

| Mode | When | Storage | Admin login |
|---|---|---|---|
| **Live (Supabase)** | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set | Supabase Postgres (`products`, `orders`, `import_logs`, `staff`) + Storage bucket `media` | Staff email + password |
| **Local** | Supabase vars blank | JSON files in `RETROMOD_DATA_DIR` | `RETROMOD_ADMIN_PASSWORD` |

**Vercel**: `api/index.js` runs the same app as `npm start` for every `/api/*` request, and `/media/*` is rewritten to the public Storage bucket. Storefront pages load the live catalogue from `/api/catalog-script`, with `assets/js/products.js` as a static fallback, so imports, edits and deletes show up without a redeploy. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY` in the Vercel project's environment variables.

Every write goes through the `public.apply_changes(jsonb)` Postgres function in a single transaction, with a per-row `rev` optimistic lock. Two simultaneous checkouts can't sell the same one-off piece twice; the loser retries against fresh stock. All tables have RLS enabled with no browser policies, so only the server (service-role key) can read or write.

One-off migration of existing local data (`data/catalog.json`, `orders.json`, `data/media/`): `npm run db:migrate`. It is safe to re-run, because rows already in Supabase are skipped.
