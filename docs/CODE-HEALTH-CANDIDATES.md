# Code-health candidate ledger

Bigger opportunities spotted during `/code-health` runs that exceeded that run's budget
(one theme, ≤300 lines, ≤8 files). Not done yet — pick one up in a future run. Prune entries
a later run completes.

## `src/components/ExportDialog.tsx` — `fmt === "..."` export-format ladder, ~930-1330+

- **Found**: 2026-09-09 run, surveying complexity-reduction candidates (this run shipped the
  smaller `dominantScript()` lookup-table conversion in `src/lib/timeline/cue-links.ts`
  instead — see git history).
- **Friction**: 9 branches keyed on export format (`usfm`, `docx`, `pptx`, `idml`,
  `audio-by-character`, `audio-by-line`, `character-sheets`, `project-report`, `sdbh-xml`)
  look like the same if/else-ladder-to-lookup-table smell, but each branch is 30-100+ lines
  of async, side-effecting work (dynamic `import()`, toast lifecycle via `exportToastRef`,
  shared mutable locals like `idmlTelemetryStartedAt`/`recoverableIdmlOriginal`, early
  `return`s that abort the whole handler, PostHog telemetry).
- **Why deferred**: a lookup-table dispatch would need each branch extracted into a
  same-signature async handler capturing a dozen closure variables — a real refactor, not a
  mechanical one. Spans 400+ lines (blows the ≤300-line budget on its own), no dedicated
  unit test found for this component, and the risk of subtly changing early-return/toast-state
  behavior is high for a routine that can't touch tests to pin the new behavior.
- **Proof needed**: would need either a new characterization test (out of scope for this
  routine) or a human-supervised manual QA pass per export format before/after, given no
  existing test coverage to lean on.

## `auth-worker/src/lib/contextual/tick.ts` — nested ternaries in `spanReasonCodes`/`eventOutcome`

- **Found**: 2026-09-09 run, same survey as above.
- **Friction**: deep nested-ternary logic, mechanically improvable to guard clauses.
- **Why deferred**: this is the durable contextual-run engine with dense cross-function
  invariants — too much blast radius for a routine cleanup pass without a human familiar
  with the invariants reviewing the rewrite.

## `src/components/org/ArchivedProjects.test.tsx` — flaky in the full `pnpm test` run

Spotted in the 2026-08-28 run's baseline (unrelated to that run's `milestones.ts` change —
reproduced with zero diff against `dev`, twice). "lists archived projects in a table and
restores on click" and/or "lists recently deleted files with a project column and restores
on click" intermittently fail with `getByRole("menuitem", { name: "Restore" })` not found
(the dropdown menu wasn't open yet when the assertion ran) when run inside the full 939-file
suite; count varied 2–3 failing tests across repeated full-suite runs. Not reproduced by
running the file in isolation (not attempted this run — full-suite reproduction was already
consistent enough to treat as pre-existing and out of scope). Likely the same family of
issue as the `TeamsList.test.tsx` full-suite-only flake filed as
[#410](https://github.com/genesis-ai-dev/aquilla/issues/410) (test-isolation/ordering
sensitivity under vitest's worker sharding), though this one appears without any file-count
change, so it may be a distinct root cause (a race between the click and the menu's open
animation/portal mount, not sharding). Needs a `/diagnose` pass or a human to add a
`findByRole`/`waitFor` around the menu-open step in that test — out of scope here since this
routine never modifies test files.

## ESLint `globalIgnores(['dist', '.claude'])` doesn't reach nested `packages/*/dist`

- **Found**: 2026-08-26 run, while diffing `pnpm lint` output against baseline for the
  `milestones.ts` non-null-assertion pass. `eslint.config.js:27` ignores a bare `dist`,
  expected (per ESLint's doc'd "no-slash pattern matches at any depth") to cover
  `packages/idml-roundtrip/dist/` too — but it doesn't: once that gitignored package is
  built (`pnpm build` runs `tsc -b`, which compiles it as a project reference),
  `packages/idml-roundtrip/dist/engine.js` and `legacy.js` show up in `pnpm lint` with an
  `Unused eslint-disable directive (no-control-regex)` warning baked into the compiled
  output. Confirmed by `rm -rf packages/idml-roundtrip/dist && pnpm lint`: problem count
  drops back to exactly the pre-build baseline (780 problems, identical file list).
- **Friction**: `pnpm lint` is stateful depending on whether `packages/idml-roundtrip`
  has been built locally in this checkout — a contributor who runs `pnpm build` before
  `pnpm lint` sees 2 extra warnings a contributor who doesn't never sees, purely from
  build-artifact non-determinism in the checkout, not from source changes.
- **Why deferred**: `eslint.config.js` is config, not one of this run's rotation themes,
  and touching the ignore pattern needs its own verification pass (confirm it actually
  excludes the nested dist without accidentally widening scope elsewhere) — out of budget
  for a run already spending its diff on `milestones.ts`.
- **Proof needed**: change `globalIgnores(['dist', '.claude'])` to a pattern that also
  matches nested package `dist/` dirs (e.g. add `'**/dist'` alongside the existing
  `'dist'` top-level entry, or confirm why the documented any-depth semantics aren't
  applying here — worth reading the `eslint/config` `globalIgnores` implementation before
  changing the pattern). Verify with the same `rm -rf packages/*/dist && pnpm build &&
  pnpm lint` byte-diff technique used to confirm this finding.

## "D1 is the live datastore" comment drift

- **Status**: `src/hooks/` and `src/components/` slice done in the 2026-08-11 run (7 files).
  A second slice done in the 2026-08-19 run (8 files, comment-only, reworded to "Postgres"):
  `src/lib/sync/audit-stats-overlay.ts`, `src/lib/sync/project-settings.ts`,
  `src/lib/sync/file-projection.ts`, `src/lib/sync/events-emit.ts`,
  `src/lib/audio/transcribe.ts`, `src/lib/audio/timings.ts`, `src/lib/rules/edit-miner.ts`,
  `src/lib/export/export-service.ts`. The last two remaining files,
  `src/lib/frontier/members.ts:21` and `src/lib/global-tm/index.ts:17`, were fixed in the
  2026-09-02 run (reworded to "Postgres" — same treatment). `src/lib/migrate/group-sync.ts:5`
  already frames it as historical ("completing the D1→Neon cutover") — confirmed correct
  as-is, leave alone.
- **False positives to skip** (not database D1 — a paragraph-model spec-section tag, see
  `docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md`):
  `src/hooks/useCells.ts:123,309`, `src/lib/parsers/paragraphs.ts`, `src/lib/parsers/types.ts:
  52`, `src/lib/sync/bulk-import.ts:67`, `src/lib/parsers/usfm-lossless.ts:31`,
  `src/lib/parsers/text-splitter.ts:6`, `src/lib/sync/project-settings.ts:65` ("D10" spec
  tag). Also skip `AD-2 chain pointer... entry came from D1` at `src/lib/parsers/types.ts:723`
  only after re-reading in context (mixed usage nearby).
- **Remaining**: none known as of 2026-09-02 — a fresh repo-wide grep would be needed to
  confirm before closing this entry outright.

## "frontier-server" mentions in sync-worker — done 2026-09-02

- **Status**: fixed in the 2026-09-02 run. `sync-worker/src/cors.ts:4` and
  `sync-worker/src/events/role-policy.ts:3` reworded "frontier-server" → "auth-worker"
  (confirmed via `grep -rn "SYNC_SECRET_KEY" auth-worker/src` that auth-worker, not any
  retired service, is the actual server-to-server caller and role-hierarchy owner).
  `sync-worker/.dev.vars.example:4-6` (not source code, but same drift) also reworded.
  `sync-worker/src/admin.ts:24` — the entry that originally flagged this file no longer
  applies; a fresh grep found no "frontier-server" text left in `admin.ts` (already fixed
  or moved by an unrelated change since the candidate was logged).
- **Left alone (correctly historical, not drift)**: `sync-worker/src/events/role-policy.ts`
  is the only sync-worker hit that was live-framed. `src/lib/frontier/auth.ts:4` ("History:
  this file previously fetched... legacy frontier-server... Phase D cuts that dependency")
  and `src/lib/sync/sync-token.ts:7` ("old frontier-server still work" as an E2E-mock
  fallback) both already use explicit historical/legacy framing — correct as-is, same
  distinction the D1-comment-drift entries below already draw.
- **Still blocked (test file, frozen zone)**: `src/lib/frontier/roles.test.ts:24` — see the
  dedicated ledger entry below.
- **Proof**: comment-only edits; sync-worker suite 130/130 files, 1543/1543 tests, both
  baseline and after, byte-identical.

## Additional candidates from the 2026-08-11 component cleanup run

- **`src/components/RulesPage.tsx`** — done in the 2026-09-14 run. Confirmed zero real
  importers (no route entry in `App.tsx`, no colocated test file, not brand-gated, not
  imported by any e2e spec — `e2e/JOURNEYS.md` mentions it only in prose, which is a
  frozen path left untouched). `RulesSurface` (mounted via `ProjectSettings/RulesSection.tsx`)
  is the confirmed live replacement — it re-imports `BuiltinChecksList`, the same shared
  child `RulesPage.tsx` used to render. Deleted the 347-line file plus its now-orphaned
  `eslint-suppressions.json` entry, and fixed three directly-stale comments this deletion
  caused (`src/lib/qa/checks.ts`, `src/hooks/useOrgSettings.ts`,
  `src/components/onboarding/ProductTour.tsx` — all referenced `RulesPage.tsx` as a live
  convention example). `pnpm test` full suite: 1070/1070 files passed after (baseline had
  1 pre-existing failure, the known `AssignedToMe.test.tsx` full-suite-only flake — see the
  issue #410 family below — which did not reproduce this run, consistent with intermittent).
  It turned out **not** to have a colocated test (the original 2026-08-11 note guessed
  "671 lines total" including a test file that doesn't actually exist).
- **`src/components/TerminologyPage.tsx`** and its test (2,034 lines total) — superseded
  by `GlossaryEditorContent` / `GlossaryEditor`. This needs a dedicated review because of
  its size; confirm no e2e spec still depends on it.
- **`src/lib/sync/projects-read.ts`**, `projects-read-types.ts`, and their test (220 lines)
  — unused Phase 2b wrapper. Grep precise paths/exports before deleting: a different,
  live `fetchAccessibleProjects` exists in `cloud-projects.ts`. **Blocked** by this
  routine's "no test file may be modified" rule: its only real importer is its own test
  file (`projects-read.test.ts`), and deleting the source without the test breaks the
  suite — the test would need to be deleted too, which this routine cannot do. Needs a
  human (or a non-code-health change) to remove the pairing together.

## `rules.page.*` i18n keys — orphaned by the `RulesPage.tsx` deletion above (2026-09-14)

- **Found**: while deleting `src/components/RulesPage.tsx` this run, confirmed via
  `grep -rn "rules\.page\." src --include=*.tsx --include=*.ts | grep -v src/lib/i18n/`
  (empty result) that 7 message keys under the `rules.page.*` namespace —
  `rules.page.heading`, `rules.page.corpusLoadErrorPrefix`, `rules.page.readOnlySuffix`,
  `rules.page.rulesCardTitle`, `rules.page.noRulesYet`, `rules.page.deleteRuleDialogTitle`,
  `rules.page.deleteRuleAriaLabel` — defined in `src/lib/i18n/namespaces/rules.ts` (under
  its `── RulesPage.tsx (standalone rules page) ──` section header, ~line 385) were used
  by nothing else. (`rules.loadingLabel`, defined in the same block, is *not* orphaned —
  `src/components/ProjectSettings/RulesSection.tsx:129` still uses it, so leave it alone.)
- **Friction**: each key also has a translated entry in every locale message file under
  `src/lib/i18n/messages/*.ts` (confirmed present in at least `mfa.ts`, `zh-Hans.ts`,
  `zh-Hant.ts`, `ar.ts`, `my.ts`, `th.ts` — likely all ~14+ locales). Removing the 7 keys
  cleanly means touching the base namespace file's `messages`/`context.keys` blocks *and*
  every locale file's corresponding entries — easily 15-20 files, well past this run's
  single-theme budget when it's already spent on the component deletion itself.
- **Why deferred**: pure scope-control — orphaned translation strings are inert (unused
  keys don't fail build/lint/test), so there's no urgency forcing this into the same PR as
  the component deletion. A future type-tightening or dead-code run can pick this up as its
  own single-file-family sweep.
- **Proof needed**: re-confirm each key still has zero non-i18n-file references (code
  moves), then delete the `messages`/`context.keys` entries in `rules.ts` plus the matching
  key in every locale file under `src/lib/i18n/messages/`; `pnpm build` and `pnpm test`
  should stay green throughout since nothing reads these strings.
- **Grown by the 2026-09-18 run**: deleting `RuleCreateDialog.tsx` and `RuleSuggestDialog.tsx`
  (the two dialogs `RulesPage.tsx` was the only render site for — see the entry below)
  orphaned 18 more keys in the same namespace file and the same way: 15 under
  `rules.createDialog.*` (`namePlaceholder`, `descriptionLabel`, `ruleTypeLabel`,
  `checkType.sourceTargetMatch`, `checkType.sourceRequiresTarget`, `checkType.targetForbids`,
  `patternRegexLabel`, `patternFieldHint.match`, `forbiddenPatternRegexLabel`,
  `patternFieldHint.forbidden`, `sourcePatternRegexLabel`, `requiredTargetPatternRegexLabel`,
  `testYourRuleHeading`, `testSourcePlaceholder`, `testTargetPlaceholder`, `testButton`) and
  3 under `rules.suggestDialog.*` (`description`, `analyzeButton`, `analyzedSummary`).
  Confirmed orphaned by `grep -rn "rules\.createDialog\.\|rules\.suggestDialog\." src e2e
  scripts | grep -v src/lib/i18n/` (empty). The live in-shell surface uses the separate
  `rules.surface.*` namespace, so nothing shares these. Their two
  `── RuleCreateDialog.tsx ──` / `── RuleSuggestDialog.tsx ──` section-header comments in
  `namespaces/rules.ts` now point at deleted files; they were deliberately left in place so
  the still-present keys keep their provenance — remove the headers together with the keys,
  not before. Whoever picks this up should sweep all three prefixes (`rules.page.*`,
  `rules.createDialog.*`, `rules.suggestDialog.*`) in one pass: same files, same proof.

## 2026-09-18 — `RulesPage.tsx` orphan follow-up shipped; rest of the zero-importer sweep deferred

- **Done this run**: deleted `src/components/RuleCreateDialog.tsx` (459 lines) and
  `src/components/RuleSuggestDialog.tsx` (281 lines), plus the now-unused
  `eslint-suppressions.json` entry for the latter (4 `i18n/no-unkeyed-string` suppressions —
  ESLint's `--report-unused-disable-directives` bookkeeping flags a stale entry, so it had to
  go in the same commit). Both were imported by exactly one file ever,
  `src/components/RulesPage.tsx` (lines 14-15 of the pre-deletion file, rendered at 203-204),
  which the 2026-09-14 run deleted — so this is that run's leftover debris, not a new finding.
  Both have shipped replacements rendered by the live `RulesSurface`: `RuleEditor` inside
  `RulesSurface`'s own `createRuleDialog`/`createOrgRuleDialog` (workstream B of
  `docs/plans/rules-revamp.md`, "Redesign `RuleCreateDialog` into an inline rule editor on the
  surface") and `RuleSuggestFromEditsDialog` for the LLM-suggest path.
- **On the `SWARM-TODO(memory-wiring)` in the deleted `RuleSuggestDialog`**: its props block
  carried a SWARM-TODO asking `ProjectWorkspace.tsx` to thread a `cells` snapshot "wherever it
  is rendered". Checked against the `useSubscribedConcepts.ts` precedent below (staged
  scaffolding that must NOT be deleted) and judged different in kind: that TODO waits on a
  server route that does not exist yet, whereas this one was satisfied by supersession —
  `RulesSurface.tsx:256-261` already passes `cells` to the replacement
  `RuleSuggestFromEditsDialog`, and `ProjectWorkspace.tsx` never rendered the old dialog at
  all. Nothing forward-compat was erased.
- **Deliberately left alone**: `src/lib/rules/rule-suggester.ts`. Deleting `RuleSuggestDialog`
  leaves its `suggestRulesFromPairs` export with no production caller (only
  `rule-suggester.test.ts` exercises it), but the module stays live for its other exports
  (`RuleSuggestion`/`UsageCallback` types used by `RuleImportDialog`, `RuleImportReview`,
  `rule-extractor.ts`, `brief-generator.ts`; `suggestRulesFromCandidates` used by
  `RuleSuggestFromEditsDialog`). Removing just the one function would require editing its
  test — a frozen path for this routine. Same shape as the `projects-read.ts` blocker below;
  needs a human or a non-code-health change.

## Zero-importer sweep leftovers — 2026-09-18

A corrected repo-wide sweep this run (match `"…/<stem>"` in any import/export specifier
across `src`, `e2e`, `scripts`, all four worker packages, `parity` and `index.html`) turned up
these besides the two files deleted above. None were attempted — the run's budget was spent —
and each needs its own zero-importer re-verification before deletion, since files move.

- `src/components/CheckFileButton.tsx` (100 lines) — zero references anywhere in code; only
  mentions are an i18n section-header comment and two historical docs
  (`docs/superpowers/plans/2026-08-10-namespace-partition.md`). Likely the same
  supersession story as the rules dialogs (`CheckFindingsDrawer` is the live surface), but
  that was not verified this run.
- `src/components/onboarding/checklist/AiProviderStep.tsx` (221 lines) — zero importers, and
  `docs/superpowers/plans/2026-04-23-settings-state-model.md` (Task 5) explicitly plans
  "Delete: `src/components/onboarding/checklist/AiProviderStep.tsx`", replaced by
  `LlmSettingsForm compact` in `AiSetupDialog` and `SetupChecklistDrawer`. Reads like a
  half-completed migration — confirm both call sites actually swapped before deleting.
- `src/components/AudioRecorder/RecordingVideoStage.tsx` (134 lines) — zero references
  anywhere in the repo, not even in docs. Note the neighbouring
  `RecordingVideoSurface.test.tsx` is a known full-suite timing flake (see the issue #410
  family above), so a deletion here needs extra care reading the before/after failure lists.
- `src/lib/audio/browser-process-stub.ts` (14 lines) — a worker-only `process` stand-in for
  phonemizer, with zero references including in `vite.config.ts`. Probably orphaned when an
  alias was removed, but bundler shims are exactly the kind of thing a grep sweep gets wrong;
  needs someone to confirm no build config reaches it by path before it goes.
- `src/components/ui/{attachment,item,toggle-group,bar-spinner}.tsx` (537 lines total) —
  unused shadcn/ui primitives. Deliberately NOT logged as dead code: `src/components/ui/` is
  a vendored primitive library where "added ahead of first use" is normal, and `shadcn add`
  would just re-create them. Only worth touching if a human says the repo prefers a
  strictly-used-only `ui/` directory.
- Known-and-blocked, unchanged this run: the 15-file `src/components/import/*` orphan cluster
  (~3,900 lines, blocked on issue #410), `src/components/TerminologyPage.tsx` (1,535 lines,
  plus the `src/lib/terminology/candidates-worker.ts` it lazily imports — 66 lines that become
  dead with it), and `src/hooks/useSubscribedConcepts.ts` (looks dead, is not — see below).

## 2026-08-11 — type-tightening + complexity survey (chore/code-health-2026-08-11, second run)

This run removed 13 redundant non-null assertions (type-tightening theme). The same
survey turned up a complexity-reduction (theme 2) candidate and one more type-tightening
spot, both deferred rather than mixed into the single-theme budget.

- **Status**: both complexity-reduction candidates were completed on 2026-08-14.
  `roles.ts` now uses the single canonical `ROLE_INFO` lookup integrated from PR #395;
  `CellAudioButton.tsx` uses the icon and tooltip lookups from PR #391. Their exported
  signatures and fallback values remain unchanged.

- **`src/lib/text/word-diff.ts`** — done in the 2026-08-24 run: all 14 non-null
  assertions in the LCS DP loop removed (TS already infers the narrower type without
  `noUncheckedIndexedAccess`). `pnpm test src/lib/text/word-diff.test.ts` green
  (4/4), `pnpm test` full-suite failure list byte-identical to baseline (8 files / 10
  tests, all pre-existing), `pnpm lint` problem count unchanged (782, both runs
  measured twice to rule out cache noise), no test file touched.

## 2026-08-24 — fresh `!`-assertion grep, more spots than fit one run's budget

A repo-wide `grep -rEn "\w+\[[a-zA-Z0-9_+ ]+\]!" src` (excluding `*.test.ts`) after the
`word-diff.ts` pass above still turns up ~29 more array-index non-null-assertion sites,
same "redundant because there's no `noUncheckedIndexedAccess`" story (confirmed:
`tsconfig.app.json` has `strict: true` but not `noUncheckedIndexedAccess`, so plain
`arr[i]` already types as non-optional and the `!` is a no-op erased at compile time —
safe to drop without changing runtime behavior). Not attempted this run to keep the
diff to one dedicated, carefully-checked file per the queued candidate's own caution
about bulk-edit transcription risk in dense assertion clusters. Grouped by file for a
future pass (verify each still applies — code moves):
  - **Status**: `src/lib/import/milestones.ts` done in the 2026-08-26 run — all 9
    array-index non-null assertions removed (`fallback[index]!` sites at lines 144, 173,
    217, 219, 270×2, 328×2, 417; the actual count was 9, not the 7 estimated here). The
    `fileId!` assertion at line 401 was left alone — it narrows a `string | undefined`
    via disjunctive control flow (`!fileId && !groupId` guard) that TS can't re-derive
    locally, a genuinely different case from the indexing no-ops. `npx tsc --noEmit`
    scoped check clean, `pnpm test` full-suite failure list matched baseline (2
    pre-existing flaky UI-timing failures, different specific files each run — confirmed
    flaky, not a regression), `pnpm lint` problem list byte-identical to baseline once
    accounting for an unrelated `packages/idml-roundtrip/dist` build-artifact warning
    (see new entry below), no test file touched.
  - **Status**: `src/lib/milestone-navigation.ts`, `src/lib/biblica/treasure-hunt/notes.ts`,
    `src/lib/biblica/treasure-hunt/note-rules.ts`, `src/lib/biblica/reach4life/notes.ts`,
    `src/lib/idml/completion.ts`, `src/lib/migrate/idml.ts`, `src/lib/migrate/map.ts`, and
    `src/lib/export/exporters/vtt.ts` done in the 2026-09-07 run — all 17 array-index
    non-null assertions across those 8 files removed (each site individually verified as a
    loop invariant, a prior length guard, or a fixed-length array populated for every
    index). `pnpm test` full-suite went from 1 pre-existing failure
    (`RecordingVideoSurface.test.tsx`, a known timing flake — see the environment-note
    section below) at baseline to 1016/1016 passing at final (the flake didn't reproduce
    that run, consistent with intermittent), `pnpm lint` problem count byte-identical
    (389: 13 errors, 376 warnings) once accounting for the `packages/idml-roundtrip/dist`
    build-artifact noise below, no test file touched. Baseline and final were each run in
    a fully isolated `git worktree`/checkout to rule out read races with the edits.
  - **Status**: `src/lib/export/audio-bwf.ts`, `src/lib/export/audio-by-character.ts`,
    `src/hooks/useActiveCellStore.ts`, `src/components/MultiProjectInviteDialog.tsx`, and
    `src/lib/import/normalized-manifest.ts` done in the 2026-09-11 run — 5 redundant
    array/index non-null assertions removed (each a loop-bounded array index or a
    `Record<string, T>` index-signature read, both typed non-optional without
    `noUncheckedIndexedAccess`). `src/lib/audio/whisper-worker.ts:186` was in this list but
    turned out **not** redundant: `npx tsc -b` failed after removing it —
    `c.timestamp` is `[number | null, number | null]` (an explicit nullable tuple, not an
    inferred-non-optional index read), and the `!` narrows past a `.filter(c =>
    c.timestamp[0] != null && ...)` guard that TS can't carry through the chained `.map()`.
    Reverted that one site; left as a genuine assertion, not a candidate for a future pass.
    `npx tsc -b --force` clean on the other 5, `pnpm lint` byte-identical to baseline (once
    excluding `packages/idml-roundtrip/dist`, rebuilt as a side effect of `tsc -b` — see the
    build-artifact-noise entry below), `pnpm test` 1058/1058 files identical pass count
    before and after, no test file touched.
- **Proof needed when revisited**: same as this run — isolate with `npx tsc --noEmit -p
  tsconfig.app.json` scoped to the touched file(s) plus full `pnpm test`/`pnpm lint`
  byte-identical-failure-list comparison; no test files touched.

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
environment gap, not something a code-health PR should try to patch around. The 2026-09-18
run hit it again, unchanged and with the same message; worth noting for anyone reading a
red smoke result in one of these PRs that it fails at `[boot 2/8] resetting … postgres
schema`, i.e. before Playwright loads a single spec, so it cannot be sensitive to the diff
under test — it is a hard no-result, not a failing assertion.

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
- **More evidence, 2026-09-02 run** (comment-only diff, zero test-file-count change, so this
  confirms the flake isn't specific to file-count churn): three full-suite `pnpm test` runs
  against the *same* 5-file comment-only diff produced three different failure sets —
  baseline 1 file/2 tests (`ArchivedProjects.test.tsx`), run 2 added
  `RecordingVideoSurface.test.tsx` (2 files/3 tests), run 3 added
  `AssignedToMe.test.tsx` instead (3 files/4 tests, `ArchivedProjects.test.tsx` present in
  all three). All three newly-seen files pass 100% in isolation
  (`pnpm test <file>`). None of the failing files import or relate to any file this run
  touched (`sync-worker/src/cors.ts`, `sync-worker/src/events/role-policy.ts`,
  `sync-worker/.dev.vars.example`, `src/lib/frontier/members.ts`,
  `src/lib/global-tm/index.ts`) — same worker-sharding/ordering mechanism as the
  `TeamsList.test.tsx` case above, just a wider set of affected files than previously
  logged.

## 2026-08-31 run — reconfirmed the full `ImportDialog` orphan cluster; issue #410 still open

A dead-code research pass this run (independent grep, not reusing the 2026-08-17 list)
re-derived the same finding above and filled in the remaining file names. The full orphan
set in `src/components/import/` — all shadowed by same-named inline functions defined
directly inside `ImportDialog.tsx`, confirmed zero imports from `ImportDialog.tsx` or
anywhere else except an isolated two-file internal cluster (`HelloaoPanel.tsx` →
`ImportDialogBackButton.tsx`, `UploadPanel.tsx` → `ParatextChoice.tsx`) — is:
`ImportLanding.tsx`, `UploadPanel.tsx`, `EBiblePanel.tsx`, `HelloaoPanel.tsx`,
`ObsPanel.tsx`, `DcsPanel.tsx`, `MaculaPanel.tsx`, `TnPanel.tsx`, `BiblicaPanel.tsx`,
`SdbhPanel.tsx`, `DirectionPanel.tsx`, `ImportResultPanel.tsx`, `CollisionPanel.tsx`,
`ParatextChoice.tsx`, `ImportDialogBackButton.tsx` — 15 files, ~3,900 lines total.

[genesis-ai-dev/aquilla#410](https://github.com/genesis-ai-dev/aquilla/issues/410) (the
`TeamsList.test.tsx` order-dependent flake blocking this) is still **open**, unassigned,
no linked PR. This run's own `pnpm test` baseline/final comparison did not trigger it
(failure list byte-identical both times: `ArchivedProjects.test.tsx`,
`RecordingVideoSurface.test.tsx`, unrelated to this cluster) — consistent with #410 being
neighbor/order-dependent rather than reliably reproducing on every run. Until #410 is
fixed, deleting this cluster still can't be proven behavior-preserving by this routine's
own green-to-green standard; re-verify zero-importer status again before deleting once
unblocked, since files move.

## Remaining "frontier-server" comment mention (frozen — test file)

- **File**: `src/lib/frontier/roles.test.ts:24` — a code comment referencing
  "frontier-server's `ROLE_NAMES` / migration 0013" inside a test file.
- **Friction**: same stale-terminology issue as the (now-fixed) src comments — the service
  is `auth-worker`/`aquilla-identity`, not `frontier-server`.
- **Why deferred**: the code-health routine's frozen zones forbid touching test files, even
  for a comment. Needs a human or a non-code-health change to fix.
- **Proof needed**: comment-only edit inside a test file; would need explicit sign-off
  since it falls outside the routine's "no test files" rule.
