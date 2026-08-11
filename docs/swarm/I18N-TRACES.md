# I18N swarm traces (AQU-511)

Open TODOs and findings that outlive any single agent's context. Append; don't rewrite.
Companion to `I18N-ORCHESTRATION.md`.

## Open

- **SWARM-TODO (orchestrator, after wave 2):** wire all 9 namespaces into
  `src/lib/i18n/namespaces/index.ts` and their drivers into `scripts/i18n-shots/index.ts`.
  Agents are forbidden from touching these — see the deviation note in I18N-ORCHESTRATION.md.
- **SWARM-TODO (orchestrator, wave 4):** `pnpm i18n:shots` needs the dev stack up
  (`colima start` first — the local Docker runtime is Colima, not Docker Desktop).
- **Handoff, not a TODO:** Task 9 Steps 3–5 need Biblica's Burmese and Patani Malay reviewers.
  This is the release's critical path and it is not engineering work. The swarm hands off
  `i18n-export/*.json`.

## Findings

- `ScreenshotId` is currently a literal union derived from the `SCREENSHOTS` array, which is
  what makes `DRIVERS: Record<ScreenshotId, …>` enforce driver coverage at compile time.
  Building `SCREENSHOTS` from a `flatMap` over namespace modules widens it to `string` and
  silently drops that enforcement. Task 3 replaces it with `SURFACE_DRIVER_IDS` + two tests.
  **If a later refactor restores a literal union, delete the runtime check rather than keeping
  both** — two guards for one invariant rot apart.
- `src/lib/i18n/screenshots.ts:14-16` documented the capture path as
  `e2e/specs/i18n/catalog-shots.spec.ts`, which does not exist. Real path:
  `scripts/i18n-shots.ts`. Fixed in Task 3 Step 5.
- Worktrees on this repo have no `node_modules`. Root lockfile is byte-identical, so
  `ln -s <root>/node_modules node_modules` is the fast, safe setup.
- `src/lib/i18n/screenshots/` holds the PNGs, so the per-namespace surface *modules* live in
  `src/lib/i18n/namespaces/` (not a `screenshots/` sibling) to avoid mixing TS and binaries
  and to avoid `screenshots.ts` vs `screenshots/` resolution ambiguity.
