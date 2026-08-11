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

- **Status**: `src/hooks/` and `src/components/` slice done in the 2026-08-11 run (7 files:
  `useCellsAuditStatsWithOverlay.ts`, `useRules.ts`, `HistoryDrawer.tsx`, `EditorTable.tsx`,
  `TerminologyTermDetail.tsx`, `ProjectWorkspace.tsx`, `RuleSuggestFromEditsDialog.tsx`) —
  comment-only, reworded to "Postgres"/"server" instead of "D1".
- **Remaining files**: `src/lib/` still has real hits describing D1 as the live datastore —
  `src/lib/sync/audit-stats-overlay.ts:2,4` ("D1-backed audit stats" / "D1 is the source of
  truth"), `src/lib/sync/project-settings.ts:50` ("Synced to D1"), `src/lib/sync/
  file-projection.ts:18` ("the D1 rows remain"), `src/lib/sync/events-emit.ts:62`
  ("round-tripped to D1"), `src/lib/audio/transcribe.ts:3,204,295` ("D1 event log" /
  "Persist ... durably via D1"), `src/lib/audio/timings.ts:3`, `src/lib/rules/edit-miner.ts:
  7,32`, `src/lib/export/export-service.ts:3`, `src/lib/frontier/members.ts:20`,
  `src/lib/global-tm/index.ts:17`, `src/lib/migrate/group-sync.ts:5` (this last one already
  frames it as historical — "completing the D1→Neon cutover" — verify before touching, it
  may already be correct).
- **False positives to skip** (not database D1 — a paragraph-model spec-section tag, see
  `docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md`):
  `src/hooks/useCells.ts:123,309`, `src/lib/parsers/paragraphs.ts`, `src/lib/parsers/types.ts:
  52`, `src/lib/sync/bulk-import.ts:67`, `src/lib/parsers/usfm-lossless.ts:31`,
  `src/lib/parsers/text-splitter.ts:6`. Also skip `AD-2 chain pointer... entry came from D1`
  at `src/lib/parsers/types.ts:723` only after re-reading in context (mixed usage nearby).
- **Why deferred further**: `src/lib/` is ~50 subsystems; doing it in the same pass as
  `src/hooks/`+`src/components/` would have exceeded the ≤8-file budget. Good candidate for
  the next comment-drift-themed run.
- **Proof needed**: comment-only edits; verify each hit is genuinely describing D1 as live
  (not historical "migrated from D1" framing, not the paragraph-model tag above) before
  touching it.

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
