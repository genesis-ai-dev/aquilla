# Code-health candidate ledger

Bigger opportunities spotted during `/code-health` runs that exceeded that run's budget
(one theme, ≤300 lines, ≤8 files). Not done yet — pick one up in a future run. Prune entries
a later run completes.

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
  `projects-read.test.ts` (220 lines total) — reconfirmed 2026-08-13: zero production
  importers anywhere in the repo; the only reference is a stale doc-comment in the
  (now-deleted, see below) `useSubscribedConcepts.ts`. A separate, live
  `fetchAccessibleProjects` exists in `cloud-projects.ts:176` and is what every real call
  site (`ExternalCollaboratorsSection.tsx`, `SharedProjectsPage.tsx`, `TeamDetail.tsx`,
  plus several `*.test.ts` mocks) actually imports. **Why still deferred**: deleting the
  source file also requires deleting `projects-read.test.ts`, and the code-health routine's
  frozen zones forbid touching any `**/*.test.ts` file even to remove it alongside its dead
  subject — needs a human (or a non-code-health change) to delete all three together.
  Proof needed: same zero-importer grep as this note, then delete the pair + test file in
  one non-routine commit.

## 2026-08-11 — type-tightening + complexity survey (chore/code-health-2026-08-11, second run)

This run removed 13 redundant non-null assertions (type-tightening theme). The same
survey turned up a complexity-reduction (theme 2) candidate and one more type-tightening
spot, both deferred rather than mixed into the single-theme budget.

- **`src/lib/frontier/roles.ts`** (175 lines) — `roleName()` (lines ~115–126) and
  `roleDescription()` (lines ~136–147) are two parallel `switch` statements keyed on
  the same 7 numeric role levels (100/200/…/700). Friction: this run's budget was
  already spent on the type-tightening theme; picking both in one PR would mix themes.
  Proof needed: collapse to a single `Record<RoleLevel, { name; description }>` lookup
  with `roleName`/`roleDescription` kept as thin accessors with identical signatures
  and return values — `pnpm build` (return-type match) plus `pnpm test` (no test file
  changes) is the proof.

- **`src/components/CellAudioButton.tsx`** (lines 74–102) — `errorIcon()` and
  `errorTooltip()` are two switch statements keyed on the same `kind` string union;
  same lookup-table shape as above. Friction: budget, and slightly higher risk since
  the switches return JSX rather than plain values — worth its own careful pass.
  Proof needed: same exported signatures/return types, `pnpm build` + `pnpm test`
  green with no test changes.

- **`src/lib/text/word-diff.ts`** (~lines 32–56) — ~14 dense non-null assertions
  (`text[i]!`-style) inside a tight DP loop, same "loop condition already bounds the
  index" story as the ones fixed this run in `src/lib/biblica/sentence-cuts.ts`.
  Friction: skipped this run — the density of assertions in one tight loop raised the
  risk of a transcription typo during a bulk edit for a line-count-only benefit; wants
  a dedicated, careful pass rather than being bundled with the other easier fixes.
  Proof needed: `pnpm build` clean (confirms TS still infers the narrower type without
  the assertions) plus `pnpm test` green, no test files touched.

## Done 2026-08-13 (dead-code deletion run)

- **`src/components/Dashboard.tsx`** (499 lines) and **`src/hooks/useSubscribedConcepts.ts`**
  (140 lines, plus its `fetchTermbaseConcepts` export) — both reconfirmed zero real
  importers repo-wide (only unrelated same-named hits: `OrgHome.tsx`'s
  `DashboardRowTemplate`/`DashboardPanelTemplate` skeletons, and doc-comment mentions of
  `useSubscribedConcepts` in `useRules.ts`/`TermbaseSharingSection.tsx`/
  `termbase-subscriptions.ts`). Neither had a test file. Deleted, 639 lines removed
  across 2 files.
- **`src/components/CellActionsMenu.tsx`**, **`src/components/sidebar/ProgressDot.tsx`**,
  **`src/lib/sync/settings-read.ts`** / **`settings-read-types.ts`**,
  **`src/lib/timeline/diarization-loader.ts`**, and **`src/lib/sync/sync-debug.ts`** —
  reconfirmed 2026-08-13 that all of these were **already deleted** in prior code-health
  commits (`a43f5e11`, `7287808b`, `eefbd15f`, `737ea8e2`, `54bf8c9b`); these ledger
  entries were stale and are pruned rather than acted on again.
- The deprecated `EditorScrollContext` compatibility fields and deprecated `ExamplePanel`
  prop pass-through mentioned in the original entry were not re-verified this run — if
  still present, re-add as a fresh candidate with current file/line references.

The 2026-08-10 run also recorded an E2E limitation in the Claude Code web sandbox: its
Docker/Wrangler setup was not reliable enough to complete the smoke suite. This is an
environment note, not a product regression. The 2026-08-12 run hit the same limitation
(`pnpm test:e2e:smoke` → `Docker unavailable`, no local Postgres socket, all 3 shards
refuse to run rather than reset against a stale schema) — still an environment gap, not
something a code-health PR should try to patch around.

## Remaining "frontier-server" comment mention (frozen — test file)

- **File**: `src/lib/frontier/roles.test.ts:24` — a code comment referencing
  "frontier-server's `ROLE_NAMES` / migration 0013" inside a test file.
- **Friction**: same stale-terminology issue as the (now-fixed) src comments — the service
  is `auth-worker`/`aquilla-identity`, not `frontier-server`.
- **Why deferred**: the code-health routine's frozen zones forbid touching test files, even
  for a comment. Needs a human or a non-code-health change to fix.
- **Proof needed**: comment-only edit inside a test file; would need explicit sign-off
  since it falls outside the routine's "no test files" rule.
