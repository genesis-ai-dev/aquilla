# Code-health candidate ledger

Bigger cleanup opportunities spotted during `/code-health` runs that exceeded a single
run's budget (~300 changed lines / ~8 files). Not yet done. Prune an entry once a later
run completes it.

## `src/components/RulesPage.tsx` — dead, superseded standalone component

- **Files:** `src/components/RulesPage.tsx` (343 lines) + `src/components/RulesPage.test.tsx`
  (328 lines) — 671 lines total, over budget on its own.
- **Friction:** Route `/project/:id/rules` now renders `RulesSurface` inside
  `ProjectWorkspace` instead. `RulesPage` has zero non-test/non-comment references
  anywhere in the tree; an e2e spec already documents the old UI as removed
  (`e2e/specs/rules/rules-page-back-to-editor.smoke.spec.ts:9`: *"The old standalone
  RulesPage 'Back to Editor' button is gone."*).
- **Why deferred:** Deleting the component + its test file alone is ~671 lines, already
  past this run's ≤300-line budget before touching anything else.
- **Proof needed:** `grep -rn "RulesPage" src --include=*.tsx --include=*.ts` (excluding
  its own file/test) turns up only prose-comment hits in
  `src/components/onboarding/ProductTour.tsx`; confirm `pnpm build` + root `pnpm test`
  stay green with the file and its test removed, and that no e2e spec still imports it.

## `src/components/TerminologyPage.tsx` — dead, superseded standalone component

- **Files:** `src/components/TerminologyPage.tsx` (1393 lines) +
  `src/components/TerminologyPage.test.tsx` (641 lines) — 2034 lines total.
- **Friction:** Route `/project/:id/terminology` now renders `GlossaryEditorContent` →
  `GlossaryEditor.tsx` (see the FRO-254 comment at `src/App.tsx:51`). Zero non-test/
  non-comment imports of `TerminologyPage` remain (comment-only hits in
  `CandidateTermsPanel`, `GlossaryEditor`, `App.tsx`, `shell-routing.test.ts`).
- **Why deferred:** Far over budget by itself; also the largest single deletion found
  so far, worth its own careful review pass rather than bundling with anything else.
- **Proof needed:** Same shape as `RulesPage` above — confirm zero real importers, then
  delete component + test, `pnpm build` + `pnpm test` green, no e2e spec regresses.

## `src/lib/sync/projects-read.ts` + `projects-read-types.ts` — unused "Phase 2b" read wrapper

- **Files:** `src/lib/sync/projects-read.ts` (87 lines), `src/lib/sync/projects-read-types.ts`
  (49 lines), `src/lib/sync/projects-read.test.ts` (84 lines) — 220 lines, fits the size
  budget on its own.
- **Friction:** `fetchProject`, `fetchProjectList`, `fetchAccessibleProjects`, and
  `ProjectsReadError` exported here are referenced only by their own test file. The
  file's own header comment says the legacy `cloud-projects.ts` / `src/lib/frontier/*`
  wrappers are what callers actually use. Note: `cloud-projects.ts` exports its own,
  *different* `fetchAccessibleProjects` with many live call sites — any deletion pass
  must grep the exact file path, not just the symbol name, to avoid conflating the two.
- **Why deferred:** Not size — the name collision with `cloud-projects.ts`'s
  `fetchAccessibleProjects` makes this a "read carefully, don't grep-and-delete" job
  better done as its own focused pass rather than bundled with unrelated deletions in
  the same run.
- **Proof needed:** Confirm every export's only non-test reference is within
  `projects-read.ts`/`projects-read-types.ts` themselves (already checked once — see
  this run's commit for the grep evidence), delete both files + the test file,
  `pnpm build` + `pnpm test` green.
