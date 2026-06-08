# SWARM TRACES — stigmergic TODO registry

Open signals for future loop iterations / swarm agents. Each trace = something a
later agent can pick up. Also drop `SWARM-TODO(<id>): ...` comments in code at the
exact gap; register them here. Honesty over optimism — if it's not production-ready, say so.

Format: `- [STATUS] (id) description — blocker / how-to-pick-up — file:line`
STATUS: OPEN | CLAIMED | DONE

## BLOCKERS (production-readiness — surface to user)
- [DONE 2026-05-31] (sync-worker-6fail) FIXED by WS-SWTEST-FIX — all 6 confirmed stale tests; refreshed assertions + `d1-fake.ts`, ZERO production code touched (audio DELETE verified as intended F8 owner-DELETE, test renamed/split). sync-worker now **381/381 green** on main `e16759a`. (Historical diagnosis below.) 6 sync-worker tests failed on committed HEAD. **DIAGNOSIS: all are TEST-STALENESS, NOT production bugs** (full detail `docs/swarm/SYNC-WORKER-FAILURES.md`). The audio "auth bypass" is a **FALSE ALARM** (feature F8 / commit 1811d31 — sync-token DELETE by file owner is intended, fully auth'd; test is stale). Fixes: admin.test.ts×3 + audio.test.ts×1 = stale assertions (NOT in dirty set, safely fixable); files-read×2 = `d1-fake.ts:494–548` test-helper drift (IS the actor's dirty file → coordinate). Swarm NOT touching it (actor's active package, ~5-min fix for them). sync-worker *production code* is OK; only the *test suite* is stale.
- [OPEN] (e2e-smoke-unrun) `npm run test:e2e:smoke` + hands-on golden-path QA NOT yet run (heavy dev stack; preview serves main not integration). The last untested Layer-1/Layer-2 gate. Run carefully off `.worktrees/swarm-integration` once feasible (it kills ports 8787/8788/5173 → would stop the running preview).

## Deferred features (need event-layer work — currently forbidden path)
- [OPEN] (comments) Re-enable Comments UI. comment.create/edit/delete/resolve event kinds EXIST (`sync-worker/src/events/types.ts:22`) and `handlers/comment-events.ts` is being actively edited by the user. Pick up AFTER the user's sync-worker work commits. Then: wire `useComments` hook to real events + drawer surface. — `src/hooks/useComments.ts`, `src/components/CommentsPage.tsx:21`
- [OPEN] (writeback) Transcript-to-cell writeback. `target.cell.commit` exists; verify it's not entangled in the in-flight `handlers/cell-events.ts` before implementing. — `src/components/CellTranscriptPreview.tsx:102`
- [OPEN] (autofix) Autofix "Try to fix all" — needs bulk-patch flow over target.cell.commit. — `src/components/RuleDrawer.tsx:25`, `src/components/RulesPage.tsx`
- [OPEN] (bulk-audio) Bulk transcribe-all + synth-all — cell.audio.* events exist; needs a client job coordinator. — `src/components/ProjectWorkspace.tsx` (transcribe-all warn)
- [DONE 2026-05-31] (backtranslation-write) BUILT — `cell.backtranslation.set` event + `cell_backtranslations` projection + read route (sync-worker, migration 0021), statistical Markov glosser (`src/lib/completion/bt-glosser.ts`) + BT-tab edit/Polish/stale/role-gate (EditorTable), emit-on-save via outbox + hydrate-on-load via read route (ProjectWorkspace). BT now PERSISTS + syncs multi-user. On main `e16759a`. (The old "forbidden event layer" blocker is gone — the actor's sync-worker work landed; see ORCHESTRATION.md archive note.)

## Queued (no blocker, just not yet dispatched)
- [OPEN] (complete-all) Remove `comingSoon` on "Complete all"; implement run = `completeBatch(allUntranslated)` (completeBatch already chunks at 30) + spend/cost display + pagination. — `src/lib/workspace-actions/registry.ts:55`, `src/hooks/useCompletion.ts:66`, ProjectWorkspace actionArgs `:1166`. DEFER until WS-EXPORT releases ProjectWorkspace.tsx.
- [DONE] (search) Parallel passages + project-wide search was NOT a stub — fully implemented server+client, just mis-wired. W2-B fixed the 1-line `useWorkspaceSearch` call (projectId was null). Plain FTS5 search panel now works.
- [OPEN] (search-passages-panel) `useWorkspaceSearch` returns `searchParallelPassages` but `ParallelPassagesPanel` only exposes a single `onSearch` prop with no mode-aware routing. To surface the multi-project passages mode, extend the panel props (`onSearchPassages` or a mode arg). — `src/components/ParallelPassagesPanel.tsx`, `src/components/ProjectWorkspace.tsx`

## Learning loop follow-ups (W2-A landed the core)
- [OPEN] (rule-suggest-cells) `RuleSuggestDialog` accepts an optional `cells` prop and suggests rules from validated pairs, but `RulesPage.tsx:75` renders it WITHOUT cells → "No human-validated translations found." Wire RulesPage to pass validated cells (use `useLivingMemory({projectId})` from `src/hooks/useLivingMemory.ts` to aggregate, adapt to `{status,original,translated}[]`). — `src/components/RulesPage.tsx` (claimed by W3-A).
- [DONE] (memory-wiring) useCompletion call site activated at ProjectWorkspace.tsx:698 (rules + allProjectCells passed). Learning loop is LIVE.

## Fidelity bugs (found by round-trip verification W10 — `docs/swarm/ROUNDTRIP-FIDELITY.md`)
- [DONE] (tsv-corruption) FIXED by W12 @ `25f4302`: `exporters/tsv.ts` now RFC-4180-quotes fields with `"`/tab/newline (import was already quote-aware). Round-trip TSV assertions flipped to clean. TSV now round-trips losslessly like CSV.
- [NOTE] (tmx-untranslated) TMX drops untranslated (empty-target) cells — inherent to TMX (TM-exchange format). Not a bug; document only.

## FRO-206 drill-down gaps
- [OPEN] (drilldown-cells) TerminologyPage passes `cells=[]` to TerminologyTermDetail; occurrences list is empty until a follow-up wires useCells for the active file (or all project files). To pick up: import useCells + useProject in TerminologyPage, fetch cells for each file, map CellData[] into the detail prop. — `src/components/TerminologyPage.tsx` (drill-down guard, ~L650), `src/components/TerminologyTermDetail.tsx`
- [OPEN] (drilldown-username) TerminologyPage passes `username="local"` to TerminologyTermDetail. Wire the real auth username (useIdentity / useProjectSettings) before shipping. — `src/components/TerminologyPage.tsx`
- [RESOLVED] (drilldown-canEdit) now passes canEdit={canEditCells} (syncRole>=400 or local). TerminologyPage passes `canEdit={true}` unconditionally. FRO-208 is adding role-gating to TerminologyPage; once that lands, pass `permissions.canEditContent` here too. — `src/components/TerminologyPage.tsx`

## Quality / hardening (pick up opportunistically)
- [OPEN] (lastEditAt) `buildCellData` drops `lastEditAt` from CellRow → CellData; forward it (one-line client change) so recency-sorted views (Living Memory) work without server changes. — `src/hooks/useCells.ts`
- [OPEN] (export-all-warn) `openExportFlow` is a console.warn stub. — `src/components/ProjectWorkspace.tsx:1162` (owned by WS-EXPORT)
- [OPEN] (5 TODOs) Pre-existing diffuse TODOs: event-projection.ts ×2 (forbidden), useCells.ts, useCellWaivers.ts, RulesPage.tsx.

## License caution (judgment call baked in)
- Aquilla is a COMMERCIAL product. Do NOT copy GPL/copyleft code (e.g. MateCat filters are LGPL). Implement CAT formats from the OPEN SPECS (OASIS XLIFF 1.2/2.0, LISA TMX 1.4b, TBX, SRX) or from Apache-2.0/MIT sources (e.g. Okapi is Apache-2.0). When in doubt, reimplement from spec.

## FRO-203 auto-BT (statistical BT on every target commit)
- [DONE] (fro203-stat-bt-core) Statistical BT now fires automatically on every target commit. `src/lib/completion/bt-auto.ts` adds `buildStatisticalBt` + `shouldAutoRecomputeBt`. `ProjectWorkspace.tsx` wires auto-BT in `handleCellCommitted` (hand-typed EditorTable commits) and `commitCompletedCell` (AI completion commits). LLM polish remains opt-in via `runBacktranslation`. Seed wiring: preferred→+3, admitted→+1, forbidden→-3 (pre-existing code confirmed). `applyOptimisticTargetEditWithCapture` intercepts EditorTable's optimistic edit to capture which cell was last committed.
- [DEFERRED-OK] (fro203-editortable-wiring) SWARM-TODO(FRO-203): EditorTable's `onCellCommitted` prop currently has signature `() => void` — it does NOT pass the committed cell or translated text. The current workaround captures the cell via `applyOptimisticTargetEditWithCapture` (intercepted at the `onOptimisticEdit` prop). If a more reliable signal is needed (e.g. for concurrent multi-cell edits), change `onCellCommitted` to `(cellId: string, translatedText: string) => void` in EditorTable.tsx (line ~343, ~1197, ~1386, all call sites). ProjectWorkspace.tsx would then receive the cell data directly in `handleCellCommitted`. NOT done now — EditorTable.tsx is forbidden for this agent. — `src/components/EditorTable.tsx:343`

## Deferred — BT + Terminology v1-core (built 2026-05-31, main `e16759a`; scoped-out tails)
Both features shipped to spec for v1-core. These tails were deliberately deferred (design: `docs/superpowers/specs/2026-05-31-bt-terminology-design.md`). None block the demo.
- [OPEN] (term-verdict-event) Server-emitted idempotent `cell.terminology.verdict` events. v1 DERIVES verdicts on read (concepts → rule engine: `src/lib/terminology/compile.ts` + `src/hooks/useRules.ts`), matching the derived-over-materialized preference. Materialized server verdicts (scale/privacy of subscribed concepts) = v2: new sync-worker event kind + fan-out re-derivation job.
- [OPEN] (term-org-subscribe) Org termbase publish/subscribe (cross-project). Needs a `project_termbase_subscriptions` join table + implicit viewer grant on the upstream termbase + server-side union materialization. v1 = per-project termbase only. — stories `publish-termbase-to-org`, `subscribe-to-org-termbase`.
- [OPEN] (term-lemmatizer) Concept-presence uses normalized exact match in v1. Per-language lemmatization (Strong's for Greek/Hebrew; spaCy/Stanza for moderns) = v2 (recall on inflected forms). — `src/lib/terminology/compile.ts`.
- [OPEN] (term-concepts-as-cells) v1 stores concepts as a `ProjectRecord.terminology` blob synced via project-settings. The spec's richer model treats each concept as a CELL (per-concept history/validation/comments). v2. — `src/lib/terminology/types.ts`.
- [OPEN] (term-ai-suggest) AI concept suggestions + review queue + merge-duplicates (stories `accept-ai-concept-suggestion`, `review-terminology-queue`, `merge-duplicate-concepts`). v2.
- [OPEN] (term-dictionary) Dictionary entries as a separate file kind (open-ended lexicon/style-guide). v1 folds notes into concepts. v2.
- [OPEN] (bt-termbase-seed-verify) The glosser IS seeded from the termbase (preferred=+3/admitted=+1/forbidden=−3 in ProjectWorkspace `buildGlosser` useMemo). Effectiveness not yet measured on a populated corpus — confirm BT quality improves as the termbase grows.
- [NOTE] (localization-deferred) UI localization (CP-7/AD-16 `t(key)` shim + prose-clarity copy pass) was DEFERRED by the user this round — separate future effort, NOT part of this build.
- [OPEN P3] (term-violation-face-indicator) Terminology `source-requires-target` violations render in the cell's **Issues tab** + the source term gets a dotted underline, but there is **no face-level indicator** (blot/count badge) on the UNEXPANDED row — a translator scanning rows won't see a terminology-violation signal without expanding the cell. `source-requires-target` is about the *absence* of a required rendering (no character span to blot), so it needs a row-level infraction badge/count rather than an inline blot. UX polish, not a break. — `EditorTable` row face / infraction-count rendering. (Found in final QA, `UI-QA-PUNCHLIST.md` → Re-QA 2.)

## WS-WARN pre-acceptance terminology advisory band (Slice 4)
- [OPEN] (preaccept-band-mount) `PreAcceptanceWarningBand` + `detectPreAcceptanceWarnings` are built standalone and unit-tested but NOT wired. Glue wave must mount the band in the copilot completion path in `src/components/ProjectWorkspace.tsx` (FORBIDDEN to the building agent): compute warnings via `detectPreAcceptanceWarnings(completionText, sourceText, activeConcepts)` when a completion returns, re-render against the POST-ACCEPT back-translation verdict, and keep it ADVISORY ONLY (never gate the accept/commit). — `src/components/PreAcceptanceWarningBand.tsx`, `src/lib/terminology/preacceptance.ts`
