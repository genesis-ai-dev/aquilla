# AQU Dashboard Swarm — Batch 2 (labels + assignments + member)

Resume of the paused workstreams from `AQU-DASHBOARD-ORCHESTRATION.md`.
Source: ETEN/Randall + Anna (Come-and-See) dashboard feedback, 2026-07-07.
Integration branch: `swarm/aqu-dashboard2-integration` (off `dev` tip `e2478358c`).
Promotion target: **dev** (this repo trunks on dev, not main). Orchestrator-only merges.
Started: 2026-07-08.

## §0 STOP checklist (the goal)
- [ ] Every issue (488, 491, 489, 494, 495, 496, 497, 498) at **Fixed** (verified) or honestly **blocked**.
- [ ] Integration green: `npx tsc -b --noEmit` + scoped `npx vitest run`; `npm run build` before promotion.
- [ ] `cd auth-worker && npx tsc --noEmit && npm test` green **if** touched (496 likely touches it).
- [ ] Each fix verified on the real dev stack (live UI) before → Fixed, OR live-UI QA explicitly deferred and traced.
- [ ] Promoted to dev only with dev's tree clean apart from recorded protected files.
- [ ] Every remaining gap traced in TRACES.md.

## §EXCLUDED / protected
- Protected/untracked (do not touch): `.migrate-state.json.bak-local-jun25`.
- SCOPE LOCK: only the 8 issues above. Do NOT pick up other Todo issues in "Prototype Debugging".
- Prereq already merged: AQU-485 (member-progress permission + `memberProgressViewMinRole`) — 498 consumes it.

## §1 Operating model
- Base = dev tip `e2478358c`. One sonnet agent per issue, manual worktree off the LIVE
  integration tip (never isolation:worktree). Orchestrator claims (→ Dispatched, assign me)
  before spawning, merges to integration on green, promotes to dev in batches. Agents never
  push/deploy/promote. Live-UI verification is a centralized singleton on the seeded dev stack.

## §3 Workstream registry + wave plan (file-disjoint lanes, concurrent)

`ProjectOverview.tsx` (1221L) + `OrgHome.tsx` (1038L) are the shared presentational hotspot →
hard-serialize the overview lane. Members-scope label lives INSIDE MembersTab
(`ProjectMembersPage.tsx`) so it renders consistently and stays off the overview files.
Assignment component files are disjoint from both.

| Lane | Issues (serial order) | Owns (files) | Forbidden |
|------|-----------------------|--------------|-----------|
| A — Members | 488 | `src/components/ProjectMembersPage.tsx` (MembersTab), `src/components/MembersPanel.tsx`, `src/pages/MembersPage.tsx`, `src/hooks/useProjectMembers.ts` | ProjectOverview.tsx, OrgHome.tsx, all assignment files |
| B — Overview | 489 → 491 → 498 | `src/components/org/ProjectOverview.tsx`, `src/components/org/OrgHome.tsx`, `src/lib/progress/*`, `src/lib/frontier/portfolio.ts` | members files, all assignment files |
| C — Assignments | 494 → 495 → 496 → 497 | `src/components/org/AssignWork.tsx`, `AssignModal.tsx`, `WorkloadRollup.tsx`, `AssignedToMe.tsx`, `src/components/ProjectAssignedToMe.tsx`, `AssignmentGutter.tsx`, `src/lib/sync/assignments.ts`, `src/components/ProjectSettings.tsx`, `auth-worker/src/services/assignments.ts` (+ its route) | ProjectOverview.tsx, OrgHome.tsx, members files |

Cross-lane note: `AssignWork` is imported/rendered by `ProjectOverview.tsx` (line ~1171); if a
Lane-C issue must change AssignWork's props consumed there, it FLAGS the call-site as
out-of-scope — orchestrator threads it at merge. Same for `<WorkloadRollup>` in OrgHome (~989).

Wave 1 heads (concurrent): **488, 489, 494**. Next-in-lane unlocks as each merges.

### Per-issue status (live)
| Issue | Pri | Title (short) | Lane | Claim | Branch | Status |
|-------|-----|---------------|------|-------|--------|--------|
| AQU-488 | Med | members section scope label | A | done | swarm/aqu-488 | **Fixed → merged** df899ceb8 |
| AQU-489 | High| progress number legend | B | done | swarm/aqu-489 | **Fixed → merged** (org "Has Audio" parity) |
| AQU-491 | Low | name truncation expand | B | done | swarm/aqu-491 | **Fixed → merged** (ExpandableName popover; OrgHome links deferred→follow-up) |
| AQU-498 | Med | member productivity detail | B | done | swarm/aqu-498 | **Fixed → merged** (sync-worker activity endpoint + gated MemberActivityPanel) |
| AQU-494 | Med | remove completed assign + project on row (bug) | C | done | swarm/aqu-494 | **Fixed → merged** (unassign path + per-assignment workload rows) |
| AQU-495 | Med | open-assignments live update (bug) | C | done | swarm/aqu-495 + int 9be1fb75d | **Fixed → merged** (orchestrator applied onAssigned→loadWorkload post-498) |
| AQU-496 | Med | configurable self-assignment | C | done | swarm/aqu-496 | **Fixed → merged** (org key allowSelfAssignment + sync-worker carve-out) |
| AQU-497 | Med | bulk season/book assign | C | done | swarm/aqu-497 | **Fixed → merged** (corpusMarker season group + N-events bulk create) |

## §M Merge log
(append: date · lane · branch · sha · tsc · vitest)

**FINAL CONSOLIDATED GATE — 2026-07-08, integration tip `1e1c0bb9a` (all 8 Fixed):**
- root `tsc -b --noEmit` ✓ 0
- consolidated client `vitest run` (org/, settings/, ui/expandable-name, ProjectMembersPage, AssignModal, lib/sync/, Settings) → **513/513** (47 files)
- `npm run build` ✓ (`✓ built in 46s`; `[check-brand-build] aquilla OK`)
- auth-worker `tsc0` + **613/613**; sync-worker `tsc0` + **745/745** (run after 496; 497 touched neither)
- Live-UI QA: NOT yet run (deferred, consistent w/ batches 1-2) — SWARM-TODO click-paths captured per issue below.

- 2026-07-08 · Lane A · swarm/aqu-488 → integration (FF, tip df899ceb8) · tsc0 · ProjectMembersPage 15/15. Real per-row access-path badges (role.source override/group/org/creator), heading "Members of this project". Lane A COMPLETE. Live-UI QA pending (batched). Spec: members-and-sharing.md updated (specs repo adcfeb9).
- 2026-07-08 · Lane B · swarm/aqu-489 → integration (ort merge, tip 2c29b2397) · tsc0 · org/ 145/145. Org projects table "Audio"→"Has Audio" + header tooltips for parity w/ ProjectOverview; refused fabricated per-medium validated col. No spec edit (undocumented surface, tracked by divergence project).
- 2026-07-08 · Lane C · swarm/aqu-494 → integration (ort merge, tip f2a2a6952) · tsc0 · SPA org+assignments 158/158 · auth-worker tsc0 + 606/606. New client `unassignAssignment()` + Remove button; workload API now per-assignment w/ projectName+fileId; WorkloadRollup self-sources username (no OrgHome edit). Spec: assign-cell-to-member.md updated (specs repo 4ce2209).
- 2026-07-08 · Lane B · swarm/aqu-491 → integration (ort merge, tip 6a1d91797) · tsc0 · org/ 149/149 + expandable-name 2/2. New `ExpandableName` (base-ui Popover, overflow-measured) in ProjectOverview file+team name cells. FOLLOW-UP (traced): OrgHome project-name truncations left hover-only (names inside row-level <Link>, nested-anchor invalid) — needs trailing-icon-button pattern.
- 2026-07-08 · Lane C · swarm/aqu-495 → integration (ort merge, tip 24b9f3ad8) · tsc0 · assignment suites 26/26. Branch = regression tests + SWARM-TODO + JSDoc ONLY (no functional change). ROOT CAUSE found: ProjectOverview.tsx Team card `<AssignWork onAssigned={loadRow}/>` — `loadRow` refetches portfolio but NOT `getProjectAssignments(jwt,id).then(setWorkload)`. (Sidebar "My assignments" already revalidates live — not the bug.)
- 2026-07-08 · Lane B · swarm/aqu-498 → integration (ort merge, tip pre-495) · root tsc0 · sync-worker tsc0 + member-activity 7/7 · org/ 149/149. New sync-worker `GET .../members/:author/activity` (recentEvents + fileRollup derived from cells.last_editor/word_count → reconciles w/ totals) + server floor `resolveMemberProgressFloor` (403 below memberProgressViewMinRole) + client hook/types + `MemberActivityPanel` behind existing SectionVisibilityGate. Deferred (SWARM-TODO): member selection scoped to open-assignment assignees, not full roster. Spec: members-and-sharing.md (specs repo fb8feaf). Touched sync-worker/src/index.ts (route reg — watch for 496 union).
- 2026-07-08 · Lane C · AQU-495 REAL FIX · orchestrator commit `9be1fb75d` on integration · tsc0 · ProjectOverview 44/44. `onAssigned={handleAssigned}` refetches portfolio + workload (loadWorkload). AQU-495 → Fixed. Revalidation contract unit-tested at component level (merged 495 branch); end-to-end "updates w/o reload" on live-UI QA click-path.
- 2026-07-08 · Lane C · swarm/aqu-496 → integration (ort merge, tip 262ea92eb) · root tsc0 · client 179/179 · auth-worker tsc0 + 613/613 · sync-worker tsc0 + 745/745. org key `allowSelfAssignment` (owner-only, default false); server carve-out in sync-worker authorize.ts + assignment-authority.ts (below-lead may self-assign ONLY, self only); client mirror canOpenAssignUi/canSubmitAssignment; new /settings/assignment page. FOLLOW-UP (SWARM-TODO in AssignWork.tsx): ProjectOverview Team-card AssignWork caller doesn't pass the new props yet — self-assign reachable from workspace AssignModal path, not the overview card (manager surface, gated; acceptance met on primary path). NOTE: fixed integration-worktree sync-worker node_modules symlink (was a stray real dir → ln footgun).
