# EHR Design System — tokens & guide

Current version: **v1.2.0** (user-refined, 2026-10-05).
Source: the three "Ehr." dashboard screenshots (`~/Desktop/EMR screenshots/EHR./`).
Machine-readable source of truth: [`tokens.json`](./tokens.json) — **this file is the
human guide; both must be updated together.**

> **How to keep this current:** whenever the design changes, update `tokens.json`
> and the relevant section below, then append a dated entry to the
> [Change log](#change-log) describing what changed and confirming the new
> direction. Sampled colors were extracted by pixel-sampling; entries marked
> *(estimated)* need confirmation against the design source.

## Character

A calm, light medical dashboard: gray canvas, white rounded cards, **one vivid
blue** for anything alive (events, actions, active state) and **one dark
charcoal** for weight (active nav, focus cards, measurement cards). Everything
round — circles for actions, pills for nav, 20–28px corners for cards. Thin
1.5px line icons never appear bare; they sit inside circles. Hierarchy comes
from size and lightness, never from bold shouting.

## Color (15 tokens)

| Token | Value | Role |
|---|---|---|
| `color.canvas` | `#FFFFFF` *(v1.1.0)* | Page backdrop around the app surface |
| `color.surface` | `#EDEDED` *(v1.2.0 — was #E8E8E8)* | App background (darker than the canvas) |
| `color.card` | `#FFFFFF` *(sampled)* | All cards, nav pills (inactive), nodes |
| `color.accent` | `#0A89FF` *(v1.1.0 — was #0067FF)* | Events, icon circles, FABs, connectors, badges, sparklines |
| `color.onAccent` | `#FFFFFF` | Text/icons on accent |
| `color.darkSurface` | `#4A4D51` *(sampled ≈ #4F4F4F/#525152)* | Active nav pills, year rail, dark FABs |
| `color.darkSurfaceGlass` | `#3F444B` *(sampled #4A5258 over blue — glass/gradient)* | Focus card (Coronary Artery Disease) |
| `color.text.primary` | `#17181A` | Titles, names |
| `color.text.muted` | `#565F6C` *(v1.2.0 — was #9EA2A8)* | Subtitles, placeholders — now a proper slate |
| `color.text.faint` | `#C7CACD` *(estimated)* | De-emphasized meta |
| `color.dot` | `#D1D1D1` *(v1.2.0 — was #E7E7E9)* | Idle timeline dots |
| `color.hatch` | `#EFEEF1` *(sampled)* | Diagonal hatch bands behind sparklines |
| `color.overlay` | `rgba(38,41,46,0.45)` | Loading/scrub overlay panels |
| `color.skeleton` | `rgba(255,255,255,0.60)` | Skeleton bars inside overlays |
| `color.connector` | `#0067FF` @ 55% | 1.5px bezier curves linking nodes → timeline |

Proportions to keep it calm: ~60% surface/canvas, ~25% white cards, ~10%
accent, ~5% dark. Blue is never body text — text stays ink; blue carries
state.

### Choice & true/false colors (3 new tokens, v1.2.0)

Multiple-choice options use **Google brand hues, tone-matched** to our
accent's vibrancy; the shape on each option (▲◆●■) keeps them distinguishable
so color never speaks alone:

| Token | Value | Used for |
|---|---|---|
| `color.choice.blue` | `#0A89FF` | Option 1 circle — same as accent |
| `color.choice.red` | `#EA4335` | Option 2 circle; **False** button |
| `color.choice.yellow` | `#FBBC05` | Option 3 circle — **ink icon** (white fails on yellow) |
| `color.choice.green` | `#34A853` | Option 4 circle; **True** button |

True = green, False = red, white large letter-spaced labels (passes AA-large:
3.1:1 and 3.9:1).

## Typography (13 tokens)

Family: **Questrial** *(v1.1.0 — was Poppins)*, fallbacks
`Poppins, 'Century Gothic', Futura, system-ui`. Watch-out: Questrial ships a
single 400 weight — the 300 "light" for big numbers is synthesized or renders
as regular.

| Token | Value | Used for |
|---|---|---|
| `weight.light` | 300 | Big numbers (47, 74) — synthesized under Questrial |
| `weight.regular` | 400 | Display + body — **never bold headings** |
| `weight.medium` | 500 | Wordmark ("Ehr."), emphasis — synthesized under Questrial |
| `size.display` | 46px / 1.1 *(v1.1.0 — was 44)* | Page titles ("Overview Patient Health") |
| `size.number` | 38px *(v1.1.0 — was 40)* | Metrics on dark measurement cards |
| `size.title` | 28px *(v1.1.0 — was 20)* | Card titles |
| `size.node` | 16px | Timeline node titles |
| `size.body` | 14px / 1.5 | Body, subtitles |
| `size.meta` | 12px | Dates (9.03), units, counts |
| `size.micro` | 11px | Timestamps, tiny labels |

## Radius (5)

`pill/circle 999` · `card 37` *(v1.1.0 — was 24; now the roundest surface)* ·
`cardLg 26` *(v1.1.0 — was 28; note the inversion: cards are rounder than
large cards — kept as chosen)* · `cardSm 20` · `thumb 17` *(v1.1.0 — was 16)*

## Spacing (7)

Base 4px scale: `4 · 8 · 12 · 16 · 24 · 32 · 48` — card padding 16–24, grid
gap 12–16, section gap 24–32.

## Elevation (3)

Soft and rare: `card 0 8px 24px rgba(23,25,28,0.06)` (white cards),
`float 0 4px 12px rgba(23,25,28,0.12)` (white circular buttons), `none` on
blue/dark surfaces. Cards are defined by white-on-gray contrast first,
shadow second.

## Iconography (6)

Thin-line icons (`strokeWidth 1.5`, round caps, `20px`) inside circles:
`circleSm 36` · `circleMd 44` · `circleLg 56`. Container rules: accent-blue
circle + white icon (events); white circle + ink icon + float shadow
(neutral actions); white circle + accent icon (on blue cards); white circle +
dark icon (on dark cards). Count badges: 16px accent circle, white 10px
number, offset top-right.

## Motion (4) *(assumed — stills only)*

`fast 150ms` (hover/press) · `base 220ms` (panels, reveals) ·
`ease cubic-bezier(0.2,0.7,0.3,1)` · `pressScale 0.96`. Connector draw-in on
load; circles lift slightly on hover.

## Components (14 recipes)

1. **Pill nav** — 52px pills: inactive white/muted text; active
   `darkSurface`/white; filter variants allow several dark at once. Search =
   white pill with magnifier.
2. **Feature card (accent)** — `accent` bg, 28px radius, white text; chip =
   white@14% pill ("2 instances"); white 36px circle actions; ↗ circle
   top-right.
3. **Dark info card** — glassy `darkSurfaceGlass`, 28px radius; chip white@12%
   ("Recession period"); white circle ✕ top-right; white circle + bottom-right.
4. **Metric card** — white, 24px radius; icon circle + title + muted subtitle +
   ↗ float; sparkline = 2px accent wave over diagonal `hatch` band, dotted
   cursor, right-aligned value + micro unit.
5. **Timeline** — month labels column; event clusters = overlapping accent
   circles (36–44px) with white icons; idle `dot` 6–8px; year rail = vertical
   `darkSurface` pill with white dots; accent/dark circular +/− zoom.
6. **Node card** — white, 24px radius: icon circle + node title + muted sub +
   date meta right. Variants: medication (dosage), document, imaging
   (thumbnail), lab (sparkline).
7. **Measurement card** — dark, photo full-bleed with scrim; 40px light white
   number + label + micro timestamp ("8.02") + white ↗ circle.
8. **Doctor row** — 44px avatar; specialty (16px) + name (12px muted); 32px
   white count circle (or blue mini-badge).
9. **Count badge** — 16px accent circle, white number, offset on icon circles.
10. **FAB** — 48px circle, `darkSurface` or `accent`.
11. **Loading overlay** — `overlay` panel, 28px radius, white 60% skeleton
    bars (8px, pill radius).
12. **Avatar** — 44px circle.
13. **Thumbnail** — 16px radius photos.
14. **Wordmark** — "Ehr." medium + trailing period (brand signature dot, same
    trick as *Wbasic.* / *You Know?*).

## Do / Don't

- **Do** keep blue for meaning (events, active, actions) — **don't** use it for
  long text.
- **Do** pair icon + label with color (never color alone).
- **Don't** bold headings; scale + lightness carry hierarchy.
- **Don't** introduce sharp corners or heavy shadows.
- Light mode only in the source; a dark theme is **not defined yet** — don't
  invent one ad hoc, add tokens through a change-log entry instead.

## Change log

- **2026-10-05 — v1.2.0 (applied)** — The system is now live in the You Know?
  app as of release **v0.2.3**: `client/styles.css` fully re-tokenized (white
  canvas, gray surface, white cards + soft shadows, accent `#0A89FF`, Google
  choice circles, green/red true-false, Questrial + Poppins + Noto Sans
  Thai/JP self-hosted, radii 37/26/20/17, pill buttons/inputs). **The dark
  theme toggle was removed** — the system is light-only until a dark token
  set is designed (add it here first). Admin is reachable only at `/admin`;
  the home Host card shows server lists only for a verified admin token and
  "Create a quiz" routes to `/admin` when signed out.
- **2026-10-05 — v1.2.0** — Refinement pass: surface `#E8E8E8 → #EDEDED`;
  muted text `#9EA2A8 → #565F6C` (proper slate); dots `#E7E7E9 → #D1D1D1`.
  New choice colors — Google hues at our tone: red `#EA4335`, yellow `#FBBC05`
  (ink icon), green `#34A853`, blue = accent. True/False buttons go green/red.
  UX: **admin accessible only at `/admin`** — home drops the admin gate and
  the "Recorded data" link; admin function unchanged (when applied to the
  real app: home keeps server lists only for a verified admin token, and
  "Create a quiz" redirects to `/admin` when signed out). Tokens 53 → 56.
- **2026-10-05 — v1.1.0** — **User-adjusted baseline** from the preview.html
  test drive; confirmed as the reference going forward. Changes: canvas
  `#EEEEEE → #FFFFFF`, surface `#F5F5F5 → #E8E8E8` (inverted — white canvas,
  gray app surface), accent `#0067FF → #0A89FF`, radius.card `24 → 37`,
  radius.cardLg `28 → 26` (deliberate inversion: regular cards rounder than
  large cards), radius.thumb `16 → 17`, display `44 → 46`, number `40 → 38`,
  title `20 → 28`, font `Poppins → Questrial`. Everything else unchanged.
  Rollback values live in the v1.0.0 entry of `tokens.json`.
- **2026-10-05 — v1.0.0** — Initial extraction from the three EHR screenshots:
  **53 core tokens** across 7 categories (color 15, typography 13, radius 5,
  spacing 7, elevation 3, iconography 6, motion 4) plus **14 component
  recipes**. Colors pixel-sampled with Pillow; font family flagged as
  *estimated* (confirm against design source). No dark mode in source.
