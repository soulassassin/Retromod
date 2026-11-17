# Design System: RETROMOD.

## 1. Visual Theme & Atmosphere

A white editorial gallery. Paper `#FAFAFA`, pure white cards, deep ink `#111111`, 1px architectural hairlines. Photography is the only source of colour, so it is never covered: overlays live in corners or outside the frame. Generous whitespace, wide Archivo display type, tight Inter Tight UI.

## 2. Colour Palette & Roles

| Role | Name | Value | Usage |
|------|------|-------|-------|
| Primary | Ink | `#111111` | Buttons, active nav pill, headings |
| Primary Foreground | White | `#FFFFFF` | Text on ink |
| Background | Paper | `#FAFAFA` | Page background |
| Surface | White | `#FFFFFF` | Cards, header on scroll |
| Surface Alt | Stone | `#F2F2F0` / `#EFECE6` | Image wells, placeholders, stat frames |
| Text Secondary | Muted | `#767676` | Captions, metadata |
| Body | Graphite | `#555555` | Long-form paragraphs |
| Border | Hairline | `rgba(17,17,17,.12)` → `.22` | Dividers, card borders |

## 3. Typography

| Element | Font | Weight | Size (u) | Line Height |
|---------|------|--------|------|-------------|
| Display | Archivo wdth 104% | 640 | 90–120 | .86 |
| Logo | Inter Tight | 800 | 22 | 1, tracking -.045em, trailing period |
| H2 | Archivo wdth 104% | 640 | 46–64 | .92 |
| H3 / card title | Inter Tight | 600 | 15–18 | 1.2 |
| Body | Inter Tight | 500 | 14–16 | 1.5 |
| Eyebrow | Inter Tight caps | 500 | 11 | 1, tracking .14em |

## 4. Component Styles

- **Buttons**: pill, ink fill or 1px hairline ghost. `transition: transform 160ms var(--ease-out)`; `:active` scale(.97); hover lift only under `(hover:hover)`.
- **Cards**: white, 1px hairline, 12u radius, image well 4:5 on stone. Hover: image scale 1.04 (600ms ease-out), arrow nudges.
- **Navigation**: sticky header, logo left, segmented pill centre with sliding ink indicator, "DM to Enquire" right. Mobile: logo + menu button → full-width sheet.
- **Forms**: 48u inputs, 1px hairline, 10u radius, ink focus ring.

## 5. Motion

- `--ease-out: cubic-bezier(.23,1,.32,1)` for enter / UI, `--ease-in-out: cubic-bezier(.77,0,.175,1)` for on-screen movement.
- UI transitions ≤ 250ms; editorial reveals 600–900ms; never animate from scale(0); keyboard actions are instant.
- Reduced motion: keep opacity fades, drop movement.

## 6. Design System Notes for Generation

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, desktop-first on a 1440u artboard (`--u`), phone layout ≤760px on a 390u artboard
- Theme: Light, white editorial gallery, hairline grid
- Background: Paper (#FAFAFA); Surface: White (#FFFFFF); Stone wells (#F2F2F0)
- Primary: Ink (#111111) for buttons, active states, headings
- Text: Ink (#111111), muted (#767676), body (#555555)
- Font: Archivo (wide display) + Inter Tight (UI) via Google Fonts
- Corners: 12u cards, pill buttons, 14u large frames
- Shadows: whisper-soft `0 12u 32u rgba(0,0,0,.04)` only
- Spacing: sections 120–170u vertical, 57u side margin desktop, 16px phone gutter
