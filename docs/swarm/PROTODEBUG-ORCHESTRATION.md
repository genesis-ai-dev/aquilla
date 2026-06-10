# SWARM ORCHESTRATION — Prototype Debugging (Wave 2, 2026-06-05)

Driver: `/swarm-orchestration` on Linear project **Prototype Debugging** (FRO). Wave 2 = FRO-165..172.
Base: clean `cc7b5ed`. (Wave 1 = FRO-158..162, all Fixed + on `dev`/staging.)

## §0 STOP checklist
- [x] FRO-165, 167, 169, 171, 172 implemented + verified green + merged to main.
- [x] FRO-168, 170 (HITL): user approved decisions inline; IMPLEMENTED Wave 3 (status chip, per-metric conditionality, team card, language pair / access vocabulary, legend, max-wins copy, source badges). Merged.
- [ ] FRO-166 (blocked by 165 + HITL): deferred until revert lands on staging + design approved.
- [x] Integration green: root tsc 0 · vitest 1540 pass (2 pre-existing baseline fails) · auth-worker 123/123 · build exit 0.

## §1 Operating model
- Integration `swarm/pd2-integration` off `cc7b5ed`. Each agent → own worktree, sonnet, commit-only, no push.
- HITL rule (per user): orchestrator updates the ticket noting human review needed + prompts user, while other agents proceed.

## §2 Workstream registry
| WS | FRO | Title | Pri | Branch | Status |
|---|---|---|---|---|---|
| revert | 165 | Revert internal/all/public teams categorization | Urgent | swarm/pd2-revert | merged-main |
| maxwidth | 167 | /projects/{id} widen max-width (2xl→5xl) | Med | swarm/pd2-maxwidth | merged-main |
| invitemodal | 169 | Invite-to-projects modal overflow (min-w-0) | High | swarm/pd2-invitemodal | merged-main |
| memberdrill | 171 | Per-member project-visibility drill-down | High | swarm/pd2-memberdrill | merged-main |
| homeredirect | 172 | Root → /homepage redirect for no-cookie users | High | swarm/pd2-homeredirect | merged-main |
| — | 168 | /projects/{id} IA redesign | Med | — | HITL: proposal ready, awaiting user |
| — | 170 | Org-vs-project access legibility | High | — | HITL: proposal ready, awaiting user |
| — | 166 | /teams redesign | Med | — | BLOCKED by 165 + HITL: deferred |

## §M Merge log
- 2026-06-05 · revert(165) · TeamsList.tsx — removed all/internal/public GroupFilter; real cause = default "internal" filter hid teams; is_internal column KEPT (required by FRO-158 query). +2 regression tests.
- 2026-06-05 · maxwidth(167) · ProjectOverview.tsx:184 max-w-2xl→max-w-5xl.
- 2026-06-05 · invitemodal(169) · MultiProjectInviteDialog.tsx:213 added min-w-0 so truncate fires on long slugs.
- 2026-06-05 · memberdrill(171) · reused existing GET /orgs/:orgId/members/:userId/access; new MemberAccessDrillDown.tsx + useMemberAccess.ts + member-access.test.ts (4); MembersMatrixView member→button opens panel.
- 2026-06-05 · homeredirect(172) · App.tsx RootRedirect via window.location.replace("/homepage") when aq_hint cookie absent; hasAuthHintCookie() in session-store.ts; worker/index.ts already did edge redirect (defence-in-depth). +4 tests.
- 2026-06-05 · GATE green, PROMOTED integration → main + dev (ff).

## §LIVE-VERIFY (staging — needs incognito/real Neon)
- FRO-165: /teams loads with the list (not empty) after revert.
- FRO-167: screenshot /projects/{id} wide (≥1280) + narrow (~768) — no h-scroll, no awkward gaps.
- FRO-169: open Invite-to-projects with an 80+char slug — name truncates, modal in-viewport.
- FRO-171: spot-check a mixed-grant member (direct + group) — paths + max-wins role reconcile with project-side panel.
- FRO-172: incognito (no cookie) → /homepage; with aq_hint=1 → app, no loop.

## §HITL proposals (surfaced to user — DO NOT implement until approved)
- FRO-168 IA redesign: recommend status-banner-first ("On track · 68% · due in 14d"), promote %tiles, add Team/Assignments card, demote per-file table. 5 open Qs (banner tone, assignments API exists?, language-pair field?, audio always-on?, file-table audience).
- FRO-170 legibility: recommend vocabulary org-wide/group/direct/creator + max-wins legend + rewritten cell popovers. 5 open Qs (org-wide naming, banner vs on-demand, multi-path badge depth, "make exception" rename, link to 171 drill-down).

## §M Wave 3 (HITL — approved + implemented)
- 2026-06-05 · ia(168) · ProjectOverview.tsx — compact StatusChip (on-track/due-soon/overdue), %tiles promoted, per-metric conditionality (text/audio shown only when present; audio-only hides text), DeadlineChip, language pair in header, Archive/Download → ⋯ overflow, Team card from org workload (per-project endpoint gap → SWARM-TODO), per-file table kept fully visible. +2 tests. TODOs: audio-validation metric; legacy-import audio question (FRO-160).
- 2026-06-05 · legibility(170) · MembersMatrixView/CellEditor/MembersPanel + new AccessModelLegend.tsx — vocabulary org-wide/via group/direct/creator + max-wins; on-demand [?] + collapsible legend; 2-char source badges D/O/G/C w/ tooltips; ImmutableBody rewrite + "Set a project-level exception (direct grant)". Multi-path secondary icon = SWARM-TODO (matrix exposes one source/cell). +9 legend tests.
- 2026-06-05 · GATE green (tsc 0 · vitest 1554 pass / 2 baseline · build exit 0) · promoted → main + dev (local).

## §SWARM-TODO (carry-forward)
- FRO-168: per-project all-assignees endpoint (`GET /projects/:id/assignments/all`) for a full Team card — currently org-workload proxy.
- FRO-168: audio VALIDATION metric not wired; confirm legacy GitLab import populated cell_audio (ties to FRO-160 data gap).
- FRO-170: secondary grant-path icon needs MatrixCell.secondarySources (backend exposes one source/cell today).
- STAGING PUSH PENDING: local main/dev at wave-3 tip; origin still cc7b5ed. Push blocked on pre-push e2e smoke (local Postgres/Hyperdrive not configured) — needs --no-verify (user authorize) or local PG.

## §M Wave 4 (carry-forward TODOs — backend enablement)
- 2026-06-05 · assignments · auth-worker GET /projects/:id/assignments/all (maintainer+) + getProjectAssignmentRoster service; client getProjectAssignments; FRO-168 Team card now uses per-project roster (org-workload proxy removed). +2 auth tests.
- 2026-06-05 · secondary · GET /projects/:id/members now returns secondarySources[] (all non-winning contributing paths); listEffectiveProjectMembers accumulates paths; MatrixCell.secondarySources wired; MembersMatrixCellEditor renders GitMerge icon + tooltip (FRO-170 secondary-path, read-only). +1 auth test.
- 2026-06-05 · GATE green (tsc 0 · auth-worker 127/127 · root vitest 1554 pass / 2 baseline · build 0) · promoted → main + dev (local).
- RESOLVED carry-forward: FRO-168 assignments endpoint ✅, FRO-170 secondarySources ✅.

## §AUDIO DATA FINDING (investigated on staging Neon)
- `cell_audio` is EMPTY: 0 rows across all 411 projects on staging. FRO-160's universal 0% audio is a true data gap — legacy GitLab import did NOT populate audio, none recorded post-cutover. Audio-validation metric (FRO-168 TODO) is moot until audio data exists. → product/data decision for user (new issue suggested).

## §M Wave 5 (production-readiness loop — spec audit fixes, 2026-06-06)
6-domain spec-vs-impl audit → implemented 7 surgical "prototype-behind-spec" fixes:
- auth: password reveal toggle + offline banner on login/signup forms (spec regression guardrails).
- comments: CommentsPage renders markdown (was plaintext); Cmd/Ctrl+Enter submit; per-cell draft persistence.
- validation: bulk "remove my validations" + completion toasts; 5th validation state (full-self vs full-others) in useCells+EditorTable.
- terminology/LM/fixreview: corrected "forbidden" label (was "avoid"); wired useLiveness into LivingMemoryPage; suppress select-all at single-cell in FixReviewPanel.
- search: Both/Source/Target content-side scope toggle (API already supported `side`).
- settings: surface 409 conflict notice (was silent snap; edit-preservation = SWARM-TODO).
- sync-worker: enforce maintainer(600) for FOREIGN unvalidate + comment edit/delete/resolve (was reviewer-min / silent no-op) — security fix, +14 tests.
GATE: root tsc 0 · vitest 1567 pass / 2 baseline · sync-worker 414/414 · build 0. (Pre-existing: sync-worker test-file CellRow tsc error + AssignedToMe 2 fails — both present at base 74e853b.)

## §PRODUCTION-READINESS LOOP — campaign state (2026-06-06)
Protocol: push dev + main with --no-verify (prototyping). Prod Neon migration allowed (no users yet).
- Wave 5 DONE (e00e0f1): 7 audit fixes shipped (auth guardrails, comments markdown/draft, validation 5-state+bulk-unvalidate, terminology label, liveness, fixreview, search side-scope, settings 409, server foreign-role enforcement).
- Issues filed for big gaps: FRO-174 (AI accept/reject), 175 (chat panel), 176 (snapshots), 177 (search-replace), 178 (macula), 179 (TN import), 180 (per-project members), 181 (AD-14 confidence), 182 (batch transcribe/synth), 183 (terminology data model), 184 (LM sections), 185 (CommentsPage filter/search).
### NEXT WAVES (implementable medium fixes identified by audit, not yet built):
- FRO-174 AI completion Tab/Esc accept-reject + cell.commit.llm-accept (High, central).
- Voice drag-and-drop chip→cell (audio); HistoryDrawer promote-to-current (AD-2); mic-denied help link + long-recording warn + cloud-pending audio state.
- Live password-requirements checklist on signup; "Sign out of all accounts"; invite expiry selector on SharePanel.
- Stale-source per-cell marker; resume-last-location (cell-level); ProjectSettings section nav + search; ImportDialog 6-card landing.
- Validation config dimensions (role floor/named-user/allowSelfValidation) + server policy; CommentsPage @mention/navigate/show-resolved (FRO-185).
- Continue auditing remaining user stories (onboarding, billing/tiers, private-mode, publish-workspace, harmonization).

## §M Wave 6 (loop — more spec-behind fixes, 2026-06-06)
- FRO-174: AI completion Tab/Esc accept-reject wired end-to-end (useCompletion accept/rejectCompletion + EditorTable keydown/overlay + events-emit ai_suggestion variant + ProjectWorkspace props). +tests.
- history: HistoryDrawer promote-to-current (AD-2) — two-step confirm → emitTargetCellCommit parented on current head. 
- authtrio: signup live password checklist+strength, "Sign out of all accounts", invite-expiry selector (server param = SWARM-TODO).
- audiopolish: mic-denied help popover, 25/30min recording warn/hard-stop, cloud-pending audio state + hover prefetch.
- settingsnav: ProjectSettings left-rail section nav + scrollspy + type-ahead field search.
GATE: tsc 0 · vitest 1588 pass / 2 baseline · build 0.
AUDIT (new, this wave): billing/tiers + BYOK + private-mode + publish = DEFERRED (correctly skipped). New gaps → issues: harmonization sweep (v1-behind), AI retrieval-tuning settings keys (top_k/contextSize/useOnlyValidatedExamples/main_chat_language), logout pending-outbox warning, outbox permanent-failure cap, password-reset ?next= threading.

## §M Wave 7 (loop, 2026-06-06)
- voice drag-and-drop chip→cell row (EditorTable drop + ProjectWorkspace onAssignVoice→generateCellVoice).
- FRO-187: top_k/contextSize/useOnlyValidatedExamples/main_chat_language AI settings + retrieval wiring in useCompletion.
- FRO-188: logout pending-edit confirm; outbox failure cap (OUTBOX_MAX_ATTEMPTS=5)+escalation; password-reset ?next= threading; account-switcher email+env hint.
- ImportDialog card-landing (Upload/eBible active; Macula/TMX/TN disabled placeholders → FRO-178/179).
GATE: tsc 0 · vitest 1593 pass / 2 baseline · build 0.

## §M Wave 8 (loop, 2026-06-06)
- stale-source per-cell marker: ALREADY IMPLEMENTED (StaleSourceIndicator + useStaleSourceCells + server route) — audit false-positive, no change.
- resume-last-location: new last-location-store.ts (LRU localStorage, per user+project, file+cell); ProjectWorkspace restores file (nav) + cell (scrollToCellIndex), writes on file change + debounced cell focus.
- FRO-185 CommentsPage: filter (file/author/participant/resolved) + sort picker + show-resolved toggle (hidden default) + go-to-cell nav + @mention typeahead (MentionTextarea). FTS5 + exact cell-scroll = SWARM-TODOs.
- validation config: validationRoleFloor + validationNamedUsers + allowSelfValidation UI + persistence. SERVER enforcement = SWARM-TODO (sync.ts cell.validate branch) → new issue.
GATE: tsc 0 · vitest 1610 pass / 2 baseline · build 0.

## §M Wave 9 (loop, 2026-06-06)
- FRO-182: re-enabled batch transcribe-all + synth-all (restored transcribe.ts; new batch-audio.ts driver, concurrency 2, cancellable; AudioBulkProgressBanner populated; removed Phase-2c-gamma console.warn guards).
- FRO-184: Living Memory Instructions + Standards sections (CRUD via project_settings, mirrors terminology).
- FRO-189: validation server enforcement (sync-worker route.ts cell.validate — role floor + named-users + allowSelfValidation; reads project_settings; +14 tests).
- mic-denied wiring: useMicPermission probe (audio-lens-gated) → micDenied into CellAudioRecordButton help affordance.
GATE: tsc 0 · sync-worker 428/428 · root vitest 1629 pass / 2 baseline · build 0.
## §CONVERGENCE (Wave 9 audit): surgical backlog ~drained. Remaining NEW gaps → small: HealthRing on ProjectCard/Dashboard (next). Large/HITL → file: download-target-bible, assignment work-pickup UI, detach-from-source. (search-replace already FRO-177.)

## §CONVERGED (2026-06-06, after Wave 9)
Production-readiness loop STOPPED — surgical/obvious spec-behind backlog drained. Cron 3db58d64 deleted.
Shipped Waves 5–9: ~23 surgical/medium spec-conformance fixes, all on main+dev (@ 2ebf398), staging auto-deploying.
Remaining backlog = large/architectural/HITL (need product input, not autonomous build): FRO-173 (audio legacy backfill — data decision), 175 (chat panel), 176 (snapshots), 177 (search-replace), 178 (macula), 179 (TN import), 180 (per-project members), 181 (AD-14 confidence — in-flight design), 183 (terminology data model), 186 (harmonization), 190 (HealthRing-on-card — gated on AD-14), 191 (download-target-bible), 192 (assignment UI), 193 (detach-from-source).

---

# PD4 — "highest priority issues" wave (2026-06-09, orchestrator session 6a7f0938)

Base: main `ca8b068` (pd3 converged + promoted minutes earlier). Integration `swarm/pd4-integration`.
Scope per user: highest-priority eligible issues only — NOT a full queue drain.

## §0 STOP checklist (PD4)
- [x] FRO-233/180/255/258/231 Fixed (verified); FRO-173 honestly blocked (product decision: backfill legacy audio A/B/C) — released to Todo w/ Linear note.
- [x] Integration green: tsc 0 · vitest 1966 pass / 27 pre-existing baseline (6 files, identical to base) · build exit 0.
- [x] auth-worker touched → tsc 0 + 184/184. sync-worker untouched (docs-only in 173).
- [x] Live-UI QA (central slot, local seeded stack): 231 PASS · 258 PASS · 180 PASS · 255 PARTIAL (OWNER path live; sub-600 floor covered by 20 unit tests) · 233 PARTIAL (import+dialog live; export fetch blocked by preview-iframe tooling; 13 unit tests) · 173 PARTIAL (no fake mic in tooling; 7/7+5/5 unit). 0 new bugs. See UI-QA-PUNCHLIST.md §PD4.
- [x] Promoted to main (ff) with main checkout clean.
- [x] Gaps traced in docs/swarm/TRACES.md §PD4.

## §EXCLUDED (PD4)
- FRO-227, FRO-224, FRO-215 — Dispatched today by pd3 (homepage-claims verification); claims recent, below priority bar. NOT reclaimed.
- All other Medium/Low Todos (FRO-243/214/192/191/190/181/186/183/179/178/177/176/175/221/223/246/209/193) — below the "highest priority" bar this run.
- FRO-257, FRO-145 — archived junk.
- PROTECTED (dirty in user's staging checkout — forbidden to all agents): auth-worker/src/routes/projects.ts, auth-worker/src/services/email.ts, auth-worker/src/types.ts, auth-worker/wrangler.toml, auth-worker/.dev.vars.example, docs/STAGING.md.

## §3 PD4 registry + wave plan (single wave, file-disjoint)
| WS | FRO | Pri | Branch | Owns (primary) | Status |
|---|---|---|---|---|---|
| export-fmt | 233 | High | swarm/fro-233 | src/lib/export/exporters/docx.ts(+test), ExportDialog.tsx | dispatched (reclaimed stale pd3 handoff) |
| members-page | 180 | High | swarm/fro-180 | NEW ProjectMembersPage + App.tsx route line; NEW auth-worker route file if needed | dispatched |
| audio-gap | 173 | High | swarm/fro-173 | investigation report docs/swarm/AUDIO-GAP-FRO173.md; importer fix only if evidence demands | dispatched |
| settings-floor | 255 | Med | swarm/fro-255 | src/hooks/useProjectSettings.ts(+test), settings read-only affordances | dispatched |
| share-modal | 258 | Med | swarm/fro-258 | SharePanel.tsx / MembersPanel.tsx (modal layout only) | dispatched |
| search-popover | 231 | Med | swarm/fro-231 | editor search popover (likely EditorTable.tsx search section) | dispatched |

Cross-cut rules: only members-page may touch App.tsx (one route line); only search-popover may touch EditorTable.tsx; only share-modal may touch SharePanel/MembersPanel; only export-fmt may touch ExportDialog/exporters; only settings-floor may touch useProjectSettings.

## §M PD4 merge log
- 2026-06-09 · search-popover(231) · 8f897b7→merge 92c2b78 · ParallelPassagesPanel.tsx:316 pl-4 pr-10 + flex-wrap (controls clear DialogClose X) · tsc 0 · agent vitest: 27 pre-existing fails, 0 new.
- 2026-06-09 · share-modal(258) · 39d7ce7→merge bb19db5 · SharePanel.tsx DialogContent flex-col max-h-[85vh] + scrollable tab body; MembersPanel.tsx ul max-h-[50vh] overflow-y-auto, min-w-0+truncate rows · tsc 0 · 27 pre-existing, 0 new.
- 2026-06-09 · audio-gap(173) · ee6a1e6 · docs-only: AUDIO-GAP-FRO173.md — VERDICT: legacy audio EXISTS (CodexCell attachments; importer explicitly deferred it, --no-lfs); backfill path COMPLETE but never run (scripts/migrate-all.ts --audio --apply, canary via --only); post-cutover record→projection path verified sound (7/7 + 5/5 targeted tests) · BLOCKED on product decision (backfill A / accept B / wontfix C) — release to Todo at convergence w/ note.
- 2026-06-09 · settings-floor(255) · 8b67711→merge 0f557ba · spec 01-personas-and-roles.md role-600 owns "change project settings" → server unchanged, client EDIT_ROLE_FLOOR 500→600; below-floor read-only w/ tooltip; below-floor writes no longer touch IDB; forbidden/error responses roll back optimistic overlay (setLocal reversal + patchProject) · tsc 0 · settings tests 20/20 · SWARM-TODOs: useOrgSettings same pattern (chip spawned), ProjectWorkspace.tsx:2124/:2180 stale comments, useRules patchShared fire-and-forget.
- 2026-06-09 · members-page(180) · merge of swarm/fro-180 · NEW ProjectMembersPage(+11 tests) + auth-worker/src/routes/project-members.ts revoke-all endpoint + index.ts reg + members.ts client helper; App.tsx 1 route; ProjectWorkspace surface swap (10 lines); protected files untouched · tsc 0 · auth-worker 184/184 · SWARM-TODO: group-detach on revoke-all (spec divergence, follow-up issue).
- 2026-06-09 · export-fmt(233) · af3b5d6→merge 47d47d7 · docx.ts extractDominantRpr + clone rPr onto injected run (bold/italic/sz/rFonts survive); +6 tests (13/13 on integration) · tsc 0 · 27 pre-existing, 0 new · SWARM-TODO: mixed-format paragraphs collapse to dominant rPr (needs import-time run map) · agent moved FRO-233 → Fixed; spec AC-2a amendment drafted in Linear comment, ORCHESTRATOR to apply in ~/frontierrnd/aquilla-specs/04-features/export-and-legacy-import.md.

## §CLAIMS (PD4)
- FRO-233: was already Dispatched+assigned (pd3 agent handoff comment 2026-06-09 21:39Z explicitly ended its slice → stale claim, reclaimed by PD4 finisher).
- FRO-180/173/255/258/231: claimed Todo→Dispatched by PD4 orchestrator before spawn.

---

# PD5 — Medium-tier queue drain (2026-06-09 overnight, autonomous; user AFK until morning)

Driver: user ran `/issue-audit` then `/swarm` with explicit targets: the Medium-tier Todo/Dispatched
issues NOT yet in main, in priority order: **215, 175, 176, 177, 178, 179, 181, 183, 186, 190, 191,
192, 214, 223, 243**. FRO-173 explicitly skipped (needs real mic + product decision, per user).
Base: main **`dd5c156`** (clean). Integration: `swarm/pd5-integration` (worktree `.worktrees/pd5-integration`,
node_modules + auth-worker/node_modules + sync-worker/node_modules symlinked).

## §0 STOP checklist (PD5)
- [ ] Every targeted issue at **Fixed** (verified) or honestly **blocked** with a Linear note.
- [ ] Integration green: root `npx tsc -b --noEmit` 0 + `npx vitest run` (no NEW fails vs baseline); `npm run build` before each promotion.
- [ ] sync-worker / auth-worker tsc+test green if touched.
- [ ] Each fix live-UI verified (central QA slot) before Fixed; spec reconciled per /issue Step 2.5 (orchestrator applies spec edits — see §1).
- [ ] Promoted to main only with main tree clean; never clobber other actors.
- [ ] Gaps traced in docs/swarm/TRACES.md §PD5.

## §EXCLUDED (PD5)
- FRO-173 — user said skip (real-mic verification + product decision A/B/C, see AUDIO-GAP-FRO173.md).
- FRO-224 / FRO-227 — pd3 Dispatched claims (homepage proof-stats/hero verification), No-priority, not in user's target list. NOT reclaimed.
- FRO-221 — fix already merged to main (31f63f5 + bf8edd8f...bf8efa8); board status drift only, flagged in /issue-audit. No work.
- FRO-209/246/259/193/257 — Low/No-priority, below this run's bar per user directive.
- PD4's protected staging files: /tmp checkout now CLEAN → protections released; no forbidden dirty paths this run.

## §1 Operating model (PD5)
- Manual worktrees off the **live integration tip** (never isolation:worktree — stale-base trap). sonnet agents, commit-only, no push/deploy/dev-stack.
- **Spec repo rule:** agents do NOT commit to ~/frontierrnd/aquilla-specs (shared checkout = index collisions). They DRAFT the spec amendment in their Linear comment + report; ORCHESTRATOR applies + commits at merge time. (PD4 precedent: FRO-233.)
- **Migration reservations** (avoid numbering collisions; mirror BOTH auth-worker/migrations/ AND db/postgres/ per 0028 pattern — D1→Neon drift is a known trap; db/postgres lags at 0028, auth-worker at 0030. Next free = 0031):
  `0031` = FRO-176 (snapshots) · `0032` = FRO-178 (cell_word_morph) · `0033` = FRO-214 (project lifecycle).
- Verification: agents run full `npx tsc -b --noEmit` + at minimum targeted `npx vitest run <paths>`; the FULL vitest gate runs at each integration merge (orchestrator). Baseline being captured on integration at dispatch time (PD4 baseline: 1966 pass / 27 pre-existing fails in 6 files).
- Live-UI QA: centralized single slot (playwright vs seeded dev stack per AGENTS.md). Agents leave SWARM-TODO click-paths.

## §3 PD5 registry + wave plan
Status: queued | dispatched | review | merged-integration | merged-main | blocked
| Wave | FRO | Pri | Branch | Owns (primary; SOLE owner of hot files marked ★) | Status |
|---|---|---|---|---|---|
| 1 | 215 | Med | swarm/fro-215 | src/pages/Homepage/** ★, new docs/swarm/HOMEPAGE-AUDIT-215.md | merged-integration |
| 1 | 175 | Med | swarm/fro-175 | NEW ChatPanel + useChat; ProjectWorkspace.tsx ★ (mount) | merged-integration |
| 1 | 176 | Med | swarm/fro-176 | SnapshotCreateDialog.tsx, NEW snapshot lib/hooks/route, sync-worker snapshot routes (additive), App.tsx ★ (route line), migration 0031 | merged-integration |
| 1 | 177 | Med | swarm/fro-177 | src/lib/search/replace-action.ts, ParallelPassagesPanel.tsx ★ | merged-integration |
| 1 | 178 | Med | swarm/fro-178 | NEW parsers/macula*, ImportDialog.tsx ★, src/lib/import.ts ★, migration 0032 | merged-integration |
| 1 | 181 | Med | swarm/fro-181 | health/decay (useHealth, decay-engine, DecaySettingsSection, EditorTable.tsx ★ needsAttention ONLY, sync-worker rollup additive) | merged-integration |
| 2 | 179 | Med | swarm/fro-179 | ImportDialog.tsx ★, import.ts ★, NEW TN sidebar component, ProjectWorkspace.tsx ★ (mount) | merged-integration → QA 401 → fixer pd5-fix179 (a6ccf05cd1b24a56d) |
| 2 | 190 | Med | swarm/fro-190 | ProjectCard / dashboard health wiring (after 181) | merged-integration → QA token bug → fixer pd5-fix190 (a558570e22641de47) |
| 2 | 186 | Med | swarm/fro-186 | FixReviewPanel.tsx, RulesPage/BuiltinChecksList ★, harmonize event (additive) | merged-integration → QA FAIL inert trigger → fixer pd5-fix186 (ab8cccc6362cf2e2b) |
| 2 | 183-A | Med | swarm/fro-183a | EditorTable.tsx ★ (add-concept-from-selection wiring) | merged-integration → QA selection bug → fixer pd5-fix260 (a6c21bcff4e6decea) |
| 2 | 183-B | Med | swarm/fro-183b | TerminologyPage.tsx ★ (merge-duplicates + review queue) | merged-integration (QA PASS) |
| 2 | 223 | Med | swarm/fro-223 | LivingMemoryPage.tsx ★ | merged-integration (QA PASS) |
| 3 | 191 | Med | swarm/fro-191 | import.ts ★ /eBible target flow, conflict UX | merged-integration |
| 3 | 192 | Med | swarm/fro-192 | EditorTable.tsx ★ gutter, AssignedToMe inbox, assign rail | merged-integration (+orchestrator tsc repair 4fee133) |
| 3 | 214 | Med | swarm/fro-214 | project lifecycle: migration 0033, auth-worker project route (additive), ProjectCard/dashboard ★ | merged-integration |
| 4 | 243 | Med | swarm/fro-243 | first-run tour overlay, dashboard/App mount ★ | dispatched (ac35596c3a7d8dc42) |

Cross-cut rules: per wave, each ★ file has exactly ONE owner; everyone else FORBIDDEN. FRO-183
decomposed into sub-issues A/B (parent stays umbrella; data-model decision recorded on parent —
v1 keeps settings-blob + derive-on-read verdicts per TRACES deferred-tails + derived-over-materialized
preference; kind='termbase' file model / dictionary kind / verdict events stay v2).

## §QA (PD5)
- 2026-06-09 · wave-1 UI-QA agent dispatched (a777b357ba555e88f) vs integration `26f4a04` — walks 215/175/176/177/178/181 click-paths + BT adjudication; appends UI-QA-PUNCHLIST.md §PD5 (main checkout).

## §M PD5 merge log
- 2026-06-10 · **MERGED fix179** `d3d316c` (orchestrator finished the cut-off fixer: TN list-token now mints with the `__project__` sentinel + convention-locking tests; the live-401 root cause stays AMBIGUOUS — auth-worker signs any fileId, so the sentinel alone may not explain it → final QA carries an explicit cross-worker-auth CONTROL check) + `9180e76` unused-React-import repair in fix260's race test. **★ FINAL GATE GREEN @ `9180e76`:** tsc 0 · vitest 2282/20 (baseline 5 files) · sw 485/485 · aw 192/192 · build 0. Final UI-QA dispatched.
- 2026-06-09 · ⚠️ **ORCHESTRATOR INCIDENT + REPAIR:** a `git merge` for fix260 ran in the MAIN checkout (shell cwd had drifted there after a docs update) → main accidentally fast-forwarded to unverified wave-2/3 work. Caught within minutes by a tree-integrity check (fix186's change missing from what was assumed to be integration). Repaired: `git -C main reset --keep 5a67054` (verified wave-1 tip; uncommitted swarm docs preserved), merges redone in the integration worktree. **Lesson recorded: every orchestrator git command MUST use explicit `git -C <path>` — never rely on persistent cwd.**
- 2026-06-09 · **MERGED fix wave + 243** → integration `25e518f`: fix186 `9ec481e` (RulesPage derives real infractions via checkRulesForCell over useLivingMemory cells; 3 tests through the REAL path) · fix260 `7b96ec8` (capturedSelectionRef + toolbarMouseDownRef two-layer fix; FRO-248 dismissal regression-tested) · fix190 `7ed887d` (useProjectHealth mints aud=sync token via makeSyncTokenFetcher + `__project__` sentinel, module-level per-project fetcher cache; +5 sync-worker auth tests, sw 485) · 243 `479a2d2` (6-step portal tour, auto-once keyed on codex:productTourDone after onboardingComplete, OrgSidebar re-launch; workspace-interior steps = follow-up). Awaiting fix179, then FINAL gate + QA.
- 2026-06-09 · **WAVE-2 QA verdicts** (punch-list §PD5 wave-2): PASS 223 + 261 + regression smoke · **FAIL 186** (BUG-FRO186-A: RulesPage `infractions={new Map()}` hardcoded → trigger structurally inert) · **PARTIAL 260** (BUG-FRO260-A: click collapses selection before onClick → dialog empty) · 179 + 190 401s — QA's "dev-only JWT mismatch" theory REFUTED by orchestrator (snapshots passed with minted tokens in the same stack): **190 = real prod bug** (useProjectHealth passes raw session JWT where a minted sync token is required); 179 = token-acquisition suspect (single-arg `getToken("list")` against a (projectId,fileId) mint fn). All four knocked back Fixed→Dispatched w/ Linear comments; fix wave dispatched (pd5-fix186/260/190/179). **Wave-2 promotion HELD until fixes verified.**
- 2026-06-09 · **MERGED wave 3** (191 ff `0d6e33e` · 192 `3649368` · 214 `98920aa`) + **GLUE `1ab1e53`** (ImportDialog sourceCells ← allProjectCells map [191's target mode was unreachable without it]; InactiveProjectBanner + useProjectLifecycle mounted in PW per 214's SWARM-TODO) + **`4fee133`** orchestrator repair: 192's two new test files had 11 tsc errors on integration (FileReference fixture fields + unused React imports) despite agent-reported tsc 0. **★ WAVE-3 GATE GREEN @ `4fee133`:** tsc 0 · vitest **2260/20 = baseline 5 files** · sw 480/480 · aw 192/192 · build 0.
- 2026-06-09 · **★ WAVE-1 PROMOTED TO MAIN (ff)** `dd5c156` → **`5a67054`** after UI-QA: 5 PASS · 1 BLOCKED-env (chat: no LLM key in dev — correct error affordance verified) · 0 FAIL · 0 new bugs. BT adjudication: statistical BT LIVE at ProjectWorkspace.tsx:1285 → FRO-215 audit false-negative corrected in HOMEPAGE-AUDIT-215.md (HITL flags 5→4). QA applied migrations 0031/0032 manually to the dev Postgres container (dev stack doesn't auto-apply incremental migrations — DX gap, traced).
- 2026-06-09 · **MERGED wave 2** (179 `3320486` · 186 `4d3b531` · 190 `27e38d1` · 223 `c7b60f4` · 260 `156fcea` · 261 `17233de`) — all auto-merged, zero conflicts. **★ WAVE-2 GATE GREEN @ `17233de`:** tsc 0 · vitest **2199 pass / 20 fails = 5 baseline files** (TerminologyPage ×7 REPAIRED by 261 — new baseline 20/5: TeamDetail ×10, useSetupChecklist ×4, useAccounts ×3, AssignedToMe ×2, MembersPage ×1) · sw 480/480 · aw 184/184 · build 0. Wave-2 UI-QA dispatching; wave 3 (191/192/214) in flight off this tip.
- 2026-06-09 · integration `swarm/pd5-integration` created off main `dd5c156`.
- 2026-06-09 · **BASELINE @ dd5c156:** root tsc 0 · vitest **1972 pass / 27 pre-existing fails in 6 files** (TeamDetail.test.tsx ×10, TerminologyPage.test.tsx ×7, useSetupChecklist.hook.test.tsx ×4, useAccounts.test.ts ×3, AssignedToMe.test.tsx ×2, MembersPage.test.tsx ×1). Merge gate = zero NEW failures vs this list. ⚠️ TerminologyPage.test.tsx is pre-broken — FRO-261 agent (wave 2) must not be blamed for these 7, but SHOULD repair them if its work touches the same surfaces.
- 2026-06-09 · **MERGED 175** (merge `f13bd91`): ChatPanel (Sheet drawer, composer, streaming, history, pin-cell context) + useChat + chat-service (delegates to existing completion-service `complete()`) + ProjectWorkspace toolbar mount. GATE: tsc 0 · vitest 1998/27 (+26 new, fails = baseline 6 files). Issue → Fixed (agent). Deferred-by-design: cross-session persistence, markdown bubbles.
- 2026-06-09 · **★ WAVE-1 GATE GREEN @ `26f4a04`** (all 6 issues + glue): root tsc 0 · vitest **2095 pass / 27 fails = exactly the baseline 6 files** (+123 net new tests) · sync-worker **473/473** · auth-worker **184/184** · `npm run build` exit 0. Wave 2 dispatching; UI-QA agent launching against the integration stack.
- 2026-06-09 · **MERGED 181** (merge `4a2b6b8`): health off retired endorsement primitives — sync-worker `GET /health-rollup` pull route (confidence ripples from validated anchors via FTS top-k neighbors, `maxHops` bound, default 4), `useHealthRollup` + `health-rollup-read.ts`, DecaySettings shows Max hops, EditorTable `needsAttentionFromConfidence()` surgical. Agent-verified tsc 0 · 40 new client tests · sw 461. DEFERRED honestly: materialized cell_edges graph (FTS is the mechanism), DO `health.rollup` push (pull route only), endorsement_count write-removal. **FRO-190 API: `useHealthRollup({projectId,getToken,cells,decaySettings,enabled})` → `{projectHealth,fileHealth,loading,error}`.** Issue → Fixed (agent).
- 2026-06-09 · **MERGED 177** (merge `05840ff`): replace-action.ts (29 logic tests: multi-cell, HTML-span skip+count, diffs) + Replace mode in ParallelPassagesPanel (18 panel tests; diff preview w/ checkboxes, scope, retain-validations toggle) + optional payload fields on EXISTING `target.cell.commit` (no new event kinds — verified). Two-agent slice (original cut off mid-task; finisher completed in same worktree). ⚠️ retain-validations is client-threaded only — projector ignores `retain_validations` (Q25) → TRACE. Issue → Fixed; honest only after orchestrator glue (below).
- 2026-06-09 · **MERGED 176** (merge `f1dbb1f`): named snapshots end-to-end — migration `0031_project_snapshots` (both dirs + schema.sql fix: dropped wrong file_id col), 5 sync-worker routes (create/list/view/delete/restore; 600+ writes, 100+ reads), restore = MAX(server_seq)≤snapshot_ts per cell re-emitted as commits chained on current heads (idempotent, `{restored,skippedIdentical,skippedConcurrent}`), SnapshotCreate/RestoreDialog (typed confirm) + SnapshotsPage + hook. Agent-verified sw 462 · 12 client tests. Issue → Fixed (agent).
- 2026-06-09 · **GLUE `26f4a04` (orchestrator):** (1) snapshots moved INSIDE the FRO-254 shell — App.tsx route → ProjectWorkspace, `centerSurface="snapshots"` + restore-exclusion + lazy import + Camera nav item (CONFLICT CALL: agent's standalone-route rationale "AD-11/Q24 infrequent admin action" overridden by FRO-254's explicit "every in-project view in the shell" — user-filed requirement wins); (2) `handleReplaceAll` wired at the ParallelPassagesPanel call site through the standard commit path (optimistic patch for visible rows → emitTargetCellCommit w/ targetEventId??sourceEventId parent → one flushOutboxBatch → targeted revalidateCell → rebuildSearchIndex). Finisher's suggested snippet used nonexistent `currentEventId` — corrected. Comprehensive gate running (tsc+vitest+sw+aw+build).
- 2026-06-09 · **MERGED 178** (merge `0efaaf5`): Macula Hebrew+Greek import — migration `0032_cell_word_morph` (both dirs), column-order-robust TSV parser (22 tests), `importMacula()` + ImportDialog card enabled, sync-worker `/import-morph` route. GATE: tsc 0 · vitest 2020/27 (fails = baseline 6 files) · sync-worker 450/450. Issue → Fixed (agent).
- 2026-06-09 · **MERGED 215** (ff `6aff43e`): routing verified (worker/index.ts:33 edge + App.tsx:86 RootRedirect + session-store cookie lifecycle), HOMEPAGE-AUDIT-215.md (22 claims: ~10 delivered / 4 partial / 2 not / **5 HITL flags for user**), manifesto chips dimmed "soon". GATE: tsc 0 · vitest 1972/27 = baseline-identical. Issue → Fixed (agent). ⚠️ audit claims BT "not delivered" (runBacktranslation stub) — CONTRADICTS TRACES (BT shipped 2026-05-31); UI-QA must check the BT tab live before trusting it.

## §CLAIMS (PD5)
- FRO-215: RECLAIMED from stale pd3 Dispatched (pd3 converged + promoted earlier today; no live agent owns it; user explicitly targeted it). Re-dispatched under PD5.
