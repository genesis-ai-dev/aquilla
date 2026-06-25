---
name: record-promo-video
description: Build a persona-targeted PROMO trailer (hype/launch reel) — fast cuts, kinetic type, synced score, in 16:9 and 9:16 — via the deterministic scripts/promo pipeline over real captured app footage. Use when asked to "make a promo / trailer / launch video", "hype reel", "social cut", "sizzle", or to produce marketing video for a persona. For a clarity-first how-to use record-docs-video; for the full announce+docs+market loop use distribution-cycle.
---

# Record a promo trailer

Produces a persona-targeted trailer that renders identically every run (a pure function of time — zero dropped frames), over REAL app stills. Output: a 16:9 master + a 9:16 social reformat. Separate from the Playwright "doc" recorder. Full harness docs: `e2e/recordings/README.md` (Promo section). Creative method: `docs/distribution/PROMO-CREATIVE-PROCESS.md`. Umbrella loop: the `distribution-cycle` skill.

## Quick start

```sh
# Capture real hero stills from the live app (boots the stack; reused across personas)
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev \
  npm run promo:capture
npm run promo -- --persona p5-org-admin        # the manager's cut
npm run promo -- --persona p1-field-translator # the translator's cut
npm run promo:all                              # capture, then build default persona
```

## How it works (`scripts/promo/`)
1. `e2e/recordings/specs/promo-capture.showcase.ts` drives the real curated app (marketing login + `@showcase` labels) → hero stills in `output/promo/app/`. Real footage, not mockups.
2. `compose.html` — a self-contained composition exposing `window.__seek(t)`: background, framed device panel (Ken-Burns crossfade of the stills), kinetic type, heartbeat pulse, CTA lockup. Everything derives from `t` (no rAF/CSS-transition state).
3. `render.ts` loads it headless and seek-and-shoots every frame (`__seek(frame/fps)` → screenshot).
4. `synth-audio.ts` code-synthesizes the score (heartbeat + pad + riser + impact) as PCM/WAV — rights-clean, beat-aligned.
5. `build.ts` muxes frames + audio with ffmpeg into the 16:9 master + 9:16 reformat.

`promo.config.ts` is the single source of truth for duration/fps/scenes/beats — edit a number, re-run `npm run promo`.

## Authoring a new persona cut
Only the **brief** changes between cuts; the renderer is shared. Each persona's emotion differs (manager: "Lead the work. Not the chaos." vs translator: "Your words, always kept.").
1. Confirm/add the persona in `docs/distribution/PERSONAS.md`.
2. Author `scripts/promo/briefs/<slug>.brief.json` — throughline, five scenes' copy, musical `mood`, beats. Briefs are written via the sub-agent creative process in `PROMO-CREATIVE-PROCESS.md` (existing: `p1-field-translator`, `p5-org-admin`).
3. `npm run promo -- --persona <slug>` and review.

## Gotchas
- `promo:capture` uses `scripts/e2e-up.ts` + the live app, so the same boot rules as recordings apply: export `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` (→ running `aquilla-dev-pg`) or auth-worker won't boot; the app authenticates via `/__marketing/login`.
- If no app stills exist yet, `compose.html` falls back to a stylized panel so the pipeline always produces something — but ship real stills.
- Don't `git push` while capturing (pre-push smoke fights for the ports). Output is git-ignored.

## Rules
- Real footage + rights-clean synth audio only. Anonymize: seeded data, invented names.
- Publishing/scheduling is human-gated (outward-facing) — hand the master to the human gate, don't post it.
