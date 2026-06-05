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
