# Homepage beta strip + `/beta` explainer page

**Date:** 2026-06-22
**Status:** Approved design, pending implementation plan

## Goal

Give the marketing homepage a professional, marketing-grade beta signal (replacing
the look of the small in-app `BetaBadge` pill), and add a dedicated `/beta` page that
explains what "public beta" means and shows a qualitative Now / Next / Later roadmap.

This is also the **first marketing route beyond `/homepage`**, so it should establish a
repeatable pattern for adding SEO-friendly marketing pages later.

## Context (existing architecture)

- The marketing homepage is a **standalone multi-page-build entry**, not part of the SPA:
  - `homepage.html` (repo root) → `src/homepage-main.tsx` → `src/pages/Homepage/Homepage.tsx`
  - Registered in `vite.config.ts` under `build.rolldownOptions.input` as `homepage`.
  - Styled with its own `aq-` design system in `src/pages/Homepage/homepage.css`
    (gold accents, Fraunces display font, dark/light theme).
- The **`aquilla-web` worker** (`worker/index.ts`) routes:
  - `/homepage` → always `homepage.html`
  - `/` → `homepage.html` (no `aq_hint` cookie) or `index.html` (signed in)
  - everything else → `env.ASSETS.fetch` (SPA fallback → `index.html`, React Router)
- The in-app **`BetaBadge`** (`src/components/BetaBadge.tsx`) is a violet→pink gradient
  pill gated behind `VITE_BETA_FLAG`, opening a dialog ("things might break", Discord link).
  We are NOT changing this component — the homepage gets its own marketing-grade treatment.

## Scope

**In scope**
1. A new standalone `/beta` marketing page (own MPA entry + worker route + vite input).
2. A slim, dismissible beta strip above the homepage nav linking to `/beta`.
3. A small shared hook extraction for theme + font loading reused by both pages.
4. Tests for the worker route, the page render, and the strip.

**Out of scope (flagged for later)**
- The `/1/` (v1) prefix for protected app routes. That is a much larger change
  (React Router `basename`, every internal link, auth redirects, worker root logic)
  and is explicitly NOT part of this work.
- A generalized marketing-site framework/CMS. We add pages one at a time with the
  established recipe (entry + worker line); we do not build a generic abstraction yet.

## Design

### 1. New `/beta` page — standalone marketing entry

Mirror the `/homepage` recipe exactly so the page is a real, statically-served HTML
document (good for SEO and crawlers; no SPA/auth dependency):

- **`beta.html`** (repo root) — copy of `homepage.html` with:
  - Its own `<title>` / `<meta name="description">` for SEO (beta-specific copy).
    Reuse the `%BRAND_*%` placeholder mechanism where the brand HTML transform applies;
    verify the brand vite plugin processes `beta.html` (it transforms html entries) —
    if it only targets `index.html`/`homepage.html`, extend it to include `beta.html`.
  - The same inline pre-paint theme script (reads `aq-home-theme` from sessionStorage).
  - A pre-hydration hero (`.aq-pre`) with beta-appropriate copy for no-JS / crawlers.
  - `<script type="module" src="/src/beta-main.tsx">`.
- **`src/beta-main.tsx`** — copy of `homepage-main.tsx`, mounting `<BetaPage/>` inside
  `BrandProvider`, applying theme + brand title.
- **`src/pages/Beta/BetaPage.tsx`** — the page component, reusing `homepage.css`
  (`import "../Homepage/homepage.css"`) so it is visually one site.
- **`vite.config.ts`** — add `beta: path.resolve(__dirname, "beta.html")` to
  `build.rolldownOptions.input`.

**Recipe for future marketing pages:** new page = new `*.html` entry + `*-main.tsx` +
page component + one `vite.config.ts` input line + one `STATIC_PAGES` worker line.

### 2. Worker routing

Generalize the single `/homepage` special-case into a small static-page map so each new
marketing page is a one-line addition, and `/beta` is served as its own document rather
than falling through to the SPA (which would rewrite it to `index.html` and 404):

```ts
const STATIC_PAGES: Record<string, string> = {
  "/homepage": "/homepage.html",
  "/beta": "/beta.html",
}
// in fetch():
const staticTarget = STATIC_PAGES[url.pathname]
if (staticTarget) {
  return env.ASSETS.fetch(new URL(staticTarget, req.url).toString())
}
```

The root (`/`) cookie logic and the final `env.ASSETS.fetch(req)` SPA fallback are
unchanged. Behavior for `/homepage` is identical to today.

### 3. `BetaPage` content

Marketing-grade, drafted from features the product already ships and the homepage
already claims (so the page never contradicts the homepage).

- **Hero** — "Aquilla is in public beta." with a confident, mission-framed subhead and
  primary CTAs (Start free → `/onboarding`, Back to homepage → `/homepage`).
- **What "beta" means** — a marketing rewrite of the in-app `BetaBadge` copy:
  - It's free for everyone, today.
  - The product is actively evolving; things may move, improve, or occasionally break.
  - User feedback directly steers what ships next → Discord CTA
    (`https://discord.gg/T2EndwXe4W`, the same link the in-app badge uses).
- **Roadmap — Now / Next / Later** (qualitative, no dates):
  - **Now** — text & audio translation; video captions & subtitles; **low-resource
    language drafting** (a core strength, not a future item); real-time guidance &
    back-translation; Living Memory; confidence/health you can see; cloud sync &
    collaboration; on-device speech.
  - **Next** — image translation; oral-story translation; richer terminology tooling;
    deeper in-flow AI assistance.
  - **Later** — deeper automations & integrations.
  - This split matches the homepage's modality treatment (video shown as available;
    images and oral stories shown as "soon").
- **Closing CTA band** — Start free · Join Discord · Back to homepage.

### 4. Homepage slim top strip

A persistent, **dismissible** bar rendered above `<nav>` in `Homepage.tsx`:

- Copy: *"Aquilla is in public beta — see what's shipping and what's next →"*,
  the whole bar (or its trailing link) navigating to `/beta`.
- A `×` dismiss button. Dismissal is remembered in `sessionStorage`
  (same storage mechanism as the existing `aq-home-theme` toggle; key e.g.
  `aq-betabar-dismissed`). Read on mount so it stays hidden for the session.
- Non-sticky: it sits at the very top and scrolls away; the existing nav remains sticky
  (verify against `.aq-nav` positioning in `homepage.css`).
- New `.aq-betabar` styles added to `homepage.css`, using existing design tokens
  (`--aq-gold`, `--aq-line`, etc.) and respecting dark/light themes.

### 5. Shared chrome extraction (small, justified)

Both marketing pages need (a) the theme state — initial read, OS-follow until the visitor
toggles, sessionStorage persistence — and (b) the Fraunces/Noto font loader. Extract these
~25 lines from `Homepage.tsx` into a small shared module:

- **`src/pages/Homepage/useMarketingShell.ts`** (or similar) exporting a hook that returns
  `{ theme, toggleTheme }` and runs the font-loading effect.
- Refactor `Homepage.tsx` to consume it (behavior-preserving — existing homepage tests
  must still pass).
- `BetaPage.tsx` consumes the same hook.

`BetaPage` gets its **own lightweight nav** (brand · "Home" link → `/homepage` ·
theme toggle · "Start free") and reuses the existing footer markup. We do **not**
restructure `Homepage`'s nav/footer into shared components in this pass (kept surgical).

### 6. Tests (intent-encoding)

- **Worker** (`worker/index.test.ts`): `/beta` serves `beta.html`; `/homepage` still
  serves `homepage.html` (no regression); an unknown path still hits the SPA fallback.
  *Why:* `/beta` must be a real document, not SPA-rewritten to `index.html`.
- **`BetaPage`** render test: hero heading present; all three roadmap phases
  ("Now"/"Next"/"Later") render with their items; Discord + Start-free CTAs present.
  *Why:* the page's purpose is to communicate beta status and the roadmap.
- **Homepage strip** test: the `/beta` link renders; clicking dismiss hides the strip and
  sets the sessionStorage flag; a pre-set flag keeps it hidden on mount.
  *Why:* the strip must be reachable and must stay dismissed for the session.

## Open verification items (resolve during implementation)

1. Confirm the brand HTML transform (vite plugin replacing `%BRAND_*%`) applies to
   `beta.html`; extend it if it's entry-specific.
2. Confirm `.aq-nav` sticky behavior so the strip scrolls away cleanly above it.
3. Confirm video captions/subtitles are correctly placed in **Now** (homepage presents
   video as available) — adjust the roadmap if product reality differs.
