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
- **`src/lib/sync/projects-read.ts`**, `projects-read-types.ts`, and their test (220 lines)
  — unused Phase 2b wrapper. Grep precise paths/exports before deleting: a different,
  live `fetchAccessibleProjects` exists in `cloud-projects.ts`.

## 2026-08-11 — type-tightening + complexity survey (chore/code-health-2026-08-11, second run)

This run removed 13 redundant non-null assertions (type-tightening theme). The same
survey turned up a complexity-reduction (theme 2) candidate and one more type-tightening
spot, both deferred rather than mixed into the single-theme budget.

- **Status**: both complexity-reduction candidates were completed on 2026-08-14.
  `roles.ts` now uses the single canonical `ROLE_INFO` lookup integrated from PR #395;
  `CellAudioButton.tsx` uses the icon and tooltip lookups from PR #391. Their exported
  signatures and fallback values remain unchanged.

- **`src/lib/text/word-diff.ts`** (~lines 32–56) — remaining type-tightening spot: ~14
  dense non-null assertions (`text[i]!`-style) inside a tight DP loop, same "loop
  condition already bounds the index" story as the ones fixed in
  `src/lib/biblica/sentence-cuts.ts`. Friction: the density of assertions in one tight
  loop raises the risk of a transcription typo during a bulk edit for a line-count-only
  benefit; wants a dedicated, careful pass rather than being bundled with other fixes.
  Proof needed: `pnpm build` clean (confirms TS still infers the narrower type without
  the assertions) plus `pnpm test` green, no test files touched.

## `src/hooks/useSubscribedConcepts.ts` — looks dead, is not

- **File**: `src/hooks/useSubscribedConcepts.ts` (140 lines). Zero real importers (only
  doc-comment mentions in `TermbaseSharingSection.tsx` and `useRules.ts`), no colocated
  test file — flagged by a zero-importer grep sweep in the 2026-08-14 run.
- **Why NOT deleted**: the file's own header comment is a `SWARM-TODO` marking it as
  deliberately-staged scaffolding for a planned server route
  (`GET /api/v2/projects/:id/termbase/concepts`, see `docs/swarm/TERM3-ORG-API.md`) — it
  treats any non-2xx as "no concepts yet" specifically so "the ordering/merge wiring...
  starts returning real concepts the moment the server route lands, with NO client change
  required." That reads as in-flight work, not abandoned debris; deleting it would erase
  a documented forward-compat contract.
- **What would need to change before revisiting**: confirm with a human (or check for a
  newer doc) whether the SWARM-TODO is still active or has gone stale/abandoned. If truly
  abandoned, it's a clean deletion (zero importers, self-contained).

The 2026-08-10 run also recorded an E2E limitation in the Claude Code web sandbox: its
Docker/Wrangler setup was not reliable enough to complete the smoke suite. This is an
environment note, not a product regression. The 2026-08-12 and 2026-08-14 runs hit the
same limitation (`pnpm test:e2e:smoke` → `Docker unavailable`, no local Postgres socket,
all 3 shards refuse to run rather than reset against a stale schema) — still an
environment gap, not something a code-health PR should try to patch around.

## 2026-08-17 run — dead-code deletion blocked by a reproducible test-isolation flake

Attempted theme: dead-code deletion. Found and verified as genuinely unreferenced
(zero importers anywhere in `src/`, all four worker packages, `e2e/`, `scripts/`, and
`parity/`):

- `src/components/import/DirectionPanel.tsx` (93 lines) — `ImportDialog.tsx` defines
  its own private inline `function DirectionPanel(...)` (line ~2695) and renders that,
  never importing the standalone file.
- `src/components/import/ImportResultPanel.tsx` (89 lines) — same pattern, inline
  duplicate at `ImportDialog.tsx` line ~2776.
- `src/components/import/MaculaPanel.tsx` (107 lines) — same pattern, inline duplicate
  at `ImportDialog.tsx` line ~3482.
- `src/lib/cell-context.ts` (14 lines) — its own header comment says it was "relocated
  here" from a since-removed chat service; the `CellContext` type it exports has zero
  references anywhere else.

(The rest of the `src/components/import/*.tsx` cluster — `BiblicaPanel`, `SdbhPanel`,
`DcsPanel`, `ObsPanel`, `TnPanel`, `CollisionPanel`, `ImportLanding`, `HelloaoPanel`,
`EBiblePanel`, `UploadPanel`, ~2,350 more lines — follows the identical
inline-duplicate-shadows-standalone-file pattern and is equally provable dead code once
the blocker below is resolved.)

**Why not shipped**: deleting just the 4 smallest files (303 lines) and re-running the
root `pnpm test` suite repeatedly surfaced a reproducible correlation that has nothing to
do with these files' contents:

| Run | Deletion present? | Result |
|---|---|---|
| 1 | no (true baseline) | 6 failed / 5 files — no `TeamsList.test.tsx` failure |
| 2 | yes | 7 failed / 6 files — `TeamsList.test.tsx` fails ("empty-org state...") |
| 3 | yes | 7 failed / 6 files — `TeamsList.test.tsx` fails ("shows New team for an org admin...") |
| 4 | no (re-stashed, re-verified) | 6 failed / 5 files — no `TeamsList.test.tsx` failure |
| 5 | yes (re-popped) | 7 failed / 6 files — `TeamsList.test.tsx` fails (same test as run 3) |

`src/components/org/TeamsList.test.tsx` has **zero** references — direct or transitive —
to any of the 4 deleted files (confirmed by grep), and passes 14/14 in isolation
(`vitest run src/components/org/TeamsList.test.tsx`) every time. The most likely
mechanism: removing 4 files shifts vitest's file-to-worker sharding/ordering, which
changes which other test file(s) `TeamsList.test.tsx` runs concurrently with in the same
worker — and something in that suite (a leaked mock, a module-level singleton, an
unresolved async task) is order/neighbor-dependent. That's a **pre-existing test-isolation
bug**, exposed rather than caused by the deletion, but it means `pnpm test` cannot
currently be trusted to stay green across *any* change that alters the repo's test-file
count — which breaks this routine's core green-to-green proof mechanism for every future
run until it's fixed.

- **Filed**: [genesis-ai-dev/aquilla#410](https://github.com/genesis-ai-dev/aquilla/issues/410)
  — needs a human or a dedicated `/diagnose` pass, not a code-health cleanup.
- **What would unblock this candidate**: once the `TeamsList.test.tsx` isolation bug is
  fixed (or confirmed benign and quarantined properly), re-verify these 4 files are still
  unreferenced and delete them; then proceed to the other 10 files in the same directory
  as follow-ups.
- **Proof needed when revisited**: same as this run — `grep -rn` zero-importer check per
  file, `pnpm test` green before and after, run at least twice each way given the
  demonstrated flake risk.

## Remaining "frontier-server" comment mention (frozen — test file)

- **File**: `src/lib/frontier/roles.test.ts:24` — a code comment referencing
  "frontier-server's `ROLE_NAMES` / migration 0013" inside a test file.
- **Friction**: same stale-terminology issue as the (now-fixed) src comments — the service
  is `auth-worker`/`aquilla-identity`, not `frontier-server`.
- **Why deferred**: the code-health routine's frozen zones forbid touching test files, even
  for a comment. Needs a human or a non-code-health change to fix.
- **Proof needed**: comment-only edit inside a test file; would need explicit sign-off
  since it falls outside the routine's "no test files" rule.
