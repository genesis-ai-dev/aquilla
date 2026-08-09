# Code Health Candidate Ledger

Bigger opportunities spotted during `/code-health` runs that exceeded that run's budget
(≤ ~300 changed lines / ≤ ~8 files) or needed a product/ownership decision before touching.
Prune entries once a later run completes them.

## 2026-08-09 run (chore/code-health-2026-08-09, theme: dead code deletion)

- **`src/components/Dashboard.tsx`** (466 lines) — zero importers found (`grep -rn
  "components/Dashboard\""` outside the file hits only stale planning docs). The live router
  (`src/App.tsx`) routes org pages to `src/components/org/OrgHome.tsx` instead. Alone this is
  close to/over a single run's line budget, so it wasn't bundled with the smaller deletions in
  this run. Note: `e2e/helpers/page-objects/Dashboard.ts` is a *different*, unrelated Playwright
  page object with the same name — don't confuse the two when verifying. Proof needed: same as
  this run (grep for zero importers across src/, all worker packages, e2e/, scripts/, then
  `pnpm build` + `pnpm test` green-to-green with the file removed).

- **Matecat-parity scaffolding cluster** (`src/lib/workflow/`, `src/lib/analysis/buckets.ts`,
  `src/lib/analysis/payable.ts`, `src/lib/qa/checks.ts`, `src/lib/qa/glossary.ts`,
  `src/lib/qa/termbase.ts`, `src/lib/entitlements/`, `src/lib/global-tm/`,
  `src/lib/export/fidelity.ts`, `src/lib/import/xliff-reimport.ts`) — every file is
  self-labeled "(Matecat-parity run)" and several explicitly say "INERT until wired... nothing
  existing imports this module yet" or "behind the `batchApi` feature flag, default off." Zero
  importers, but this reads as deliberate pre-built scaffolding for a planned feature, not
  accretion cruft. **Not a code-health deletion candidate** — flagging only so a human can
  confirm whether it's still on the roadmap or should be removed. If abandoned, it would need a
  product decision, not just a grep-based dead-code proof.

- **Stale "D1" wording in comments on live (Postgres-backed) code paths** — e.g.
  `src/hooks/useCells.ts:1,440` ("D1 audit history" / "D1 is the load path"),
  `src/components/HistoryDrawer.tsx:20,24,198`, `src/lib/audio/transcribe.ts:3`. CLAUDE.md
  confirms the D1→Postgres/Neon cutover is complete, so these comments are drift. Trap: some
  "D1" hits in `src/lib/parsers/*.ts` are a false-positive — they refer to a design-doc rule
  label ("D1: true on the first cell of a paragraph block"), not the database; don't
  blanket-replace. This is comment-only (zero behavior change) but touches enough files to be
  its own themed run (theme 6, "Comment/doc drift") rather than bundled with a dead-code-deletion
  run. Proof needed: full gate green (comment-only diff can't change test outcomes, but the
  routine still requires it) + `git diff` shows only comment lines changed.

- **Lower-confidence zero-importer exports, needs product/ownership call, not blind deletion**:
  - `src/lib/frontier/orgs.ts:164,170` `listOrgInvites`/`revokeOrgInvite` — reads like an
    unbuilt "manage pending org invites" admin UI rather than abandoned code.
  - `src/lib/audio/voices.ts:35,102` `DEFAULT_VOICE_ID`/`forkVoice` — `forkVoice` ("fork a
    built-in voice into a user-editable copy") reads like a planned feature hook.
  - `src/lib/sync/cells-read.ts:159` `fetchFile`, `src/lib/sync/comments-read.ts:39`
    `fetchCommentsForCell`, `src/lib/sync/cells-cache.ts:247` `deleteCellsCache`,
    `src/lib/sync/commit-message.ts` (whole file) `buildCommitMessage` — typed client wrappers
    matching sync-worker REST routes with zero current callers; may be intentional API-surface
    completeness rather than dead debris.
