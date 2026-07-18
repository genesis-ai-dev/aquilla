# Guest-org / project-invite navigation swarm — ORCHESTRATION

Started 2026-07-06. Project: **Prototype Debugging** (Linear id `215cff7b-1a95-443d-9343-1f1528754462`).
Scope: user-directed subset — AQU-473, AQU-474, AQU-475 ONLY. Do NOT drain the rest of the backlog.
Base: `dev` @ `8774bebf3`. Integration branch: `swarm/guest-org-integration`
(worktree `.worktrees/guest-org-integration`). Promotion target: **dev** (repo works dev→main via PR).

## §0 STOP checklist
- [ ] AQU-473, AQU-474, AQU-475 each at **Fixed** (verified) or honestly blocked with a Linear note.
- [ ] Integration green: `npx tsc -b --noEmit` + `npx vitest run`; `npm run build` before promotion.
- [ ] auth-worker tsc/test green IF touched.
- [ ] Each fix verified on the real dev stack (live UI) before Fixed.
- [ ] Promoted to dev only with dev's tree clean.
- [ ] Gaps traced in docs/swarm/GUESTORG-TRACES.md.

## §EXCLUDED
- Entire remainder of Prototype Debugging Todo backlog — user scoped this swarm to the three issues above.

## §1 Operating model
Orchestrator merges; agents never push/deploy/promote. One live-UI QA singleton after code lands.

## §3 Workstream registry + wave plan

| Issue | Surface (OWNED files) | Branch / worktree | Wave | Status |
|---|---|---|---|---|
| AQU-474 project-only invitee can't enter project | `src/components/org/ProjectOverview.tsx`, `src/components/org/OrgSidebar.tsx`, `src/components/SidebarProjectSection.tsx`, `src/hooks/useAccessibleProjects.ts` | `swarm/fro-474` / `.worktrees/fro-474` | 1 | pending dispatch |
| AQU-475 all-orgs overview hides shared projects | `src/components/org/OrgHome.tsx`, `src/lib/frontier/shared-projects.ts` (+ its test) | `swarm/fro-475` / `.worktrees/fro-475` | 1 | pending dispatch |
| AQU-473 guest orgs in switcher | `src/context/OrgContext.tsx`, `src/components/org/OrgSwitcher.tsx`, `src/lib/sync/cloud-projects.ts`, `auth-worker/src/routes/projects.ts` (org-name join), `Org #<id>` strings in OrgHome/OrgSidebar | `swarm/fro-473` / `.worktrees/fro-473` (off integration @ 279001504) | 2 | dispatched 2026-07-06 |

Post-wave-1 integration: 279001504 (both wave-1 merges), tsc 0, vitest 407f/3310 pass.
Live-UI QA plan: ONE combined QA pass over all three SWARM-TODOs after AQU-473 merges, before any issue → Fixed.

Dependency: AQU-473 (wave 2) builds on AQU-474's accessible-projects/nav data and must see wave-1 merged
code (guest-org click-through only works once ProjectOverview stops redirecting). File-overlap: 473↔474 both
read `useAccessibleProjects.ts`; 474 owns it in wave 1, 473 must not edit it without flagging.

## §M Merge log
(append: date · WS · branch · sha · tsc · vitest)
- 2026-07-06 · AQU-475 · swarm/fro-475 · 0b880084c · tsc 0 · vitest 407 files/3303 pass (integration). Agent flagged follow-up: accessible-projects endpoint lacks org name — shared rows show "Org #<id>" fallback.
- 2026-07-06 · AQU-474 · swarm/fro-474 · d4776e143 · tsc 0 · vitest running (agent-local: 408 files/3307 pass). Agent flags: portfolio Progress card degrades (may 403 cross-org, accepted); spec-reconcile step deferred to orchestrator; possible backend ticket for guest portfolio stats.
- 2026-07-06 · AQU-473 · swarm/fro-473 · 07db01e89 · tsc 0 · vitest 408f/3316 pass + auth-worker 58f/509 pass (integration, exit 0). Includes auth-worker org-name join + Org #<id> → real-name swap.
- Live-UI QA singleton dispatched over all three SWARM-TODOs (integration worktree, shared dev stack).
