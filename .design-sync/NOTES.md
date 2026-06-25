# design-sync notes — Aquilla Design System (codex-web-app)

This repo is the Aquilla SPA, not a published component library. The synced design
system is `src/components/ui/` — 23 shadcn-style files exporting 96 components
(primaries + compound parts) built on `@base-ui/react` + Tailwind v4 + CVA + lucide.

## Setup quirks (package shape, synth-entry mode)

- **No build entry**: `package.json` has no `main`/`module`/`exports`, so the converter
  runs in **synth-entry mode** — it bundles the raw `src/components/ui/*.tsx` files
  directly. `cfg.srcDir = src/components/ui` constrains discovery to just those 23
  files (the repo has ~299 components total; without this it would scan everything).
- **Self-symlink required**: the converter resolves the package at
  `node_modules/<pkg>`, which doesn't exist for a self-package. `buildCmd`/setup must
  recreate `ln -sfn "$PWD" node_modules/codex-web-app` (gitignored; per-clone setup).
  It only reads that dir's package.json + walks srcDir — no recursion risk.
- **`@/` path alias**: `cfg.tsconfig = ./tsconfig.json` wires esbuild's paths plugin so
  `@/lib/utils`, `@/components/ui/*` resolve in both the bundle and previews.
- **Preview import specifier**: previews import from `'codex-web-app'` (the pkg name),
  which the story-imports shim maps to `window.AquillaUI`.

## CSS / tokens (Tailwind v4 — the important one)

- Tailwind utilities only exist AFTER compilation. Raw `src/index.css` has tokens but
  no compiled utility classes, so component CSS MUST come from the **compiled app
  build**: `dist/assets/BrandProvider-*.css` (~162KB, carries both `:where(:root)`
  tokens and the `.bg-primary` etc. utilities the ui/ components use).
- `cfg.cssEntry = .design-sync/.cache/compiled.css` — a stable copy. `buildCmd` re-copies
  the freshest `BrandProvider-*.css` after each `vite build` (the file is hash-named).
- **Default brand = Aquilla**, tokens live in `:where(:root)` (zero specificity) so
  rendered designs pick them up. `html.dark` carries the dark theme.

## Fonts

- Brand `--font-sans` is **Geist Variable** (`@fontsource-variable/geist`).
- `cfg.extraFonts` points at the fontsource `index.css`; the build copies its 3 woff2
  (latin/latin-ext/cyrillic) into `fonts/` with working `./` urls. The app build's
  `/assets/geist-*.woff2` refs are dead duplicates in fonts.css but harmless (the `./`
  variants satisfy the @font-face). No FONT_DANGLING after this.

## Grouping (libOverride)

- Config keys are strictly validated — there's **no group knob**. Grouping into the 5
  functional groups (Actions/Forms/Overlays/Layout/Feedback) is done by a fork:
  `.design-sync/overrides/source-kit.mjs` (declared in `cfg.libOverrides`). The GROUPS
  map is hardcoded in the fork. Its sibling lib imports are repointed at
  `../../.ds-sync/lib/`; it imports `ts-morph` (bare) so it needs the
  `.design-sync/node_modules -> ../.ds-sync/node_modules` symlink (per-clone).

## .d.ts (synth-entry weakness)

- Synth-entry can't resolve CVA `VariantProps` + base-ui prop chains → emitted props
  default to `[key: string]: unknown` (permissive but not guiding). For the scoped
  primaries, real prop contracts are hand-written in `cfg.dtsPropsFor` so the design
  agent codes against the true API (Button variant/size, Input, Field, etc.).

## Re-sync risks (watch-list)

- **compiled.css is build-derived**: if `dist/` is stale or from a non-Aquilla BRAND,
  the tokens ship wrong. Always run `buildCmd` (vite build, default BRAND=aquilla) and
  re-copy before converting. The gitignored `.cache/compiled.css` is NOT the source of
  truth — the fresh `dist/assets/BrandProvider-*.css` is.
- **dtsPropsFor is hand-maintained** and tied to upstream source. If a ui/ component's
  variants change (e.g. button.tsx gains a variant), the dtsPropsFor body goes stale —
  re-derive from source on a re-sync.
- **source-kit.mjs fork** must be diffed against the bundled lib on re-sync (skill says
  so) and merged if upstream changed. Group prefixes assume current component names.
- **Self-symlink + fork symlink** are gitignored — recreate both on a fresh clone.
- Previews use Aquilla-domain content (Bible translation: Gospel of Mark, Tok Pisin,
  verse refs). Realistic, not placeholder.

## Known render warns (triaged legitimate)

- Unauthored components show the typographic floor card (RENDER_BLANK/RENDER_THIN on
  Badge/Spinner/Card-parts/etc. before authoring) — these are NOT failures, just
  unauthored. They clear as previews are authored.
