# v3 Audit — Unimplemented / Disabled Features

## Summary
The v3 codebase has migrated from Yjs-backed per-file Y.Docs to a D1 event-log projection model. This caused six major user-facing features to be stubbed out: Comments, Snapshots, Parallel Passages (project-wide search), Living Memory, transcript-to-cell writeback, and autofix rule suggestions. Routes, components, and hooks for these features still exist, rendering "unavailable in this build" placeholders. Full re-implementation is deferred to v1.x pending the event grammar for each feature.

## Features by status

### A. Confirmed stubs (user-flagged)

#### A1. Comments
- **UI message location**: `src/components/CommentsPage.tsx:21–24` — "Comments unavailable in this build" dialog
- **Routes**: `/project/:id/comments` + debug route at `/project/:id/comments/debug` (in `src/App.tsx`)
- **Components**: `CommentsPage`, `CommentsDrawer`, `CommentThread` (renders empty / stubs)
- **Hooks**: `useComments` in `src/hooks/useComments.ts:1–50` — returns NOOP_API; stub since Phase 2b
- **Server-side**: No D1 tables or sync-worker handlers; per-file Y.Doc maps were source-of-truth in Phase 2a
- **Event grammar needed (v1.x)**: `comment.create`, `comment.message`, `comment.resolve`, `comment.reopen` (OutboxEventKind extensions)
- **Re-impl scope**: **medium** (grammar + hook + drawer surface)

#### A2. Snapshots (REMOVE entirely per user)
- **Routes**: `/project/:id/snapshots` + debug route at `/project/:id/snapshots/debug` (in `src/App.tsx`)
- **Components**: `SnapshotsPage` (renders placeholder); referenced in `EditorTable` and `ProjectWorkspace` nav
- **Hooks**: None; snapshots were Y.Doc state vectors, no active hook
- **Server-side**: 
  - R2 objects: `projects/{pid}/files/{fid}/snapshot.bin` (referenced in `sync-worker/src/admin.ts` and tests)
  - No D1 schema; snapshots metadata lived in Y.Doc
- **Other touchpoints**: 
  - Navigation: `ProjectWorkspace.tsx` has snapshots button (should be removed)
  - Admin: `sync-worker/src/admin.ts` has snapshot size tracking in bulk-delete flow
  - Tests: `sync-worker/src/__tests__/admin.test.ts` seeds snapshot.bin files for DELETE testing
- **Removal scope**: **medium** (UI nav, admin handlers, R2 lifecycle, test cleanup)

#### A3. Parallel passages + project-wide search
- **UI message location**: `src/components/ParallelPassagesPanel.tsx:49–54` — "Parallel passages unavailable" dialog
- **Routes**: No dedicated route; activated via keyboard shortcut or command palette (wired but feature disabled)
- **Components**: `ParallelPassagesPanel` (renders placeholder only); signature preserved, no logic
- **Hooks**: 
  - `useWorkspaceSearch` in `src/hooks/useWorkspaceSearch.ts` (stub)
  - `useSearchIndex` in `src/hooks/useSearchIndex.ts` (in-memory FTS only, no server backing)
- **Server-side**: 
  - Expected endpoints: `/branching-search` + `/branching-search/passages` (referenced in `src/components/ProjectWorkspace.tsx:13–14` as fetch helpers)
  - Files exist: `src/lib/sync/branching-search-read.ts` + `src/lib/sync/branching-search-passages-read.ts` (fetch stubs, no implementation)
  - D1 schema: TBD (depends on branching-search index design)
- **Event grammar needed (v1.x)**: Search index metadata (likely tied to project structure events, not outbox)
- **Re-impl scope**: **large** (server index + fetch adapters + client UI + bulk-replace writer)

#### A4. Living Memory
- **UI message location**: `src/components/LivingMemoryPage.tsx:22–25` — "Living Memory unavailable in this build"
- **Routes**: `/project/:id/memory` (in `src/App.tsx`); navigation button conditionally rendered if `livingMemoryEnabled` feature flag is true
- **Components**: `LivingMemoryPage` (placeholder); button in `ProjectWorkspace.tsx` nav items
- **Hooks**: No active hook; feature aggregated recent-validated cells from per-file Y.Docs
- **Server-side**: No D1 tables or sync handlers; was read-only aggregation
- **Event grammar needed (v1.x)**: None; can be reconstructed by scanning `cell.validate` events with recent timestamps
- **Re-impl scope**: **small** (read-only UI powered by cells projection)

### B. Other stubs / disabled features found

#### B1. Transcript-to-cell writeback (disabled)
- **File:line of component**: `src/components/CellTranscriptPreview.tsx:102–109` — span reading "Transcript-to-cell write disabled in this build"
- **Context**: When a Whisper transcript differs from cell text but user clicks "Use as cell text", nothing happens
- **Reason**: Writeback relied on Y.Doc edits; pending `target.cell.commit` grammar
- **UI state**: Button/action hidden behind disabled span; renders when `!matches && !isStale && editable && cellHasText`
- **Re-impl scope**: **small** (one commit event type)

#### B2. Autofix rule suggestions (disabled)
- **File:line**: `src/components/RuleDrawer.tsx:25–26, 55–58` — "Try to fix all" buttons disabled with title "Autofix is unavailable in this build"
- **Also in**: `src/components/RulesPage.tsx` — same disabled buttons
- **Context**: User clicks "Try to fix all" infractions; nothing happens
- **Reason**: Autofix applied Y.Doc edits; pending event-grammar equivalent
- **Re-impl scope**: **medium** (bulk-patch grammar + rule-suggestion engine re-wiring)

#### B3. Bulk transcribe-all + synth-all (disabled)
- **File:line**: `src/components/ProjectWorkspace.tsx:` warns `console.warn("[ProjectWorkspace] transcribe-all disabled in Phase 2c-gamma")` and synth-all equivalent
- **Context**: Bulk actions for whole-file audio processing
- **Reason**: These trigger per-cell audio worker tasks; writeback relies on Y.Doc, not yet re-wired to outbox
- **Current state**: Code paths exist but log warnings and no-op
- **Re-impl scope**: **medium** (job coordinator + cell.audio events)

#### B4. Export flow (not yet available)
- **File:line**: `src/components/ProjectWorkspace.tsx:` warns `console.warn("[ProjectWorkspace] export flow not yet available")`
- **Context**: No Export button rendered in workspace; feature is planned but not started
- **Reason**: Design + format selection + compression logic not yet ported from v2
- **Re-impl scope**: **large** (file format adapters, compression, download flow)

#### B5. "Complete all" workspace action (coming soon)
- **File:line**: `src/lib/workspace-actions/registry.ts:55–59` — action with `comingSoon: true`, disabled in UI
- **Label**: "Complete all (coming soon)"
- **Current behavior**: Button renders disabled (opacity 50%, not clickable)
- **Reason**: Spend controls + batch pagination not yet designed; `MAX_BATCH_COMPLETIONS` cap is 10 per click
- **Re-impl scope**: **medium** (spend/cost display + streaming UI + pagination UX)

#### B6. Sidebar filter-files autocomplete hijack (minor UX bug, not a feature)
- **Status**: Mentioned by user; **not found** in codebase search
- **Note**: Sidebar components are minimal (`FileSectionGrid.tsx`, `ProgressDot.tsx`). If the input exists, it may be in a parent `ProjectWorkspace` or `AppShell` component. No `<input>` with `name="filter"` or similar found in sidebar/ directory.
- **Action**: Defer to user clarification of exact file:component where bug occurs

## Open questions
- Should the Living Memory button render at all if the feature is permanently flagged off? (Currently hidden behind `livingMemoryEnabled` feature flag check.)
- Is the branching-search index meant to live in D1 or be computed on-the-fly from the event log?
- Should transcript-to-cell writeback be prioritized before autofix, or are both low-priority?
- Is the snapshots R2 bucket actively used by any other feature, or can it be fully decommissioned?

## Files reviewed
- `src/App.tsx` — route definitions
- `src/components/CommentsPage.tsx` — placeholder
- `src/components/SnapshotsPage.tsx` — placeholder
- `src/components/ParallelPassagesPanel.tsx` — placeholder + feature unavailable message
- `src/components/LivingMemoryPage.tsx` — placeholder
- `src/components/CellTranscriptPreview.tsx` — disabled writeback button
- `src/components/RuleDrawer.tsx` — disabled autofix buttons
- `src/components/ProjectWorkspace.tsx` — nav items, bulk-action warnings, branching-search fetch attempts
- `src/components/PrimaryActionButton.tsx` — "coming soon" action handling
- `src/hooks/useComments.ts` — NOOP stub API
- `src/hooks/useWorkspaceSearch.ts` — search hook (stub)
- `src/hooks/useSearchIndex.ts` — in-memory FTS only
- `src/lib/workspace-actions/registry.ts` — "coming soon" action definitions
- `src/lib/sync/branching-search-read.ts` — fetch stub
- `src/lib/sync/branching-search-passages-read.ts` — fetch stub
- `sync-worker/src/admin.ts` — snapshot size tracking in DELETE flow
- `sync-worker/src/__tests__/admin.test.ts` — snapshot test fixtures
