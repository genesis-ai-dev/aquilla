# SWARM TRACES — stigmergic TODO registry

Open signals for future loop iterations / swarm agents. Each trace = something a
later agent can pick up. Also drop `SWARM-TODO(<id>): ...` comments in code at the
exact gap; register them here. Honesty over optimism — if it's not production-ready, say so.

Format: `- [STATUS] (id) description — blocker / how-to-pick-up — file:line`
STATUS: OPEN | CLAIMED | DONE

## Phase 1 paragraph-drafting (2026-06-19) — deferred follow-ups (NOT §0 blockers)
- [DONE 2026-06-19] (p1-d4-source-fallback) Implemented on `feat/p1-followups`: `gatherPrecedingContext` gained an opt-in `sourceFallback` param (default OFF → shipped single-cell path unchanged); `completeParagraph` opts in, so preceding cells with source but no committed target are included (target ""). `buildParagraphPrompt` renders those as `Preceding (source, not yet translated): …` (NOT a mimickable Source/Translation pair). +3 gather tests, rewrote the paragraph blank-target test (tsc 0 · completion+hooks 226). NOTE: `completeSingle` intentionally still committed-target-only (avoids regressing the shipped Phase-0 prompt); enable there only if desired. — `src/lib/completion/draft-context.ts`, `completion-service.ts`, `src/hooks/useCompletion.ts`
- [DONE 2026-06-19] (p1-following-source) Implemented on `feat/p1-followups`: new `gatherFollowingSource(cells, cellId, count)` (forward scan, same-file, skip empty source, doc order) + `completeParagraph` now passes `followingSource` from the last group cell (reusing `precedingTargetCells` as a symmetric window for v1; SWARM-TODO to split into its own budget+UI). The render already existed ("Following context (source only — do not translate)"). +4 unit tests (tsc 0 · completion+hooks 230). — `src/lib/completion/draft-context.ts`, `src/hooks/useCompletion.ts`
- [OPEN] (p1-paragraph-abort) `completeParagraph` takes no `AbortSignal` — can't cancel mid-flight (fine while streaming is off; revisit with SSE fix). — `src/hooks/useCompletion.ts`
- [OPEN] (p1-paragraph-streaming) paragraph calls are `stream:false`; `<c id>` tag format already supports progressive parse — enable once Frontier SSE fix ships. — `src/hooks/useCompletion.ts`
- [OPEN] (p1-paragraph-ui-wiring) `completeParagraph` exposed from the hook but no UI trigger wired (deliberate per spec — hook is the deliverable). Wire a "Draft paragraph" affordance in a later slice. — `src/components/ProjectWorkspace.tsx`/`EditorTable.tsx`
- [OPEN] (p1-partial-commit-visibility) `completeParagraph` fan-out commits cells sequentially; if `commitCompletedCell` throws mid-loop, already-committed cells stay committed while ALL group cells get marked "error" in the UI (outer catch). Acceptable degradation (errors surfaced, no empty commit) but the per-cell state is coarse. Pick up: only mark the still-uncommitted cells on a mid-loop throw. — `src/hooks/useCompletion.ts` completeParagraph catch block
- [OPEN] (p1-usfm-chapter-no-p) USFM paragraph detection: a `\c` followed directly by `\v` with NO intervening `\p`/`\q`/etc. (malformed/minimal USFM) leaves that verse without `paragraphStart`, so `deriveParagraphs` groups it with the previous chapter's last verse (only fileId-change or paragraphStart break a group, not `\c`). Real USFM nearly always has `\p` after `\c`; low risk. Pick up: optionally treat a chapter boundary as a paragraph break. — `src/lib/parsers/usfm-lossless.ts` pre-scan
- [OPEN] (p1-draftcontext-idb) `useProjectSettings.localSettingsFrom` doesn't extract `draftContext` from the IDB record → offline loads show server default not local override (same class as translationBrief; not a regression). — `src/hooks/useProjectSettings.ts`

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
- [OPEN] (btseed-glue) LLM-BT terminology seeding is BUILT in the service but NOT wired from the editor. `generateBacktranslation` now accepts optional `concepts?: Concept[]` + `sourceText?: string` (derives relevant preferred-rendering hints internally) OR explicit `terminologyHints?: {sourceTerm;preferred[]}[]` (explicit wins). Glue wave: at the ProjectWorkspace BT-generation call site feeding EditorTable's BT tab, pass the project's active `Concept[]` as `concepts` and the cell's source string as `sourceText`. Source active concepts the same way the statistical glosser seeds (`bt-glosser.ts` BtSeed). Both fields optional → omitting them is byte-identical to old behavior. — `src/lib/completion/backtranslation-service.ts` (SWARM-TODO(btseed-glue)), `src/components/ProjectWorkspace.tsx` (FORBIDDEN to this agent)

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

## PD4 carry-forwards (2026-06-09)
- [OPEN] (fro180-group-detach) Revoke-all removes the direct project_members row only; spec (members-and-sharing.md) wants group-detach too. Result dialog hints at remaining non-removable paths. Needs group-management surface — follow-up issue filed. — auth-worker/src/routes/project-members.ts, src/components/ProjectMembersPage.tsx
- [OPEN] (fro233-mixed-runs) DOCX export: mixed-format paragraphs collapse to dominant (first text-bearing) run's rPr. Full fidelity needs import-time per-run text→format map stored alongside cells. — src/lib/export/exporters/docx.ts (SWARM-TODO in header)
- [RESOLVED 2026-06-09] (org-settings-floor) Premise was partly stale: the client floor was already MAINTAINER(600) (ORG_SETTINGS_WRITE_MIN_ROLE), and below-floor callers were blocked before the optimistic apply. The real gap was forbidden/error PATCH responses never reverting the optimistic write ("a refresh will revert" comment with no refresh call). Fixed: rollback to pre-write snapshot + refresh on forbidden/error; floor guard comment; useOrgSettings.test.ts covers floor, blocked-no-apply, and rollback. — src/hooks/useOrgSettings.ts (commit 6573e81)
- [OPEN] (userules-patchshared) useRules.ts calls patchShared fire-and-forget; rejections silently dropped (same fail-loud gap FRO-255 closed in useProjectSettings). — src/hooks/useRules.ts
- [OPEN] (pw-stale-floor-comments) ProjectWorkspace.tsx ~:2124/:2180 still carry stale "mismatch" notes about the 500/600 floor — now fixed by FRO-255; update comments opportunistically. — src/components/ProjectWorkspace.tsx
- [OPEN] (fro173-backfill-decision) PRODUCT DECISION: legacy GitLab audio EXISTS and was deliberately deferred by the importer. Backfill = scripts/migrate-all.ts --audio --apply (canary --only <gitlabId> first; needs GitLab LFS access + SYNC_SECRET_KEY + staging worker). Full evidence: docs/swarm/AUDIO-GAP-FRO173.md.

## PD5 carry-forwards (2026-06-09 overnight run)
- [OPEN] (fro177-retain-validations-server) The Replace "Retain my validations" toggle threads `retain_validations` onto `target.cell.commit` payloads, but the sync-worker projector IGNORES the field — no validation re-anchoring happens server-side (spec Q25). UI-QA: if the label reads as a promise, implement projector support or soften the copy. — src/lib/sync/events-emit.ts, sync-worker projector.
- [OPEN] (fro181-cell-edges-graph) AD-14 confidence derives via FTS top-k neighbors (existing mechanism), NOT a materialized `cell_edges` graph; `WITH RECURSIVE` spec language not literal yet. DO `health.rollup` push-broadcast also deferred — client polls `GET /api/v1/projects/:id/health-rollup`. — sync-worker/src/events/health-rollup-route.ts, src/hooks/useHealthRollup.ts.
- [OPEN] (fro181-endorsement-writes) `cells.endorsement_count` column retained and still WRITTEN by event-projection; all reads migrated off it. Cleanup = stop writing + eventual column drop (needs its own migration). — sync-worker event-projection.
- [OPEN] (fro178-morph-surfacing) Macula import populates cell_word_morph (migration 0032) and imports as a normal source file, but no editor surface renders morphology yet. Follow-up UI: per-word morph popover/interlinear. — src/lib/parsers/macula.ts, sync-worker/src/events/import-morph-route.ts.
- [OPEN] (fro175-chat-tails) Chat panel: cross-session persistence (needs table/IDB) + markdown rendering in bubbles deliberately deferred. — src/components/ChatPanel.tsx, src/hooks/useChat.ts.
- [HITL] (fro215-homepage-flags) 4 marketing-claim judgment calls for the user in docs/swarm/HOMEPAGE-AUDIT-215.md (stats attribution, partner-band consent, JESUS Film trademark, "system learns" claim). RESOLVED 2026-06-09: the audit's 5th flag ("BT not delivered") was a FALSE NEGATIVE from a stale claims audit — wave-1 UI-QA verified BT live (statistical gloss + optional LLM polish); audit doc corrected.

---

## PD6 wave (2026-06-10) — FRO-262/263/264 [re-append; first append was clobbered by concurrent session]

Orchestration: docs/swarm/PD6-ORCHESTRATION.md. Base main@cfd4470 → promoted main@9628782 (--no-ff).
- [DONE] FRO-262 tour copy + org-switcher step (743c78e) — UI-QA PASS.
- [DONE] FRO-263 hero subtitle centering + .aq-blitz-verse same-reset fix (de03d11) — UI-QA PASS.
- [DONE] FRO-264 team edit button/no-wipe rename/project links (a25de34) + server description in
  getOrgGroupDetail (db0a005) — UI-QA PARTIAL: description-prefill not live-verified (user's own
  dev stack held :8788, browser hit old server — which DID verify the defensive no-wipe path);
  server half covered by groups-read.test.ts. Sub-600 gating not live-verified (pre-existing gate,
  restyle-only change). Follow-up QA: re-check prefill once deployed.
- [DONE] Orchestrator fix 7cdb650: rls-backstop.test.ts TS7022 (UXA FRO-289 file) broke
  `cd auth-worker && tsc --noEmit` on main — 3-line annotation.
- [DONE] (pd6-syncworker-tsc-debt) `cd sync-worker && npx tsc --noEmit` was RED on main with ~60
  errors in TEST files only (CellRow/EventRow/CellsFtsRow not assignable to Record<string,unknown>
  in pg-test-db helper signatures; node:fs resolution in pg-test-db.ts). Pre-existing (last touch
  4728e9c D1-redact). Resolved 2026-06-10: Seed/seedRows widened to `ReadonlyArray<object>` (one
  internal cast, no call-site casts) + `"node"` added to tsconfig types (matches auth-worker).
  tsc exits 0; runtime tests stayed green 552/552.

---

## UXA swarm (2026-06-10) — UX Journey Audit, FRO-265..298 — CONVERGED

All 34 issues Fixed + promoted to main (final UI-QA on 7d934fd; punchlist 6c63e85).
Orchestration: docs/swarm/UXA-ORCHESTRATION.md. Open follow-ups:

- [OPEN] (uxa-deploy-migrations) Migrations NOT applied to live Neon: db/postgres 0034_rls_backstop,
  0035_backfill_validation_count_threshold (FRO-279 backfill), 0036_files_soft_delete, 0037_cells_ai_drafted;
  auth-worker 0034_ai_usage_daily. Apply via scripts/neon-migrate.ts; CI ledger check flags until applied.
- [OPEN] (uxa-rls-staging) FRO-289 RLS: PGlite can't test role-level policy enforcement — verify on a
  staging Neon branch (runtime role + policies) before trusting; rollback = per-table DISABLE RLS.
- [OPEN] (uxa-284-env) FRO-284 mention emails need RESEND_API_KEY/EMAIL_FROM/BASE_URL in sync-worker env.
- [OPEN] (uxa-265-enforce) FRO-265 AI caps ship LOG-ONLY (AI_BUDGET_ENFORCE unset); flip to "true" after
  sizing thresholds (defaults: user 500/day, global 5000/day).
- [OPEN] (uxa-dev-jwt-mismatch) Pre-existing dev-env bug: auth-worker vs sync-worker JWT secrets differ in
  .dev.vars → all sync API calls 401 on the dev stack; blocked full UI-QA of FRO-272 restore + FRO-279/280
  aggregate %. Fix .dev.vars parity; re-verify those two flows.
- [OPEN] (uxa-validation-history-dead) ValidationHistoryTimeline is dead UI (validationHistory always []);
  EditorTable was locked during FRO-298 — delete in a follow-up.
- [OPEN] (uxa-283-joinpage-prewarn) JoinPage doesn't pre-warn on invite email mismatch (server now enforces;
  user learns via 403) — small UX follow-up.
- [NOTE] (uxa-291-rescue-stash) Stash "rescue: foreign media-timeline WIP found in fro-291 worktree" is
  REDUNDANT (that WIP was the user's media-lens work, committed as 5750005) — safe to drop after confirming.
