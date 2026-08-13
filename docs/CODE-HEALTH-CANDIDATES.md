# Code-health candidate ledger

Bigger opportunities spotted during `/code-health` runs that exceeded that run's budget
(one theme, ≤300 lines, ≤8 files). Not done yet — pick one up in a future run. Prune entries
a later run completes.

## "D1 is the live datastore" comment drift

- **Files**: systemic — 500+ hits across dozens of files (sampled instances:
  `src/hooks/useCells.ts:1`, `src/components/HistoryDrawer.tsx:20`,
  `src/components/EditorTable.tsx:697,4816`, `src/components/CellActionsMenu.tsx:29,43`).
- **Friction**: comments describe D1 as the live datastore/audit source; the D1→Postgres
  (Neon/Hyperdrive) cutover is complete per CLAUDE.md. Misleads readers about where reads
  actually go.
- **Why deferred**: too large for one ≤300-line/≤8-file PR. Needs its own dedicated
  "comment/doc drift" run (theme 6) scoped to a manageable slice (e.g. just `src/hooks/` +
  `src/components/` in one pass, then the rest in a follow-up), rather than attempting all
  500+ hits at once.
- **Proof needed**: comment-only edits; verify each hit is genuinely describing D1 as live
  (not historical "migrated from D1" framing) before touching it — some framing may already
  be correct and should be left alone.

## "frontier-server" mentions in sync-worker

- **Files**: `sync-worker/src/cors.ts:4`, `sync-worker/src/admin.ts:24`.
- **Friction**: same drift as the `src/` "frontier-server" comments fixed by the
  2026-08-11 comment/doc run — these describe the *current* auth flow in present tense
  but name the retired frontier-server service.
- **Why deferred**: touching `sync-worker/` requires running its own test suite
  (`cd sync-worker && npm test`) per the routine — bundle with a sync-worker-scoped
  pass rather than an `src/`-only comment run.
- **Proof needed**: comment-only edits; sync-worker suite green.

## Additional candidates from the 2026-08-11 component cleanup run

- **`src/components/RulesPage.tsx`** and its test (671 lines total) — superseded by
  `RulesSurface` in `ProjectWorkspace`; the old route’s removed UI is already documented
  in the corresponding smoke spec. Confirm zero real importers before deletion.
- **`src/components/TerminologyPage.tsx`** and its test (2,034 lines total) — superseded
  by `GlossaryEditorContent` / `GlossaryEditor`. This needs a dedicated review because of
  its size; confirm no e2e spec still depends on it.
- **`src/lib/sync/projects-read.ts`**, `projects-read-types.ts`, and their test
  `projects-read.test.ts` (~220 lines total) — confirmed zero real importers on
  2026-08-13 (only `./projects-read-types` ↔ `projects-read.ts` import each other, plus
  their own test; every real caller of `fetchAccessibleProjects` app-wide goes through
  the live `cloud-projects.ts` instead). **Blocked, not just deferred**: deleting the two
  source files orphans `projects-read.test.ts`, and this routine's behavior-preservation
  gate forbids touching any `*.test.ts` file (even to delete one paired 1:1 with dead
  code). A run that wants this needs either an explicit human-approved exception to that
  rule for test-file deletion, or to fold it into a non-code-health cleanup pass.

## Newly orphaned by the 2026-08-13 Dashboard.tsx deletion

- **`src/lib/projects/dedupe-cloud.ts`** (`filterCloudOnly`, 34 lines) — its only real
  caller was the now-deleted `src/components/Dashboard.tsx`; grep confirms zero other
  importers. **Same test-file block as `projects-read.ts` above**: `dedupe-cloud.test.ts`
  exists and would be orphaned by deleting the source, which this routine's rules forbid
  touching. Candidate for whatever future pass ends up handling the `projects-read.ts`
  case, since both hit the identical blocker.

The 2026-08-10 run also recorded an E2E limitation in the Claude Code web sandbox: its
Docker/Wrangler setup was not reliable enough to complete the smoke suite. This is an
environment note, not a product regression.
