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
- **`src/lib/sync/projects-read.ts`**, `projects-read-types.ts`, and their test (220 lines)
  — unused Phase 2b wrapper. Grep precise paths/exports before deleting: a different,
  live `fetchAccessibleProjects` exists in `cloud-projects.ts`.

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

## Prior candidates retained from the 2026-08-10/11 runs

- **`src/components/Dashboard.tsx`** (466 lines) — a pre-org-model project dashboard,
  apparently superseded by `src/components/org/OrgHome.tsx`; no import found anywhere
  (route table in `App.tsx` doesn't reference it). At 466 lines this alone would consume
  most of a single run's budget — worth a dedicated pass rather than bundling with
  smaller deletions. Proof needed: zero importers/JSX usage (component + string route
  matches), and confirm `OrgHome.tsx` covers the same surface before deleting.
  (Entry was dropped in a prior stacked-ledger conflict resolution while the file still
  exists with zero importers — restored 2026-08-12.)
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
