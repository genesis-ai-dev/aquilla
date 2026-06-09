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
- [ ] FRO-233, 180, 173, 255, 258, 231 each at Fixed (verified) or honestly blocked w/ Linear note.
- [ ] Integration green: `npx tsc -b --noEmit` + `npx vitest run`; `npm run build` before promotion.
- [ ] auth-worker / sync-worker tsc+tests green if touched.
- [ ] Each fix live-UI verified on the seeded dev stack (central QA slot) before Fixed.
- [ ] Promote to main only with main checkout (codex-web-app-fro247 worktree) clean.
- [ ] Gaps traced in docs/swarm/TRACES.md.

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
- 2026-06-09 · export-fmt(233) · af3b5d6→merge 47d47d7 · docx.ts extractDominantRpr + clone rPr onto injected run (bold/italic/sz/rFonts survive); +6 tests (13/13 on integration) · tsc 0 · 27 pre-existing, 0 new · SWARM-TODO: mixed-format paragraphs collapse to dominant rPr (needs import-time run map) · agent moved FRO-233 → Fixed; spec AC-2a amendment drafted in Linear comment, ORCHESTRATOR to apply in ~/frontierrnd/aquilla-specs/04-features/export-and-legacy-import.md.

## §CLAIMS (PD4)
- FRO-233: was already Dispatched+assigned (pd3 agent handoff comment 2026-06-09 21:39Z explicitly ended its slice → stale claim, reclaimed by PD4 finisher).
- FRO-180/173/255/258/231: claimed Todo→Dispatched by PD4 orchestrator before spawn.
