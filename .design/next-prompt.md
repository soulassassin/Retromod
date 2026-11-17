---
page: _complete
---
Consistency loop complete (2026-11-17).

**This loop:**
1. admin — tabs now switch panels (were scroll-only, all three rendered at once); order cards redesigned (badge, human labels, total, inline status controls, two-step cancel); order search + per-status counts; inventory Save quiet until edited; duplicate import-mode select removed; phone header/toolbar fixed.
2. checkout + cart — legend/divider fix, auto-numbered sections, empty error rows collapse, summary first on narrow screens, copy fixes; drawer slides in (360ms drawer curve) / out (220ms), interruptible; bag count bumps on add.
3. Emil pass — reveal transition no longer hijacks card hover (900ms → 250ms); shop filter re-renders are 150ms (chips/sort) or instant (search); filter chips/choice cards/qty buttons get press feedback; nav indicator 380 → 240ms; shared page-hero spacing and Instagram tile moved into site.css.

**Ideas if the loop restarts:** `sold.html` (sold archive), `sell.html` (sell-to-us submission), order email/WhatsApp notifications.
