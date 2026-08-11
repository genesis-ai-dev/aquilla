# Code-health candidate ledger

Bigger opportunities spotted during `/code-health` runs that exceeded that run's budget
(one theme, ≤300 lines, ≤8 files). Not done yet — pick one up in a future run. Prune entries
a later run completes.

## "frontier-server" comment drift (stale doc terminology)

- **Files**: `src/lib/sync/file-projection.ts:1`, `src/lib/sync/archive.ts:1`,
  `src/lib/store/project-index.ts:218`, `src/lib/parsers/types.ts:418-422`.
- **Friction**: these file-header/inline comments say requests go to "frontier-server", a
  decommissioned service. The code now calls `FRONTIER_API_URL`, which resolves to
  auth-worker (`aquilla-identity`) — see `src/lib/sync/sync-token.ts:19-22`. Misleading for
  anyone reading the comment to understand where the request actually lands.
- **Why deferred**: 2026-08-10 run used its budget on the dead-code-deletion theme instead
  (higher value per the rotation). This is a clean, single-theme, ~4-file candidate for a
  future run.
- **Proof needed**: comment-only edits, no exports/behavior touched — trivial to verify with
  `pnpm build` + unchanged `pnpm test`. No test files should need touching.

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
