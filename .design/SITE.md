# Project Vision

> **AGENT INSTRUCTION:** Read this file before every iteration. It is the project's long-term memory.

## 1. Core Identity

| Field | Value |
|-------|-------|
| **Project Name** | RETROMOD. (@retromod.za) |
| **Mission** | Show and sell the pieces currently on the floor — mid-century furniture, lighting, art, vintage Hi-Fi and cameras — and drive enquiries to Instagram DM. |
| **Target Audience** | Johannesburg & nationwide collectors, interior designers, Hi-Fi enthusiasts; also people looking to sell pieces. |
| **Voice & Tone** | Confident, editorial, knowledgeable, warm. Short declarative lines. Captions in caps for product titles (mirrors Instagram). |
| **Region** | South Africa — ZAR prices formatted `R3 850`, British/SA spelling. |

## 2. Facts (source: instagram.com/retromod.za, read 2026-11-17)

- Bio: "Mid-Century Modern & Beyond. Furniture • Art • Audio. Nationwide Shipping | Norwood, Johannesburg. Buyers And Sellers."
- Address: **66 Grant Avenue, Corner Nellie Road, Norwood, Johannesburg 2192**
- 55.3K followers, 471 posts
- WhatsApp community: chat.whatsapp.com/Fc2Pa0RQa6AKQJOeZNpmgM
- Purchase flow: "Kindly send @retromod.za a DM if you wish to purchase."
- Hours: not published — say "DM for viewing times". Do not invent.

## 3. Visual Language

- **Primary Vibe**: Full-white editorial gallery (Swiss grid, hairlines, ink on paper)
- **Secondary Vibe**: Warm collector's showroom — real product photography carries the colour
- **Anti-Vibes**: No clutter over photos, no fake stock imagery presented as products, no loud colour

## 4. Technical Setup

- **Output Directory**: `site/public/` (served by `npm start` → `server.js`)
- **CSS**: Shared hand-written CSS (`assets/css/site.css`) on the 1440u artboard unit system carried over from the original landing page. Tailwind intentionally not used — the existing design system is custom and must stay consistent.
- **Data**: `assets/js/products.js` — single source of truth for stock. Add a product = add one object.
- **Dark Mode**: No (white editorial brand)
- **Fonts**: Inter Tight + Archivo (wdth axis) via Google Fonts

## 5. Live Sitemap

- [x] `index.html` — Home: clean hero carousel of stock, on-the-floor grid, anatomy scroll, manifesto, trust
- [x] `shop.html` — All stock with category filter, sort, search
- [x] `product.html?id=` — Product detail rendered from products.js
- [x] `about.html` — Story, what we deal in, buying & selling, process
- [x] `contact.html` — Visit, DM, WhatsApp, map, enquiry composer

## 6. Roadmap (Backlog)

### Medium Priority
- [x] Real product photos for all 5 stock pieces in `assets/stock/`
- [ ] Add remaining Instagram stock (needs logged-in access or a list from the owner)

### Ideas to Explore
- [ ] `sold.html` — archive of sold pieces (social proof)
- [ ] `sell.html` — dedicated "sell to us" submission page

## 7. Rules of Engagement

1. Do NOT recreate pages already marked `[x]` in Section 5
2. ALWAYS update `.design/next-prompt.md` before completing an iteration
3. Header/footer markup is copied verbatim from `index.html`
4. All internal links must point to real pages
5. Never invent prices, hours or phone numbers
