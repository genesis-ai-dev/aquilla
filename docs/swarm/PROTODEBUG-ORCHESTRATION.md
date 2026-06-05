# SWARM ORCHESTRATION — Prototype Debugging (Wave 2, 2026-06-05)

Driver: `/swarm-orchestration` on Linear project **Prototype Debugging** (FRO). Wave 2 = FRO-165..172.
Base: clean `cc7b5ed`. (Wave 1 = FRO-158..162, all Fixed + on `dev`/staging.)

## §0 STOP checklist
- [x] FRO-165, 167, 169, 171, 172 implemented + verified green + merged to main.
- [ ] FRO-168, 170 (HITL): proposals surfaced to user; implement only after approval.
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
