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
- **Remaining**: none. **Closed 2026-09-25** by the fresh repo-wide grep this entry asked
  for: `grep -rniE "\bD1\b|d1_databases|D1Database"` over `src/`, `auth-worker/src`,
  `sync-worker/src`, `agent-worker/src` and `worker/` returns only (a) the paragraph-model
  `D1` spec tags listed above, (b) the contextual-pipeline "design §8, slice D1" tags in
  `auth-worker/src/{index,routes/contextual,lib/contextual/tick,services/sync-worker-notify}.ts`,
  (c) the `retention.d1`/`d7`/`d30` day-N field names in `auth-worker/src/lib/retention.ts`
  and `src/lib/frontier/admin.ts`, (d) correctly historical framing of the cutover in
  `auth-worker/src/index.ts:382-408` and `sync-worker/src/index.ts:7-124`, and (e) the
  **live** legacy-identity bridge (`auth-worker/src/services/frontier-d1.ts`,
  `legacy-user-migration.ts`, `routes/auth.ts`, `types.ts:114-118`), which really does read
  a separate Cloudflare D1 over its HTTP API and is not datastore drift. Nothing left to
  reword. Do not reopen without a *new* hit outside those five groups.

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
- **`src/components/TerminologyPage.tsx`** — done 2026-09-21 (`chore/aqu-1335-remove-dead-terminology-page`, AQU-1335).
  Zero importers since the 2026-07-08 glossary-editor swap: `/project/:id/terminology`
  renders `GlossaryEditor`, lazily mounted by `ProjectWorkspace.tsx`. It had stopped being
  harmless — PR #540 (AQU-208) applied its role-gating fix here, so the fix never reached
  users and the QA walk failed twice. Deleted the 1,535-line page plus everything only it
  reached: `TerminologyMergeDialog.tsx` (351), `TerminologyReviewQueue.tsx` (210),
  `CandidateTermsPanel.tsx` (151), `src/lib/terminology/candidates-worker.ts` (66, its
  `?worker` lazy import) and `src/lib/terminology/stats.ts` + `stats.test.ts` (206 + 230, the
  `LibraryStatsHeader` model). Like `RulesPage.tsx` it had no colocated test, and no e2e spec
  or page object referenced any of its test ids. On `CandidateTermsPanel`'s
  `SWARM-TODO(glue): mount this in the terminology view`: satisfied by supersession, not
  erased — the glossary-editor spec folds the review-queue and candidates panels into the
  surface, and `GlossaryEditor`'s "Suggest terms" calls `extractCandidates` itself and lands
  the results as draft rows. **Not** superseded: merge-duplicates. The spec keeps it ("mergeable
  via multi-select into the existing `TerminologyMergeDialog`") and the plan lists
  re-surfacing it as a follow-up, but nothing on the live surface has offered it since the
  swap. `mergeConcepts()` in `store.ts` and its tests are deliberately kept so that
  follow-up only needs UI; the dialog is recoverable from git (`git show
  707287dfd:src/components/TerminologyMergeDialog.tsx`). **Re-surfaced 2026-09-21 (AQU-1337)**:
  the dialog is back byte-for-byte and `GlossaryEditor` mounts it behind a "Merge duplicates"
  toolbar button, writing through `persist(mergeConcepts(…))`. Kept because `GlossaryEditor` still
  uses them: `TerminologyTermDetail`, `TerminologyViolationsInbox`, `candidates.ts`,
  `csv.ts`, `tbx.ts`, `store.ts`.
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

## `terminology.*` i18n keys — orphaned by the `TerminologyPage.tsx` deletion (2026-09-21)

- **Found**: deleting `TerminologyPage.tsx` and the modules only it reached (see the
  component-cleanup entry above) left 65 of the 239 keys in
  `src/lib/i18n/namespaces/terminology.ts` with no reader — **51 since AQU-1337 re-surfaced
  merge-duplicates** and put the 12 `terminology.mergeDialog.*` keys,
  `terminology.page.mergeDuplicatesButton` and `terminology.common.noRenderings` back in use;
  the lists below are the 51. Proof: for every key in the
  namespace's `messages` block, search all tracked `src`/`e2e`/`scripts`/`worker`/`tools`
  source outside `src/lib/i18n/` for the quoted key, then keep only the misses that the
  deleted files *did* reference. No live code builds a `terminology.*` key dynamically
  (no `` `terminology.…${ `` template anywhere), so a literal search is sufficient.
  - `terminology.page.*` (16): `editConceptAria`, `deleteConceptAria`,
    `reviewQueueCountLabel`, `candidateTermsCountLabel`, `addConceptButton`,
    `editConceptTitle`, `deleteConcept`, `deleteNamedConcept`,
    `reviewQueueHeading`, `candidateTermsHeading`, `conceptsHeading`, `noConceptsTitle`,
    `noConceptsDescription`, `addFirstConceptButton`, `renderingsColumnHeader`,
    `deleteConceptDialogTitle`
  - `terminology.candidates.*` (11): `emptyTitle`, `emptyDescription`, `countRankedByNc`,
    `ncTooltip`, `cTooltip`, `g2Tooltip`, `promoteButton`, `minedFromSummary`,
    `corpusScopeFull`, `corpusScopeCapped`, `miningLabel`
  - `terminology.libraryStats.*` (7): `heading`, `noActiveConcepts`, `activeConceptsLabel`,
    `enforcedLabel`, `infringedLabel`, `cellsAnalyzedLabel`, `mostInfringedLabel`
  - `terminology.reviewQueue.*` (6): `approveAria`, `rejectAria`, `readOnlyTooltip`,
    `emptyTitle`, `emptyDescription`, `awaitingReviewCount`
  - `terminology.importDialog.*` (6): `title`, `parsing`, `dropZoneText`,
    `chooseFileButton`, `csvColumnsHint`, `tbxDialectsHint`
  - `terminology.common.*` (3): `managed`, `notesLabel`, `statusLabel`
  - `terminology.conceptDialog.*` (2): `renderingPlaceholder`, `targetRenderingsLabel`
- **Already orphaned before that deletion** (same search, but the deleted files never
  referenced them either — 6 keys): `terminology.editor.loadingTermDetails`,
  `terminology.editor.errorConflict`, `terminology.editor.errorOffline`,
  `terminology.lookup.applyAria`, `terminology.lookup.applyButton`,
  `terminology.addConcept.description`.
- **Friction** — same shape as the `rules.*` entry above, plus two things that entry did
  not hit:
  - `Catalog` is `Partial<Record<MessageKey, MessageValue>>`, so a key dropped from the
    base namespace becomes an excess-property **tsc error** in every locale catalog that
    still carries it. The removal is therefore all-or-nothing across
    `namespaces/terminology.ts` (`messages` + `context.keys`, ~105 lines), the six
    generated catalogs under `src/lib/i18n/messages/` (62-65 lines each, and their header
    says "Do not hand-edit"), and `src/lib/i18n/source-hashes.json` (~378 lines).
  - `no-duplicates.test.ts` rejects a documented exception whose key no longer collides.
    Four of the orphans carry entries in `namespaces/duplicate-exceptions.ts`
    (`terminology.libraryStats.enforcedLabel`, `…libraryStats.infringedLabel`,
    `…conceptDialog.renderingPlaceholder`, `…common.statusLabel`); those must go in the
    same commit, and the *other* half of each pair needs a re-check for an exception that
    just became stale.
- **Why deferred**: orphaned strings are inert (nothing fails on an unused key), while the
  removal is ~900 lines across 10 high-churn files — three open PRs (#540, #547, #657)
  were in flight against this namespace's surface when the page was deleted, and #657 adds
  ~96 lines to `namespaces/terminology.ts` itself. Do it once those land, in the same
  single pass as the three `rules.*` prefixes above: same files, same proof.
- **Section headers**: the `── TerminologyPage.tsx: … ──`,
  `── TerminologyReviewQueue.tsx ──` and `── CandidateTermsPanel.tsx ──` comments in
  `namespaces/terminology.ts` now name deleted files (`── TerminologyMergeDialog.tsx ──`
  names a live file again since AQU-1337). Left in place on purpose, following
  the `rules.ts` precedent — they are the only provenance the still-present keys have.
  Remove the headers together with the keys, not before.
- **Also stale, not touched**: 28 of the 32 `T-*` rows in `docs/FEATURE-STORIES.csv` (all
  but T-16, T-24, T-30, T-31) cite the deleted files as their code pointers, and the early
  ones describe the retired tabbed page. Most have a live
  equivalent in `GlossaryEditor`, but T-02 (library statistics header) describes a feature
  nothing renders any more while still marked `Implemented`. (T-26/T-27, merge duplicate
  concepts, were in the same state until AQU-1337 re-surfaced merge and re-pointed them.) Re-pointing them is a feature-by-feature check against the live surface,
  not a mechanical path swap.

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

- `src/components/CheckFileButton.tsx` (100 lines) — **done 2026-09-21.** Re-verified zero
  importers; the only remaining mention is the i18n section-header comment at
  `namespaces/rules.ts:111`. Supersession confirmed: `FileChapterToolbar.tsx:52` renders the
  live "Check file" trigger off the same `rules.checkFileButton.label` key, and
  `checkScopeSummary` (the one export it pulled from `CheckFindingsDrawer`) stays live via
  `CheckFindingsDrawer.tsx:301,308`. `FileChapterToolbar.test.tsx:200` asserts the
  `check-file-button` testid is *absent*, so it is unaffected.
- `src/components/onboarding/checklist/AiProviderStep.tsx` (221 lines) — **done 2026-09-21.**
  Both documented call sites are gone: `AiSetupDialog.tsx` no longer exists at all, and
  `SetupChecklistDrawer.tsx` imports seven checklist siblings but reaches AI provider setup
  through `AiModelsStep` instead. The migration the plan doc described had already completed;
  only the orphan file was left.
- `src/components/AudioRecorder/RecordingVideoStage.tsx` (135 lines) — **done 2026-09-23.**
  Re-verified zero references in code. `git log -S RecordingVideoStage` on
  `AudioRecordingModal.tsx` is empty, so the modal never imported it: AQU-906 (`8e7cd8b3`)
  added the component and it was never wired. The film panel that actually shipped is
  `RecordingVideoSurface` (AQU-646 stage 5), rendered at `AudioRecordingModal.tsx:1463` and
  carrying the same `data-testid="rec-video"`. `RecordingVideoSurface.test.tsx` passed at
  both baseline and final gate. Deleting it orphans five `audio.recordingModal.*` keys —
  see the follow-up entry below.
- `src/lib/audio/browser-process-stub.ts` (14 lines) — **done 2026-09-21.** The build-config
  question this entry raised is answered: nothing aliases it. phonemizer's Node detection is
  now patched at transform time by `phonemizerBrowserUnpackPlugin`
  (`scripts/vite-phonemizer-browser.ts`) delegating to
  `src/lib/audio/phonemizer-browser-env.ts`; `vite.config.ts` has no stub alias, and the
  module was debris from the superseded alias-based approach. `pnpm build` stayed green.
- `src/components/ui/{attachment,item,toggle-group,bar-spinner}.tsx` (537 lines total) —
  unused shadcn/ui primitives. Deliberately NOT logged as dead code: `src/components/ui/` is
  a vendored primitive library where "added ahead of first use" is normal, and `shadcn add`
  would just re-create them. Only worth touching if a human says the repo prefers a
  strictly-used-only `ui/` directory.
- Known-and-blocked, unchanged this run: the 15-file `src/components/import/*` orphan cluster
  (~3,900 lines, blocked on issue #410) and `src/hooks/useSubscribedConcepts.ts` (looks dead,
  is not — see below). (`TerminologyPage.tsx` and its `candidates-worker.ts` were listed here
  too; both went on 2026-09-21 — see the component-cleanup entry above.)

## 2026-09-21 — `dev`'s own gates are red, which freezes the i18n catalog

The 2026-09-21 run's baseline (clean tree at `origin/dev` `b001b2cb`) found **`pnpm lint` and
`pnpm test` both failing on trunk**. All of it reproduces in isolation — none are full-suite
flakes — so future runs should expect these and re-baseline rather than assume green:

- `pnpm lint` — exit 2, 6 errors: `sync-worker/src/external/commands.ts:39-42` (four unused
  type imports), `auth-worker/src/routes/changeset-approvals.ts:34` (unused `ROLE`),
  `src/components/org/ProjectAutopilotPanel.test.tsx:439` (`prefer-const` on `gate`). ESLint
  also reports stale `eslint-suppressions.json` entries ("suppressions left that do not occur
  anymore"), which is a *separate* finding from the nested-`dist` entry above.
- `pnpm test` — exit 1, 4 files / 6 tests: `src/lib/i18n/context.test.ts` (2),
  `src/hooks/useProject.deviceLocalLive.test.tsx` (3),
  `src/lib/export/exporters/idml.rejoin.test.ts` (1), and
  `scripts/cloudflare-preview-comment.test.mjs` (a collection error, not a test failure — the
  file imports `node:test` but the root vitest config now sweeps it in).
- `pnpm build` is green.

**Consequence for this ledger**: `src/lib/i18n/context.test.ts` is a whole-catalog invariant
test, so by the routine's "a file whose tests are already red is frozen" rule it freezes
*every* `src/lib/i18n/namespaces/*.ts` file. That blocks the `rules.page.*` /
`rules.createDialog.*` / `rules.suggestDialog.*` orphan-key sweep logged above — which this
run had otherwise fully scoped and verified, and which turns out to be **well inside budget**,
correcting that entry's "easily 15-20 files" estimate:

- The repo has only 6 locale files (`ar`, `ms`, `my`, `th`, `zh-Hans`, `zh-Hant`); `en.ts` is
  a barrel that spreads the namespaces and carries no keys of its own. In every locale file
  the 26 keys sit on 26 contiguous single lines.
- Real scope: `namespaces/rules.ts` (26 keys + 26 `context.keys` entries + 3 section headers)
  + 6 locale files + `namespaces/duplicate-exceptions.ts` + `source-hashes.json` = **9 files,
  ~460 deleted lines**, of which 156 are the inert `source-hashes.json` sidecar.
- Confirmed orphaned repo-wide (`src`, `e2e`, `scripts`, all four worker packages): the only
  non-i18n mentions are this ledger and `docs/swarm/I18N-COVERAGE-ORCHESTRATION.md`'s
  historical retrospective table.
- **`rules.loadingLabel` must survive** — `ProjectSettings/RulesSection.tsx:129` still uses it.
  It sits *inside* the `── RulesPage.tsx ──` section in both the keys block and the context
  block, so it has to be lifted out rather than swept with its neighbours, and its context
  description ("Rendered in two places … the standalone Rules page and the Rules section
  inside Project Settings") is itself drift now that the standalone page is gone.
- **`duplicate-exceptions.ts` must change in the same commit.**
  `no-duplicates.test.ts > keeps every documented exception real and justified` hard-fails on
  an exception for a key that no longer exists, and `rules.createDialog.descriptionLabel` has
  one (it collides with `nav.report.descriptionFieldLabel`). Simulated against the live
  catalog: that is the **only** exception affected — no other entry stops colliding once the
  26 keys go.
- `source-hashes.json`'s 156 orphan entries are provably inert: `i18n-todo.ts` iterates
  `catalogLeafKeys(locale)` (derived from `en`) and only *looks up* hashes, and
  `i18n-catalog.ts`'s `runCheck()` only validates context coverage. They are worth deleting
  for tidiness, not correctness.
- **Proof needed**: whoever picks this up needs `context.test.ts` green first (fix the
  `onboarding.connect.{account,agent,confirm}` context entries), then `pnpm lint`,
  `pnpm build`, `pnpm test` — in particular `no-duplicates.test.ts` and `context.test.ts`.

**Grown by this run**: deleting `CheckFileButton.tsx` orphaned three more keys in the same
namespace — `rules.checkFileButton.{issueCount,lastCheckTooltip,idleTooltip}`. `.label` is
*not* orphaned (`FileChapterToolbar.tsx:52` uses it), so the `── "Check file" toolbar button ──`
section header stays. Deleting `AiProviderStep.tsx` likewise orphans the keys under the
`— AiProviderStep —` header in `namespaces/onboarding.ts:232`. Per the 2026-09-18 convention,
both section-header comments were left in place so the still-live keys under them keep their
provenance; remove each header together with its keys, not before. Sweep all of this in the
one pass with the three `rules.*` prefixes above.

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

## `src/hooks/useSubscribedConcepts.ts` — looked dead, was not (resolved 2026-10-06, AQU-1721)

- **Resolved**: AQU-1721 wired the hook in. `ProjectWorkspace.tsx` and
  `ProjectSettings/RulesSection.tsx` call it, and it has its own test
  (`useSubscribedConcepts.test.tsx`). It is no longer a zero-importer candidate. Its old
  `SWARM-TODO` was stale: the server route it waited for
  (`GET /api/v2/projects/:id/termbase/concepts`) had landed on the same day as the hook,
  2026-06-08, and nothing ever called the hook.
- **History**: flagged by the zero-importer grep sweep of the 2026-08-14 run, and kept
  because its header described staged scaffolding for that route. The other entries in
  this file that cite it as the "looks dead, is not" precedent are records of past runs.

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

## 2026-09-23 — dead-code run: two zero-importer orphans deleted; `dev`'s gates still red

**Done this run** (theme: dead-code deletion, 2 files, 150 lines):

- `src/components/AudioRecorder/RecordingVideoStage.tsx` (135 lines) — see the updated
  entry in the 2026-09-18 sweep-leftovers section above.
- `src/lib/cell-context.ts` (15 lines) — a lone `CellContext` interface. Its own header
  comment records that it was relocated out of `completion/chat-service.ts` when the
  standalone chat service was removed, "so the agent surface owns the type" — but the
  agent surface never picked it up. `grep -rn CellContext` across every `.ts`/`.tsx`/`.mjs`
  in the repo matched only its own declaration line: zero importers, zero symbol
  references, not even a test. Pure relocation debris.

**Sweep method** (worth reusing; it corrects a false-negative in the 2026-09-18 method):
stem-match every import/export/`new URL()` specifier, but build the corpus from **code and
config only — never `.md`**. This ledger names its own candidates in backticks, so a
markdown-inclusive corpus reports live-looking references for files that are in fact dead.
`RecordingVideoStage.tsx` was masked exactly that way. Also allow a trailing query string
in the specifier (`?worker`, `?worker&url`): without it, `parse.worker.ts`,
`livestore.worker.ts`, `idml.worker.ts` and `pcm-capture.worklet.ts` all read as orphans
when each is loaded by a live `import("./x?worker")` call.

**Nothing else in `src/` is a safe deletion right now.** The corrected sweep's full output
was 21 files, and every one of the other 19 is already accounted for: the 13-file
`src/components/import/*` cluster (blocked on issue #410), the three unused `src/components/ui/*`
shadcn primitives (deliberately left — vendored library), `src/hooks/useSubscribedConcepts.ts`
(looks dead, is not), and the four `*.worker`/`*.worklet` false positives above. A matching
sweep over `auth-worker/`, `sync-worker/`, `agent-worker/` and `worker/` found **zero**
orphan modules — only the two `aquilla-db.d.ts` ambient declaration files, which are
included by tsconfig rather than imported.

### Grown by this run: five orphaned `audio.recordingModal.*` keys (frozen)

Deleting `RecordingVideoStage.tsx` orphans `audio.recordingModal.{muteVideoTooltip,
unmuteVideoTooltip, videoMutedBadge, videoMutedWhileRecording, videoScenePreview}` — five
keys × (`namespaces/audio.ts` strings + `namespaces/audio.ts` context entries + 6 locale
files) ≈ 9 files. **Not swept this run**: `src/lib/i18n/context.test.ts` is red on `dev`
(see the 2026-09-21 entry below/above), which freezes every `src/lib/i18n/namespaces/*.ts`
under the routine's "a file whose tests are already red is frozen" rule. Per the
2026-09-18 convention the `RecordingVideoSurface` section header at `namespaces/audio.ts:323`
stays — the surface's own keys under it are live. Sweep these together with the
still-pending `rules.*` / `onboarding` orphan keys once `context.test.ts` is green.

### Baseline recorded 2026-09-23 (`origin/dev` `6cf6da70`) — `dev` is redder than on 2026-09-21

- **`pnpm build`** — green.
- **`pnpm lint`** — exit 2, **130 errors** (up from 6 on 2026-09-21), 901 warnings. 122 of
  the 130 are `i18n/no-unkeyed-string` in the new billing surfaces:
  `src/pages/settings/OrgSettingsBilling.tsx` (25), `src/components/org/BillingOffers.tsx` (23),
  `BillingPlanReview.tsx` (20), `BillingChangeReview.tsx` (19), `BillingWorkspaceSummary.tsx` (17),
  `src/pages/BillingSelection.tsx` (16). The other 8: the four unused type imports at
  `sync-worker/src/external/commands.ts:39-42` and the unused `ROLE` at
  `auth-worker/src/routes/changeset-approvals.ts:34` (both carried over from 2026-09-21),
  plus three new ones — `scripts/migrate-daemon/loop.ts:251`
  (`@typescript-eslint/no-unused-expressions`), `src/components/org/ProjectAutopilotPanel.test.tsx:439`
  (`prefer-const`, carried over), and `src/components/voice/InworldVoiceDesignField.tsx:239`
  (`react-hooks/immutability`). ESLint also still reports stale `eslint-suppressions.json`
  entries. A whole keyed-string pass over the billing surfaces is the obvious fix and is
  well outside this routine's budget and remit (it changes user-visible strings).
- **`pnpm test`** — exit 1, 6 files failing, all reproducible rather than flakes:
  - `src/lib/i18n/context.test.ts` — 2 tests, the `onboarding.connect.{account,agent,confirm}`
    missing-context/placeholder issue carried over from 2026-09-21, unchanged.
  - Four `src/components/org/OrgProjectsPage.{guest,pm-filter,role-filter,updated-filter}.test.tsx`
    — **new**, collection errors, not assertion failures: `No "resolveCloudProjectResult"
    export is defined on the "@/lib/sync/cloud-projects" mock`, thrown from
    `src/lib/offline/download.ts:90` via `src/components/org/OrgProjectsDataTable.tsx:8`. A
    `vi.mock` of `cloud-projects` in those four specs went stale against `download.ts`'s
    `defaultDeps`. This freezes `OrgProjectsDataTable.tsx` and `download.ts` for the routine.
  - `scripts/cloudflare-preview-comment.test.mjs` — collection error, carried over from
    2026-09-21 (`Cannot bundle Node.js built-in "node:test"`; the root vitest config sweeps
    in a file written for the node test runner).

  The 2026-09-21 run's `ArchivedProjects.test.tsx` / `RecordingVideoSurface.test.tsx` timing
  flakes did **not** fire in either the baseline or the final run this time.

## 2026-09-25 — type-tightening run: the SPA's last removable `any`s and `!`s

**Done this run** (theme 3, type tightening; 4 files, no test file touched):

- `src/hooks/useProjectSettings.ts` — dropped 3 of the file's 6
  `@typescript-eslint/no-explicit-any` suppressions. The `nonEmptyCount` tally became
  `Object.values(local).filter(…)` (the same idiom the migration guard 11 lines above
  already uses), and the two byte-identical rollback ladders in `patch()` collapsed into
  one `rollbackRejectedKeys()` helper whose per-key write goes through a generic
  `copySettingsKey<K extends keyof ProjectWideSettings>` — a generic key is exactly what
  makes `target[key] = source[key]` typecheck, so the cast that used to paper over the
  `keyof`-union write is gone rather than relocated.
- `src/lib/audio/inworld-design-locales.ts:124`, `src/lib/egress/build-project-export.ts:196`,
  `src/lib/biblica/ebl/notes.ts:459,462,467` — 5 array-index non-null assertions removed.
  Same story as every prior `!` pass: `tsconfig.app.json` sets `strict` but not
  `noUncheckedIndexedAccess`, so `arr[i]` already types non-optional and `!` emits nothing.
  `npx tsc -b` clean after each.

**The `!`-assertion sweep is now finished for `src/`.** A fresh
`grep -rEn "\w+\[[a-zA-Z0-9_+. ]+\]!" src --include=*.ts --include=*.tsx` (minus tests)
returns 6 hits; 5 are the ones deleted above and the sixth is
`src/lib/audio/whisper-worker.ts:186`, already recorded in the 2026-08-24 entry as a
*genuine* assertion (nullable tuple, narrowed across a `.filter()`/`.map()` boundary that
TS cannot carry). The `keep.at(-1)!` in `ebl/notes.ts:461` is likewise genuine — `.at()`
really does return `T | undefined`. Treat this entry as closing the 2026-08-24 candidate.

> **Superseded on merge (2026-09-30).** This run sat unmerged for five days, and the
> **2026-09-28 run below independently removed the same five assertions** (plus seven more in
> `src/lib/export/audio-chapter.ts`) and landed first. Merging `dev` into this branch therefore
> leaves those five as no-ops — both sides made the identical edit, so git auto-merged them with
> nothing left over. Nothing was lost and nothing is duplicated; the only part of the 2026-09-25
> run that still reaches `dev` is the `useProjectSettings.ts` `any` removal above. Both entries
> are kept because each records the reasoning of its own run, and the two agree: the five sites
> were no-op `!`s, and `whisper-worker.ts:186` plus `keep.at(-1)!` are the genuine ones. Read
> the 2026-09-28 entry as the authoritative close of the sweep — it is the wider pass.

### Left behind in `useProjectSettings.ts` — the other 3 `any`s, and why each stays

None of these is a mechanical removal; each would change what the code does or merely
rename the cast. Picking any of them up needs a human who owns the settings↔IDB seam.

- **`{} as any` at the `completionSettings` spread** (was line 480). `CompletionSettings`
  has five *required* fields (`endpoint`, `model`, `maxTokens`, `temperature`,
  `systemPrompt`), so `existing.completionSettings ?? {}` genuinely is not one. The cast
  is masking a real gap: when a project has no `completionSettings` yet, this write stores
  `{ systemPrompt }` alone under a key typed as the full object. Removing the `any`
  honestly means either constructing a complete default or widening the field to
  `Partial<CompletionSettings>` — both behavior changes, both out of this routine.
- **The two `as any`s in the IDB forbidden-rollback** (`(next as any)[key] =
  (snapTarget as any)[key]`). `next` is a `ProjectRecord` and `snapTarget` a
  `ProjectWideSettings`; their key sets only partially overlap (`ProjectRecord` carries
  `sourceLanguage`/`targetLanguage`/`rules`/`rulePenalties`/`algorithmicChecks`/`targetLanes`/
  `archivedLanes` but not, e.g., `validationCount*` or `cellEditingFloor`). A type-safe
  version has to name the intersection, which decides *which keys roll back* — i.e. it is a
  behavior decision, not a typing one. **Proof it would need**: the intersection spelled out
  against both interfaces plus a test pinning which keys the IDB rollback touches; there is
  no such test today.

### Nothing else in the SPA or the workers carries a removable `any`

`grep -rn "no-explicit-any" src --include=*.ts --include=*.tsx` (minus tests) is 21 hits in
6 files. Besides `useProjectSettings.ts`, all of them are `window as any` / `performance as any`
debug-global attachments in `EditorTable.tsx`, `ProjectWorkspace.tsx`, `useActiveCellStore.ts`,
`perf-log.ts` and `report-problem.ts` — legitimate, since the properties they set
(`__perfRowRenders`, `__cellStore`, `__aquillaMemorySnapshot`, `togglePerfLog`, PostHog's
undeclared `get_session_replay_url`) are deliberately not on any declared interface. A
matching sweep over `auth-worker/`, `sync-worker/`, `agent-worker/` and `worker/` found
**zero** `any` in production code — every `\bas any\b|: any\b` hit there is the word "any"
inside a prose comment, except `agent-worker/src/resolve-sandbox.ts:10`, which documents its
own `Sandbox<any>` loosening as deliberate. **Theme 3 is exhausted; rotate to another theme
next run.**

### Baseline recorded 2026-09-25 (`origin/dev` `073f1aa4`) — `dev` is greener than on 2026-09-23

- **`pnpm build`** — green.
- **`pnpm lint`** — exit 2, **129 errors**, 910 warnings. Unchanged in character from
  2026-09-23 (the 122 `i18n/no-unkeyed-string` errors in the billing surfaces, the four
  unused type imports at `sync-worker/src/external/commands.ts:39-42`, the unused `ROLE` at
  `auth-worker/src/routes/changeset-approvals.ts:34`, and the three others listed there).
  ESLint still reports stale `eslint-suppressions.json` entries.
- **`pnpm test`** — exit 1, **2 files** (down from 6): `src/lib/i18n/context.test.ts`
  (2 tests, the `onboarding.connect.*` context/placeholder issue, carried over unchanged
  since 2026-09-21) and `scripts/cloudflare-preview-comment.test.mjs` (collection error,
  `node:test`, carried over). 1272 files / 14160 tests passing.
  **The four `OrgProjectsPage.*.test.tsx` collection errors new on 2026-09-23 are gone** —
  the stale `cloud-projects` `vi.mock` was fixed on `dev` since. `OrgProjectsDataTable.tsx`
  and `src/lib/offline/download.ts` are no longer frozen.
- **Still frozen by a red test**: every `src/lib/i18n/namespaces/*.ts` (the whole-catalog
  invariant in `context.test.ts`), which continues to block the pending `rules.*` /
  `onboarding` / `audio.recordingModal.*` orphan-key sweeps logged above.

### Pre-existing, found while getting the e2e gate to run: `auth-worker`'s npm install is broken

`cd auth-worker && npm ci` (and `npm install`) fails outright with `ERESOLVE`:
`auth-worker/package.json` devDeps pin `vitest ^5.0.0`, but its
`@cloudflare/vitest-pool-workers@0.22.0` peers `vitest ^4.1.0`. So the exact command
CLAUDE.md documents for that package — `cd auth-worker && npm test` — cannot be run from a
clean checkout without `--legacy-peer-deps`. `sync-worker` and `agent-worker` both dry-run
clean; `worker/` has no lockfile at all, so `npm ci` is not applicable there. **Not touched
this run** — dependency versions are a frozen zone for this routine, and the fix is a real
decision (downgrade `vitest`, or wait for a `vitest-pool-workers` that peers `^5`). Worth a
ticket: it silently blocks the worker-suite half of every AI or human contributor's gate.

### Running `pnpm test:e2e:smoke` in a Claude-Code-on-the-web container (it *is* possible)

The 2026-09-25 run got the smoke gate to a real 79/79 pass in the cloud sandbox. Recorded
here because the default invocation fails four different ways and each one looks like a
product bug at first glance. None of this is a repo change — it is all container setup:

1. **No Postgres running.** Postgres 16 is installed but the cluster is down:
   `pg_ctlcluster 16 main start`, then create the login role the scripts expect
   (`CREATE ROLE aquilla LOGIN SUPERUSER PASSWORD 'aquilla'`).
2. **`E2E_PG_ADMIN_URL` defaults to a local socket as the current OS user** (root), which is
   not a Postgres role. Export
   `E2E_PG_ADMIN_URL=postgresql://aquilla:aquilla@localhost:5432/postgres`.
3. **Worker `node_modules` are not installed by the root `pnpm i`.** The mock
   legacy-migration server imports `bcryptjs` out of `auth-worker/src/utils/password.ts` and
   dies at boot, which surfaces only as `timed out waiting for .../healthz`. Install
   auth-worker and sync-worker deps (auth-worker needs `--legacy-peer-deps` — see the
   ERESOLVE entry above).
4. **Playwright's pinned Chromium build is not the one on the image.** The repo's
   `@playwright/test` wants build 1234; `/opt/pw-browsers` ships 1194, and the newer
   Playwright also renamed the inner directory (`chrome-headless-shell-linux64/` vs
   `chrome-linux/`). Do not run `playwright install` — symlink instead:
   `/opt/pw-browsers/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`
   → `…/chromium_headless_shell-1194/chrome-linux/headless_shell`, plus `INSTALLATION_COMPLETE`
   and `DEPENDENCIES_VALIDATED` marker files.
5. **Do not use the default 3-way shard.** Three concurrent stacks (3 vite + 6 wrangler +
   chromium) exhaust the container: wrangler dies mid-run and every affected spec fails with
   `TypeError: fetch failed` / `ECONNREFUSED`, which reads exactly like a product regression
   and is not one. Run `npx tsx scripts/e2e-shard.ts 1 -- smoke.spec` instead — 79 specs, one
   worker, ~10 minutes.

## 2026-09-28 — type-tightening run; i18n catalog still frozen, and two baseline notes

**Done this run** (theme: type tightening, 4 files, 12 lines): removed the last 12 redundant
array/tuple-index non-null assertions in `src/`, closing out the sweep the 2026-08-24 entry
opened. All twelve are plain index reads on a non-optional element type, and
`tsconfig.app.json` still has `strict: true` without `noUncheckedIndexedAccess`, so each `!`
was a compile-time no-op erased before emit — `pnpm build` (`tsc -b`) is the proof.

- `src/lib/export/audio-chapter.ts` (7) — `cells[i]`/`cells[j]` inside `chaptersForCells`'s
  `i < cells.length` / `j < cells.length` loops, `headings[h]` under its three
  `h < headings.length` guards in `orderClips`, and `chapterWavs[0]` under an explicit
  `chapterWavs.length === 1`.
- `src/lib/biblica/ebl/notes.ts` (3) — `unit.slots[index]` / `unit.locator.slotIndexes[index]`
  over a `keep` array built from `unit.slots.flatMap((slot, index) => …)`, and
  `unit.slots[last]`. `IdmlTranslationUnit.slots` is `readonly IdmlTextSlot[]` and
  `IdmlLocator.slotIndexes` is `readonly number[]` (`packages/idml-roundtrip/src/types.ts`),
  both non-optional element types. The neighbouring `keep.at(-1)!` was **left alone** —
  `Array.prototype.at` genuinely returns `T | undefined`, so that one is a real assertion.
- `src/lib/egress/build-project-export.ts` (1) — `items[index]` in `mapWithConcurrency`, whose
  parameter is `items: readonly T[]` and which already guards `index >= items.length`.
- `src/lib/audio/inworld-design-locales.ts` (1) — `inFamily[0]` under an explicit
  `inFamily.length === 0` early return.

**The `!`-assertion sweep is now exhausted.** A fresh
`grep -rEn '\w+\[[a-zA-Z0-9_+. -]+\]!' src` (excluding `*.test.*`) returns exactly one
remaining site: `src/lib/audio/whisper-worker.ts:186`, which the 2026-09-11 run already
verified is **not** redundant (`c.timestamp` is an explicit `[number | null, number | null]`
tuple and the `!` narrows past a `.filter()` guard TS can't carry through the chained
`.map()`). Future runs should not re-open this theme against `src/` without a new source of
assertions; the worker packages were never swept and would be the place to look.

### Still frozen: the `rules.*` / `audio.recordingModal.*` / `onboarding` orphan-key sweep

Re-checked this run and **unchanged**: `src/lib/i18n/context.test.ts` is still red on `dev`
with the same two failures and the same six issues, all in one namespace —
`onboarding.connect.{account,agent,confirm}` each need their own context entry and each has an
undocumented placeholder (`{username}`, `{name}`, `{code}`). By the routine's "a file whose
tests are already red is frozen" rule that still freezes every `src/lib/i18n/namespaces/*.ts`,
so the fully-scoped 9-file / ~460-line orphan-key sweep logged in the 2026-09-21 entry above
(plus the five `audio.recordingModal.*` keys the 2026-09-23 run added to it) could **not** be
taken this run either — the fourth run in a row it has been blocked by the same three keys.

Fixing those three context entries is itself out of this routine's remit (a pre-existing
failure is out of scope, and turning a red suite green is not behaviour-preserving), so this
needs a human or a non-code-health change. It is a ~10-line fix in
`src/lib/i18n/namespaces/onboarding.ts` and it unblocks ~460 lines of queued dead-string
deletion; worth filing as its own ticket. Nothing else in the catalog is affected — the
2026-09-21 simulation of the sweep still holds (the `rules.createDialog.descriptionLabel`
exception in `duplicate-exceptions.ts` is still the only one that stops colliding, and
`nav.report.descriptionFieldLabel` is still the only other key rendering "Description").

### Baseline recorded 2026-09-28 (`origin/dev` `900ec3b7`) — `dev` is greener than on 2026-09-23

- **`pnpm build`** — green.
- **`pnpm lint`** — exit 2, **129 errors**, 918 warnings (was 130/901 on 2026-09-23). Same
  composition: the `i18n/no-unkeyed-string` billing-surface block dominates, plus the carried-over
  `sync-worker/src/external/commands.ts:39-42` unused type imports,
  `auth-worker/src/routes/changeset-approvals.ts:34` unused `ROLE`,
  `src/components/org/ProjectAutopilotPanel.test.tsx:439` `prefer-const`, and
  `scripts/migrate-daemon/loop.ts:251` `no-unused-expressions`. Stale
  `eslint-suppressions.json` entries still reported.
- **`pnpm test`** — exit 1, **3 files / 8 tests** (was 6 files on 2026-09-23). The four
  `OrgProjectsPage.*.test.tsx` collection errors are **gone** — that `vi.mock` staleness was
  fixed on `dev`, so `OrgProjectsDataTable.tsx` and `src/lib/offline/download.ts` are no
  longer frozen. Remaining:
  - `src/lib/i18n/context.test.ts` — 2 tests, the `onboarding.connect.*` gap above, unchanged
    since 2026-09-21.
  - `scripts/cloudflare-preview-comment.test.mjs` — collection error, carried over
    (`node:test` import swept in by the root vitest config).
  - `scripts/tag-release.test.ts` — **new, and an environment artifact rather than a `dev`
    regression.** All 6 failures are `expect(run().status).toBe(0)` receiving `1`.
    `tag-release.sh` requires a usable `GITHUB_TOKEN` and shells out to
    `record-github-deployment.mjs`, which calls the GitHub API; in this sandbox `GITHUB_TOKEN`
    is a proxy-injected placeholder and `gh` is absent, so every invocation dies at
    `ECONNREFUSED 127.0.0.1:3000` before the tagging logic runs. Expect these 6 in any
    sandboxed baseline; do **not** log them as a trunk regression, and do not treat
    `scripts/tag-release.*` as frozen on their account alone.

## 2026-10-02 — dead-code run: three zero-importer orphans left by superseded features

**Done this run** (theme 1, dead-code deletion; 3 files, 117 lines, no test file touched):
deleted `src/lib/store/voice-recency.ts` (79), `src/lib/agent/synchronized-scroll.ts` (32)
and `src/components/agent/prompt-hints.ts` (6). All three are orphan debris from features
their callers dropped, not scaffolding added ahead of a caller — the clone is shallow, so
`git log --follow` is useless here, but three grafted historical trees still carry the
callers, which is what makes the supersession provable:

- `src/components/agent/prompt-hints.ts` (`AGENT_PROMPT_HINTS`) — `AgentDockView.tsx:35`
  imported it and rotated through the four hints on a timer (`:106`, rendered at `:294`
  behind `agent.emptyState.tryAsking`). `AgentDockView.tsx:39,236` now renders
  `AgentEmptyState`, which prints one static `agent.emptyState.promptHint` line instead.
  **Orphans one i18n key**: `agent.emptyState.tryAsking` is now referenced by nothing but
  the catalog itself — see the freeze note below.
- `src/lib/agent/synchronized-scroll.ts` (`readCellScrollAnchor`/`applyCellScrollAnchor`) —
  `AgentWorkbench.tsx` imported both (line 30 of the last tree that still had it) for a
  `synchronizeScroll` callback that
  mirrored the scroll position between the source and target panes by cell anchor. That
  two-pane model is gone; the workbench now hosts `WorkingSetPanel` and has no scroll
  handler at all (`grep -n "scrollTop\|onScroll\|anchor" AgentWorkbench.tsx` is empty).
- `src/lib/store/voice-recency.ts` (`useVoiceRecency`/`touchVoice`) — `CellVoicePanel.tsx:24`
  imported both to sort the voice combobox most-recently-used-first (`:386`, `:402-409`).
  AQU-768 replaced that with an explicit cast assignment: the panel resolves the line's voice
  from the saved cast (`CellVoicePanel.tsx:161-173`) and the picker itself is a host-owned
  `voicePicker?: ReactNode`, filled by `CastGutterVoice` at `EditorTable.tsx:7223`. Nothing
  reimplements recency under another key — a repo-wide `recency|mostRecent|MRU` grep over
  `src/lib/store` and `src/lib/audio` returns only this file and an unrelated comment in
  `bytes-cache.ts`. The `frontier:voice-recency:*` localStorage keys this wrote are
  client-owned and simply go unread (no migration needed, nothing durable lost).

**Zero-importer proof**: a repo-wide `grep -rIn` for all five export names plus the three
module stems over everything but `node_modules`/`.git`/`dist` returns only the definitions
themselves. No sibling `*.test.ts` exists for any of the three (so no frozen test blocks the
deletion), none of them appears in `eslint-suppressions.json`, and none produced a lint
diagnostic at baseline — so lint output is byte-identical apart from the files being gone.

### Related sweep, intentionally not taken: 41 more zero-caller exports inside live modules

The same pass ran a whole-`src` export-usage scan (every `export function`/`export const`
name, counted with `grep -rhow` across `src`, `e2e`, `scripts`, all four worker packages,
`parity`, `packages`, `shared`, `smart-tests`, `tools`). Besides the five exports deleted
above it found 41 more names with exactly one occurrence repo-wide — their own definition.
**None is a whole-module orphan**; each sits in a module with other live exports, so each is
a surgical function deletion needing its own supersession story:

`ThemeToggle` (`src/branding/ThemeMode.tsx` — branding, frozen zone),
`cachedTagsForNode`/`getCachedPassageTags` (`src/lib/understanding/passage-tag-store.ts`),
`getAdminAgentSession`/`getAdminAgentSessions` (`src/lib/frontier/admin.ts`),
`inspectIdmlInWorker` (`src/lib/idml/idml-worker-client.ts`),
`screenshotSurface` (`src/lib/i18n/screenshots.ts`),
`sectionProgressToVerseRollup` (`src/lib/progress/canonical-rollup.ts`),
`wavMsForBytes` (`src/lib/audio/recording-limits.ts`),
`formatWordCount` (`src/lib/billing/plans.ts`),
`selectionSize` (`src/lib/audio/selection.ts`),
`useCellStoreViews` (`src/hooks/useActiveCellStore.ts` — **trap zone**, see CLAUDE.md's
`readAtVersion()` note; do not touch),
`migrateComment` (`src/lib/codex-editor/merge/comments.ts`),
`detachProjectSource` (`src/lib/sync/cloud-projects.ts`),
`emitSourceCellReorder` (`src/lib/sync/events-emit.ts` — **frozen**, event contract),
`fetchCommentsForCell` (`src/lib/sync/comments-read.ts`),
`deleteCellsCache` (`src/lib/sync/cells-cache.ts`),
`footnoteRawLeafText`, `sourceLocationFromLocator`, `getCurrentBatchRunId`, `ttsProviderModel`,
plus the prefs getters (`getQueueTargetSlots`, `getQueueTimingMode`,
`getRecordingAutoAdvance`, `getShowHiddenCells`, `isSectionCollapsed`), the feature-flag
hooks (`useAiSectionMilestonesEnabled`, `useMeaningUnitDraftingEnabled`,
`usePassageTagsEnabled`, `useAnyGeminiKeyError`, `useEgressPrefs`,
`useVirtualClockDuration`), the `*ForTests` resets (`resetPericopeIndexForTests`,
`resetShowHiddenCellsCacheForTests`) and the constants (`BRAND_DATA_IDS`,
`CONTEXT_SCHEMA_VERSION`, `DOCX_PARITY_FILE_NAME`, `INWORLD_LANGUAGE_OTHER`,
`INWORLD_TTS_MODEL_STANDARD`, `KNOWN_MARKER_BASES`, `PARATEXT_PTXPRINT_MEMBER_NAMES`).

- **Why deferred**: three different shapes hide in that list and only a per-symbol read tells
  them apart — (a) genuinely superseded code, (b) a paired API whose other half is live
  (`getShowHiddenCells` next to a live setter) where deleting the reader leaves a
  write-only store, and (c) deliberate forward-compat (`useSubscribedConcepts.ts` above is
  the standing precedent: looks dead, is not). A `*ForTests` reset with zero occurrences is
  a fourth shape — if a test did call it the symbol would be frozen, and if none does the
  export is dead but its sibling may still be load-bearing. Working the list properly is one
  theme per cluster, not one run.
- **Proof needed**: per symbol — a repo-wide grep for the name *and* for a dynamic/string
  form of it, the git-history check for a dropped caller (the grafted-tree trick above),
  and `pnpm build` + the owning module's own test file left untouched. Take the three
  feature-flag hooks as one cluster first: they are the most likely to be real debris and
  they share a single supersession question (did the flag ship or get dropped?).

### UNFROZEN at last: `context.test.ts` is green, so the i18n orphan-key sweep can run

**This is the headline for the next run.** `src/lib/i18n/context.test.ts` passed at this run's
baseline — the `onboarding.connect.{account,agent,confirm}` context/placeholder gap that had
blocked it since 2026-09-21 is fixed on `dev`. That ends the freeze on
`src/lib/i18n/namespaces/*.ts` that stopped the queued orphan-key sweep four runs in a row
(2026-09-21, -23, -25, -28 entries above). Strike the "still frozen" language in all four.

Two corrections to the 2026-09-21 entry's scope before anyone picks it up:

- It says "the repo has only 6 locale files (`ar`, `ms`, `my`, `th`, `zh-Hans`, `zh-Hant`)".
  `src/lib/i18n/messages/` now holds **9** — `fr`, `id` and `ru` were added since. So the
  sweep it scoped at 9 files is now **12**, *over* this routine's ≤8-file budget even with
  `context.test.ts` green.
- The queue has grown again: `agent.emptyState.tryAsking`, orphaned by this run's
  `prompt-hints.ts` deletion, joins the `rules.*` / `audio.recordingModal.*` / `onboarding`
  keys. Per the 2026-09-18 convention the key was left in place rather than deleted on its
  own, and its `── AgentDockView ──`-adjacent neighbours (`agent.emptyState.promptHint` is
  **live** at `AgentEmptyState.tsx:100`) must survive.

Recommended split so it fits a single run's budget: one run for the `rules.*` prefixes
(`namespaces/rules.ts` + `duplicate-exceptions.ts` + the locale lines + `source-hashes.json`),
a second for `onboarding` + `audio.recordingModal.*` + `agent.emptyState.tryAsking`. The
2026-09-21 entry's verification work (the `rules.createDialog.descriptionLabel` duplicate
exception is the only one that stops colliding; `rules.loadingLabel` must be lifted out of
the `── RulesPage.tsx ──` section because `ProjectSettings/RulesSection.tsx:129` still uses
it) still holds and should be re-simulated, not re-derived.

### Baseline recorded 2026-10-02 (`origin/dev` `260428b3`) — much redder than 2026-09-28

- **`pnpm build`** — green.
- **`pnpm lint`** — exit 2, **125 errors**, 968 warnings (was 129/918 on 2026-09-28). Same
  composition: the `i18n/no-unkeyed-string` billing-surface block dominates
  (`OrgSettingsBilling.tsx`, `BillingOffers.tsx`, `BillingPlanReview.tsx`,
  `BillingChangeReview.tsx`, `BillingWorkspaceSummary.tsx`, `BillingSelection.tsx`), plus
  `preserve-caught-error` in the workers. Stale `eslint-suppressions.json` entries still
  reported.
- **`pnpm test`** — exit 1, **19 files / 27 tests** failing (was 3 files / 8 tests). 1514
  files / 17127 tests pass. The carried-over failures are **gone** — `i18n/context.test.ts`,
  `scripts/cloudflare-preview-comment.test.mjs` and `scripts/tag-release.test.ts` all pass
  now — but a new and much larger cluster has appeared, and **most of it looks like one root
  cause, not nineteen**: portal/popup-timing failures across unrelated surfaces
  (`ui/tooltip`, `ui/date-tooltip`, `ui/context-menu`, `ui/multi-select-combobox`,
  `AccountSwitcher`, `AddConceptDialog`, `CommentsPage`, `LanguagesSection` (5),
  `ValidationSettingsSection.namedUsers`, `VerseResourcesSidebar` (2), `Settings`,
  `ImportCharactersDialog`, `TimelineEditor` (2)). That is the same family as the
  `ArchivedProjects.test.tsx` flake logged above and issue
  [#410](https://github.com/genesis-ai-dev/aquilla/issues/410), but far wider — it smells
  like a `@base-ui/react` or happy-dom version move rather than 14 independent regressions.
  Plus four that are not portal-shaped: `scripts/rls-coverage.test.ts`,
  `scripts/worker-deployment-contract.test.ts` ("installs Chromium before running IDML
  browser conformance in CI"), `src/lib/languages/full-catalog.test.ts` (memoization),
  `src/lib/milestone-navigation.aiSections.test.ts` (2), and two collection errors
  (`org/BillingPlanReview.test.tsx`, `src/lib/import/timeline-text.contract.test.js`).
  **Out of scope for this routine** (pre-existing, and turning a red suite green is not
  behaviour-preserving) but worth a human's eyes — 27 red tests on trunk is a lot of cover
  for a real regression to hide under. None of the 19 files is near the three deleted
  modules, so none of them froze this run.

### Container setup for the gates (addendum to the 2026-09-25 recipe)

Two deltas from that entry, for the next run in a Claude-Code-on-the-web container:

- **`pnpm i` fails at `onnxruntime-node`'s postinstall** (`ECONNRESET` — the proxy cuts off
  its native-binary download), and the abort leaves `node_modules/.bin` unlinked, so nothing
  runs. Workaround that needs no repo change: drop `onnxruntime-node` from
  `pnpm-workspace.yaml`'s `onlyBuiltDependencies`, `pnpm i`, then restore the file. It is a
  transitive dep and the root suite never loads it.
- **Docker has no daemon here**, so the `aquilla-dev-pg` container route is unavailable —
  but `scripts/e2e-up.ts` falls back to a local `psql` (`:422`), so the local-cluster recipe
  works: `pg_ctlcluster 16 main start`, `CREATE ROLE aquilla LOGIN SUPERUSER PASSWORD
  'aquilla'`, `export E2E_PG_ADMIN_URL=postgresql://aquilla:aquilla@localhost:5432/postgres`.
- **Playwright's pinned Chromium is now revision 1243** (`@playwright/test` 1.63.0); the
  image still ships 1194. Same symlink trick as the 2026-09-25 entry, with the revision
  bumped — and note `npm install` in `auth-worker/`/`sync-worker/` **rewrites their
  `package-lock.json`**, a frozen path for this routine. Check `git status` and revert both
  before committing.

### Gate-comparison trap: baseline `pnpm lint` before `pnpm build` and the outputs drift

Running lint and build concurrently to save wall-clock made this run's final lint report
**970 warnings against the baseline's 968** with a byte-identical error list (125 both
times). The two extra warnings are `Unused eslint-disable directive … 'no-control-regex'` at
`packages/idml-roundtrip/dist/engine.js:1705` and `dist/legacy.js:83` — gitignored build
output that did not exist yet when the baseline lint walked that directory, and that the
build then produced. `npx eslint packages/idml-roundtrip/dist/{engine,legacy}.js` reproduces
both on their own, with no diff in `packages/` at all.

That is a live reproduction of the **ESLint `globalIgnores(['dist', '.claude'])` doesn't
reach nested `packages/*/dist`** candidate logged above — still unfixed, and now with a
concrete symptom: it makes `pnpm lint` output depend on whether anyone has built the
workspace packages recently. For this routine the practical rule is **build first, then
baseline lint** (or compare error lists rather than totals), otherwise every run burns time
chasing two phantom warnings.

### Smoke baseline 2026-10-02: 8 of 96 red, and all 8 are independent of the diff

`npx tsx scripts/e2e-shard.ts 1 -- smoke.spec` (the ledger's one-shard container recipe) came
back **88 passed / 8 failed**. Because this routine's whole proof is green-to-green, the 8 were
A/B'd rather than argued about: the three deleted modules were restored from `HEAD~1`, the four
affected spec files re-run, and the **same 8 tests failed — same files, same lines, same
titles, same assertions**. The deletion is not involved in any of them.

Pre-existing failures, grouped by what they actually are:

- **Six are media decode, and look like the browser substitution, not the product**:
  `import-and-edit.smoke.spec.ts:138` ("imported video keeps its authenticated picture"),
  `:294` × 3 (the YouTube srt/vtt/sbv caption exports), and
  `import-media-captions.smoke.spec.ts:132` × 2 (embedded m4a/mp4). Five of the six die on
  the same assertion — `expect.poll(() => Number.isFinite(video.duration) && video.duration > 0)`
  timing out at 30s (`import-and-edit.smoke.spec.ts:317-319`) — i.e. Chromium never decodes
  the fixture at all. The caption fixtures are inline strings in the spec, so no network is
  involved. The suspect is the revision symlink this container needs: `@playwright/test`
  1.63.0 pins Chromium 1243 and the image ships 1194, so the suite runs an older
  `chrome-headless-shell` whose media pipeline is not the pinned one. **Do not read these as
  an import regression without first reproducing on a machine with the real rev-1243 build.**
- **`projects/project-trash.smoke.spec.ts:18`** — a genuine test-side bug, reproducible and
  nothing to do with media: `getByRole("heading", { name: archiveName })` at line 32 hits a
  strict-mode violation because the "Created <name> in Personal" success toast is still
  mounted and its `<h2 data-slot="toast-title">` also matches the accessible name. The
  locator needs `exact: true` or a scope that excludes the toast region. Out of scope here
  (this routine never modifies test files) — worth a one-line fix by someone who can.
- **`agent/agent-connection.smoke.spec.ts:43`** (AQU-1529) — `getByRole("checkbox", { name:
  "All current organizations", exact: true })` never appears on the OAuth consent page
  (`AgentConnectionPage.ts:21`, 30s timeout). Not media, not obviously environmental.
  The one of the eight most worth a human's eyes.

**For the next run**: 88/96 is the expected smoke baseline in this container until the
Chromium revision gap is closed, so budget one A/B pass rather than treating smoke red as a
blocker — and kill stray `wrangler dev`/`workerd serve` processes between shard runs, because
a leftover one holding `:9788` makes the next boot die with `[sync] timed out waiting for
:9788`, which reads like a backend failure and is not one.

## 2026-10-05 — type-tightening run: the SPA's `(window as any)` debug-handle casts

**Done this run** (theme 3, type tightening; 4 files, 30 insertions / 30 deletions, no test
file touched): removed the last 10 `as any` casts in the SPA's browser-global debug handles
and the 6 `@typescript-eslint/no-explicit-any` suppressions that existed only to permit them.

- `src/lib/perf-log.ts` — the 5 console handles (`togglePerfLog`, `setPerfLog`,
  `startMemSampler`, `stopMemSampler`, `memReport`) now assign through one
  `window as typeof window & {…}` binding whose property types are `typeof <the function>`,
  so a signature change to any of them is a compile error at the assignment instead of
  silently re-typing the console handle. `heapUsedBytes()`'s `(performance as any)?.memory`
  is now `performance as Performance & { memory?: { usedJSHeapSize?: number } }` — the
  optional property is what makes the existing `typeof mem.usedJSHeapSize === "number"`
  guard type-checked rather than decorative, and the `?.` on `performance` itself is kept
  verbatim (it is runtime-meaningful on engines where the global is absent).
- `src/components/EditorTable.tsx` — the three `__perf*RowRenders` handles, same treatment.
  Types are stated identically to the `declare global` block in
  `EditorTable.incrementalMemo.test.tsx:176` (`__perfRowRenders?: Map<string, number>`,
  `__perfResetRowRenders?: () => void`) so interface merging stays conflict-free; the test
  file itself is untouched.
- `src/hooks/useActiveCellStore.ts` — `__cellStore` and `__aquillaMemorySnapshot`. This file
  is the ledger's standing trap zone, so note the scope precisely: **only the two
  debug-handle `useEffect`s changed.** Nothing in the `readAtVersion()` / `useCellStoreViews`
  machinery was read, moved or inlined. The idiom used is the one already in the same
  function at (pre-change) lines 3204 and 3206 — `window as typeof window & { … }` — chosen
  over a `declare global` augmentation precisely so the widened type stays local to the
  assignment and does not reach the rest of the app.
- `src/lib/report-problem.ts` — `(posthog as any).get_session_replay_url` became
  `const fn: unknown = posthog.get_session_replay_url`. The method **is** in posthog-js's
  types now (`node_modules/posthog-js/dist/module.d.ts:4664`; the repo pins `^1.434.12`), so
  the `any` was a stale workaround for the `≥ 1.87` floor the doc comment named — that
  sentence was dropped with it. `unknown` rather than the typed method on purpose:
  `report-problem.test.ts:114-119` deletes the method at runtime and asserts `null`, so a
  type claiming it is always present would be a lie the guard exists to catch.

**Proof**: type-level only — no runtime expression changed, no control flow, no
suppression removed that ESLint still needed. `npx tsc -b` green, and the four files'
lint output is byte-identical to baseline except for the one directive that goes away
(`perf-log.ts:76:1`, already reported *unused* at baseline — see below).

### The `(window as any)` set is now empty in `src/`, and this was all of it

`grep -rnI "window as any\|globalThis as any\|performance as any\|self as any\|document as any"
--include=*.ts --include=*.tsx src | grep -v "\.test\."` returned exactly these 13 lines
before the run and returns nothing after. Non-test `as any` / `: any` hits left in the SPA
after this run, for whoever picks the theme up next:

- `src/hooks/useProjectSettings.ts:560` (`...(existing.completionSettings ?? ({} as any))`)
  and `:918` (`;(next as any)[key] = (snapTarget as any)[key]` inside a generic key-copy
  loop). **Not taken**: both need the surrounding settings-merge generics understood, not a
  cast swapped — `:918` in particular is a keyof-indexed write across two object types and
  tightening it is a real typing exercise, not a mechanical one.
- `sync-worker/src/__tests__/helpers/in-memory-db.ts` (4) — test helper, frozen zone.
- Everything else `grep` reports for `:\s*any\b` in `src`, `auth-worker/src`,
  `sync-worker/src`, `agent-worker/src` and `worker/` is the English word "any" in prose
  comments (checked line by line; ~35 of them). Do not re-derive that list — the pattern
  is noisy and the real set is the two `useProjectSettings.ts` lines above.

## 51 unused `eslint-disable` directives repo-wide — a whole candidate theme

- **Found**: 2026-10-05 run, while diffing the touched files' lint output against baseline.
- **Friction**: `pnpm lint` reports 51 `Unused eslint-disable directive` warnings. They are
  pure noise in a 1096-problem report, and each one is a comment claiming a rule fires where
  it does not. 29 are `@typescript-eslint/no-explicit-any` in **test** files, where
  `eslint.config.js:163` turns that rule off for `**/*.test.{ts,tsx}` — i.e. the suppression
  was copied into a file where it was never needed. Those are all in frozen test files, so
  the actionable set is the 8 non-test, non-`dist` files (17 directives):
  `src/lib/perf-log.ts` (10 `no-console`), `src/components/EditorTable.tsx:354`
  (`no-console`), `src/components/CommentsPage.tsx` (`react/no-danger`),
  `src/components/MarketingLoginRoute.tsx` + `src/hooks/useHealth.ts:364` +
  `src/components/AudioRecorder/RecordingVideoSurface.tsx:158`
  (`react-hooks/exhaustive-deps`), `src/hooks/useFocusLock.ts`
  (`react-hooks/set-state-in-effect`), `src/lib/parsers/ebible.ts`
  (`no-constant-condition`).
- **Why deferred**: it is a different theme from this run's, and it has a question in front
  of it that a cleanup pass should not answer alone. A directive for a rule that is *off* is
  dead text, but the two shapes behind "unused" are not the same: the `no-console` ones say
  the rule does not reach `src/lib/*` at all (so `console.log` in shipped code is
  unpoliced), and the `react-hooks/*` ones say the React Compiler's lint moved and these
  deps lists now pass on their own. On the first shape, `no-console` is **not configured
  anywhere** in `eslint.config.js` and is not part of `js.configs.recommended`, so every
  `// eslint-disable-next-line no-console` in the repo is dead text and `console.*` in
  shipped code is unpoliced. Its *real* fix is enabling the rule — a CI behaviour change,
  explicitly out of scope here — and deleting the comments first would erase the only
  breadcrumb pointing at it.
- **Proof needed**: comment-only deletions, so `pnpm lint` error list byte-identical and
  warning count down by exactly the number removed, plus `pnpm build`/`pnpm test`
  green-to-green. Worth checking `eslint.config.js`'s `files` globs for `no-console` first
  and saying in the PR body which of the two shapes each deletion is.

### Container-setup delta 2026-10-05: the Chromium shim needs TWO inner layouts

Addendum to the 2026-09-25 recipe and the 2026-10-02 revision bump. Playwright's pinned
revision is **1243** (`@playwright/test` 1.63.0) and the image still ships 1194, but the two
browser flavours renamed their inner directory **differently**, so one symlink is not enough.
The 2026-10-02 entry only recorded the headless-shell path, and following it alone fails at
`[s1] Playwright browser executable is missing: /opt/pw-browsers/chromium-1243/chrome-linux64/chrome`
— which reads like a missing install and is not one. Both are needed:

```
/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell
  -> /opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell
/opt/pw-browsers/chromium-1243/chrome-linux64
  -> /opt/pw-browsers/chromium-1194/chrome-linux          # chrome-linux64, NOT chrome-linux
```

plus `INSTALLATION_COMPLETE` and `DEPENDENCIES_VALIDATED` marker files in each `-1243`
directory. Symlink the **directory** for the full-Chromium case, not the `chrome` binary
inside it — it needs its sibling `.pak`/resource files.

Also reconfirmed, and worth stating as a hard sequencing rule rather than a hint: **after any
shard run, kill the stray `wrangler dev` supervisors before the next one.** The first A/B
attempt this run died at `[e2e-up] fatal: Error: [sync] timed out waiting for :9788` with
`exit 143`, which looks exactly like a sync-worker regression. It was a leftover
`aquilla-sync-worker-local-e2e` wrangler from the previous shard holding its state directory.
`pkill -f workerd` alone is not enough — the `wrangler dev` parent respawns `workerd`
immediately, so kill the `node .../wrangler dev` processes (by PID if the pattern kill misses
them) and confirm with `ps -eo pid,comm | grep -E "workerd|wrangler"` returning nothing before
re-running. The retry then booted and ran normally.
