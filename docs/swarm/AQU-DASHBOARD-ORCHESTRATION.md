# AQU Dashboard Swarm — Orchestration

Source: ETEN/Randall + Anna (Come-and-See) dashboard feedback, 2026-07-07. Issues AQU-485..501.
Integration branch: `swarm/aqu-dashboard-integration` (off `dev` tip `1ef11a258`).
Promotion target: **dev** (this repo trunks on dev, not main). Orchestrator-only merges.

## §0 STOP checklist (the goal)
- [ ] Every one of the 17 issues (AQU-485..501) at **Fixed** (verified) or honestly **blocked** with a Linear note.
- [ ] Integration green: `npx tsc -b --noEmit` + `npx vitest run`; `npm run build` before each promotion.
- [ ] `cd auth-worker && npx tsc --noEmit && npm test` (+ sync-worker) green **if** touched.
- [ ] Each fix verified on the real dev stack (live UI) before → Fixed; spec reconciled per /issue Step 2.5.
- [ ] Promoted to dev only with dev's tree clean apart from recorded protected files.
- [ ] Every remaining gap traced in TRACES.md.

## §EXCLUDED / protected
- Protected/untracked (do not touch, not ours): `.migrate-state.json.bak-local-jun25`.
- SCOPE LOCK: only AQU-485..501. Do NOT pick up other Todo issues in "Prototype Debugging".
- Backlog (NOT in this swarm): AQU-502..507 (needs-info + Monday + PM-sort).

## §1 Operating model
- Base = dev tip. One sonnet agent per issue, manual worktree off the LIVE integration tip
  (never isolation:worktree). Orchestrator claims (→ Dispatched, assign me) before spawning,
  merges to integration on green, promotes to dev in batches. Agents never push/deploy/promote.
- Live-UI verification is a centralized singleton on the seeded dev stack.

## §3 Workstream registry + wave plan
Serialized where files overlap (see Explore file-overlap matrix — filled in below once mapped).

| WS | Issues (in order) | Surface | Concurrency |
|----|-------------------|---------|-------------|
| WS-Perms | AQU-485 → 487 → 501 → 486 | org/project settings + permission resolution + dashboard section visibility | serialize (shared settings surface); 486 may split if disjoint |
| WS-Progress-table | AQU-493 → 499 → 500 → 490 → 492 | progress table / overview component | serialize (same component) |
| WS-Dashboard-labels | AQU-488, 491, 489 | members-scope label, name truncation, progress legend | mostly isolated |
| WS-Assignments | AQU-494 → 495 → 496 → 497 | assignment / team-workload system | serialize |
| WS-Member | AQU-498 | member productivity detail (after 485 merges) | after WS-Perms 485 |

Run mode: **WS-Perms first, then checkpoint** (user decision 2026-07-08).

### Per-issue status (live)
| Issue | Title (short) | WS | Claim | Branch | Status |
|-------|---------------|----|----|--------|--------|
| AQU-485 | roster/progress visibility perms | Perms | — | — | Todo |
| AQU-487 | remove per-project default perm | Perms | — | — | Todo |
| AQU-501 | project settings sub-menu IA | Perms | — | — | Todo |
| AQU-486 | per-section visibility indicator | Perms | — | — | Todo |
| AQU-493 | chapter/verse rollup | Prog | — | — | Todo |
| AQU-499 | progress table sort/filter | Prog | — | — | Todo |
| AQU-500 | CSV/clipboard progress export | Prog | — | — | Todo |
| AQU-490 | audio validation separate | Prog | — | — | Todo |
| AQU-492 | file-breakdown table columns | Prog | — | — | Todo |
| AQU-488 | members section scope label | Labels | — | — | Todo |
| AQU-491 | name truncation expand | Labels | — | — | Todo |
| AQU-489 | progress number legend | Labels | — | — | Todo |
| AQU-494 | remove completed assignment bug | Assign | — | — | Todo |
| AQU-495 | open-assignments live update bug | Assign | — | — | Todo |
| AQU-496 | configurable self-assignment | Assign | — | — | Todo |
| AQU-497 | bulk season assign | Assign | — | — | Todo |
| AQU-498 | member productivity detail | Member | — | — | Todo |

## §M Merge log
(append: date · WS · branch · sha · tsc · vitest)

## Surface map / file-overlap matrix (from Explore 2026-07-08)

**Hotspot files (many issues converge — serialize hard):**
- `src/components/org/OrgHome.tsx`, `src/components/org/ProjectOverview.tsx`, `src/lib/frontier/portfolio.ts` — dashboard (486, 489, 490, 492, 494, 495, 499, 500, 498).
- `auth-worker/src/services/project-permissions.ts` + `org-permissions.ts`, `auth-worker/src/routes/org-settings.ts` + `project-settings.ts` + `projects.ts` + `orgs.ts` — permissions (485, 487).

**Key files by surface:**
- Settings UI: `src/pages/Settings.tsx` (org, sub-menu pattern = template for 501), `src/components/ProjectSettings.tsx` + `src/components/ProjectSettings/SettingsNav.tsx` (project, long-scroll → 501).
- Perm model: `src/lib/frontier/roles.ts` (ladder — READ ONLY, shared), `useProjectPermissions.ts`, `src/lib/sync/role-policy.ts`. Export-floor pattern (`exportMinRole`, owner-only write) in `org-settings.ts` = template for 485's new keys.
- Roster UI: `src/pages/MembersPage.tsx`, `src/components/MembersPanel.tsx` (reused), `src/components/ProjectMembersPage.tsx`, `useProjectMembers.ts`, `useOrg.ts`.
- Progress: `OrgHome.tsx`, `ProjectOverview.tsx`, `portfolio.ts`, `src/lib/progress/read-validation-count.ts` (validationCountAudio lives here → 490), `WorkloadRollup.tsx`.
- Assignments: `AssignWork.tsx`, `auth-worker/src/services/assignments.ts`, `AssignedToMe.tsx`, `ProjectOverview.tsx` (workload section), `TeamDetail.tsx`.
- Sorting: `OrgHome.tsx::sortProjectsByLens`, `ProjectsList.tsx`, `portfolio.ts` (→ 499). NOTE: current sort is ProjectLens (recent/least-translated/etc.), NOT "total cells" as the issue assumed — agent to reconcile.

**Wave revision:** WS-Perms = P1: AQU-485 solo (touches settings+perm-services+roster). P2 (after 485 merges): AQU-487, 501, 486 in parallel (487=perm-services/members, 501=ProjectSettings.tsx, 486=OrgHome/ProjectOverview — mutually disjoint). ProjectOverview/OrgHome are a hard-serialize hotspot for later waves.
