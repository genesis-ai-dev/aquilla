# Org & Account Surfaces — Design Language

Locked reference for the UI refinement of the organization and account surfaces
(Overview, Teams, Members, Settings, Preferences). The **Org Settings** page
(`src/pages/Settings.tsx`) is the built, verified reference implementation of
this language. Every other surface should read as the same product.

Goal (user's words): make these surfaces feel **deliberate, clean, well
organized, intuitive, and thoughtful**. This is a *craft + consistency* pass,
not a re-theme. The existing design system is strong — we unify how surfaces
*use* it.

## Calibration (these are admin/settings surfaces — calm, not flashy)

- **Design variance: ~3** — predictable, aligned, structured. No artsy
  asymmetry, no masonry, no bento on these surfaces.
- **Motion: ~3** — CSS transitions on interactive states only. A skeleton while
  loading. **No** entrance choreography, no framer-motion (not installed — do
  not add it), no perpetual animation.
- **Density: 4** — daily-app spacing. Generous but not airy.

## The stack (do not fight it)

- Tailwind **v4**, configured inline via `@theme` in `src/index.css`. No
  `tailwind.config`. Use v4 syntax.
- Font: **Geist Variable**. Headings use `font-heading` (which maps to the same
  Geist). No serif. No Inter.
- Primitives: **Base UI + CVA** wrappers in `src/components/ui/`. Icons:
  **lucide-react**, default `size-4`.
- **Flat "Linear" elevation**: in-page surfaces carry **no shadow**; depth comes
  from stepped lightness + borders. Shadows are reserved for floating layers
  (popovers/dialogs) via `--shadow-soft-*`. Do not add `shadow-*` to cards.
- Single muted-blue accent (`--primary`). **No purple, no glows, no gradient
  text.** Desaturated, high-contrast neutrals.

## ⚠️ The dark-mode border rule (most important constraint)

In **dark mode**, `--card`, `--surface`, and `--background` resolve to the
**same** color. A borderless `neu-raised` card is therefore **invisible** on
these pages. **Every card/section/tile MUST carry an explicit `border`** for
separation in both themes. This is why the shared primitives below all include
`border`. Verified in the browser on the reference surface.

## Shared primitives — `@/components/ui/page`

Import these instead of hand-rolling headers and `rounded-lg border bg-card`
blocks. (`src/components/ui/page.tsx`.)

| Primitive | Use for |
|-----------|---------|
| `<Page size="default\|wide\|full">` | Scroll container + centered width well. `default` = max-w-3xl (forms/settings). `wide` = max-w-6xl (lists/grids: Overview, Members, Teams). |
| `<PageHeader title description actions>` | The one heading shape every surface opens with. |
| `<Section title description action footer>` | Titled bordered card. The replacement for hand-rolled sections. |
| `<StatTile label value hint>` | At-a-glance metric. Numbers render `tabular-nums`. |
| `<EmptyState icon title description action>` | Composed empty state (dashed border) — never a bare "No items." |

Reference usage: see `src/pages/Settings.tsx` and
`src/components/settings/OrgProviderSection.tsx`.

## Type & rhythm

- **h1 (page title)**: `font-heading text-xl font-semibold tracking-tight` (in `PageHeader`).
- **h2 (section title)**: `font-heading text-base font-medium` (in `Section`).
- **Description**: `text-sm text-muted-foreground` (one level up from the old `text-xs`).
- **Helper / caption under a control**: `text-xs text-muted-foreground`.
- **Numbers/metrics**: `tabular-nums`, weight `font-semibold` (not `font-bold` — control hierarchy with weight + color, don't shout).
- **Section spacing**: wrap sections in `space-y-6`.
- Hierarchy comes from weight and color, not oversized type.

## Interactive states (always provide all four)

- **Loading**: skeleton blocks matching the real layout (`animate-pulse rounded-lg border bg-card`), not a centered spinner.
- **Empty**: `<EmptyState>` with a one-line "how to populate this."
- **Error**: inline `text-xs text-destructive` near the control.
- **Saved/success**: `text-xs text-green-600 dark:text-green-400` with a lucide `<Check className="size-3.5" />`. **Preserve existing `data-testid`s** (e.g. `export-role-saved`, `org-key-saved`).
- **Tactile**: rely on the existing Button `:active` translate. Don't add custom press effects.

## Hard rules for every surface

1. **Behavior-preserving.** Do not change data hooks, API calls, role gates, or
   permission logic. This is presentation only. Keep every `data-testid`,
   `aria-*`, `role`, and `htmlFor` wiring intact.
2. **Use the primitives.** Prefer `Section` / `StatTile` / `Card` over ad-hoc
   bordered surfaces.
3. **Radius `rounded-lg`** for cards/sections/tiles (matches the canonical
   `Card` and the app `--radius` token). Not `rounded-2xl`.
4. **Terminology**: obey `docs/UI-GLOSSARY.md` (lint-guarded by
   `src/components/ui-jargon-guard.test.ts`). Never surface internal IDs
   (FRO-…, AD-…) in UI copy.
5. **No new dependencies.** No framer-motion, no icon-library swap.
6. **Match existing scroll/layout**: render inside `AppShell` with `OrgSidebar`
   + `OrgBreadcrumb`; the `Page` primitive owns the scroll container.
7. **Verify in light AND dark** before claiming done (the border rule makes dark
   the failure case).
8. Microcopy: tighten verbose copy where it clearly helps, but **keep
   functional caveats** (e.g. the "client-side formats can't be enforced"
   note). Concrete verbs; no "Elevate/Seamless/Unleash" filler.

## Per-surface notes (moderate-restructure scope, user-approved)

- **Overview** (`src/components/org/OrgHome.tsx`) — `Page size="wide"`. Unify the
  rollup cards (Workload/Usage/Credits) onto `StatTile`/`Section`. Real
  `EmptyState` for the no-projects case. Keep the lens/status filters; just make
  the controls row tidy and aligned.
- **Teams** (`TeamsList.tsx`, `TeamDetail.tsx`) — list: `Page size="wide"`, team
  cards on a consistent grid with `EmptyState`. Detail: `Section`s for
  Members / Projects; keep the role pickers and gates exactly.
- **Members** (`src/pages/MembersPage.tsx`) — `Page size="wide"`. Wrap the
  invite, roster, pending-invites, and external-collaborators blocks in
  `Section`s. This is the densest surface — prioritize legible grouping.
- **Preferences** (`src/pages/Preferences.tsx`) — `Page size="default"`. Convert
  every block to `Section`. **Add an "Appearance" Section** surfacing the
  existing theme + color-theme controls (`src/branding/ThemeMode.tsx`,
  `ColorTheme.tsx`) — they exist but aren't reachable here today. Apply the same
  `Section` treatment to `PersonalProviderSection` and `UsageSection`.
- **Settings** (`src/pages/Settings.tsx`) — DONE (reference).

## Definition of done (per surface)

- `npx tsc --noEmit -p tsconfig.app.json` clean.
- Existing tests for the surface pass (`npx vitest run <file>`); jargon guard passes.
- Rendered + screenshotted in **light and dark**, console clean.
- No change to behavior/permissions; testids intact.
