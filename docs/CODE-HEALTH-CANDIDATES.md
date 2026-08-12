# Code-health candidate ledger

Bigger opportunities spotted during `/code-health` runs that exceeded that run's budget
(one theme, ≤300 lines, ≤8 files). Not done yet — pick one up in a future run. Prune entries
a later run completes.

## Stale "frontier-server" reference in a test comment (not actionable by this routine)

- **File**: `src/lib/frontier/roles.test.ts:22` still says the mirrored source of truth is
  `frontier-server`'s `ROLE_NAMES`; the live path is `auth-worker/src/services/
  project-permissions.ts` (fixed in the sibling comment at `src/lib/frontier/roles.ts:4-5`
  by the 2026-08-12 run). This routine can never touch it — it's inside a `.test.ts` file,
  which is a frozen zone regardless of theme.
- **Proof needed**: none from this routine; would need a human or a different, test-editing
  workflow to update the comment.

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

## Additional candidates from the 2026-08-11 component cleanup run

- **`src/components/RulesPage.tsx`** and its test (671 lines total) — superseded by
  `RulesSurface` in `ProjectWorkspace`; the old route’s removed UI is already documented
  in the corresponding smoke spec. Confirm zero real importers before deletion.
- **`src/components/TerminologyPage.tsx`** and its test (2,034 lines total) — superseded
  by `GlossaryEditorContent` / `GlossaryEditor`. This needs a dedicated review because of
  its size; confirm no e2e spec still depends on it.
- **`src/lib/sync/projects-read.ts`**, `projects-read-types.ts`, and their test (220 lines)
  — unused Phase 2b wrapper. Grep precise paths/exports before deleting: a different,
  live `fetchAccessibleProjects` exists in `cloud-projects.ts`.

## Prior candidates retained from the 2026-08-10/11 runs

- **`src/components/CellActionsMenu.tsx`**, `ProgressDot.tsx`, and
  `useSubscribedConcepts.ts` — re-check zero importers before deletion.
- **`src/lib/sync/settings-read.ts`** / `settings-read-types.ts` and
  **`src/lib/timeline/diarization-loader.ts`** — deferred from the 2026-08-11 survey;
  confirm no newer feature path introduced a caller.
- **`src/lib/sync/sync-debug.ts`**, the deprecated `EditorScrollContext` compatibility
  fields, and the deprecated `ExamplePanel` prop pass-through were recorded as candidates
  in the earlier run; verify the current source before taking further action.

The 2026-08-10 run also recorded an E2E limitation in the Claude Code web sandbox: its
Docker/Wrangler setup was not reliable enough to complete the smoke suite. This is an
environment note, not a product regression.
