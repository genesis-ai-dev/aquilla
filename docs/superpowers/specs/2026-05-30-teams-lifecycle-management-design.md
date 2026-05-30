# Teams (Groups) Lifecycle & Management — Design

**Status:** Design
**Date:** 2026-05-30
**Scope:** Make the read-only "Teams" surfaces from the org-context shell fully manageable: create / rename / delete teams, add / remove members, and attach / detach projects at a role. Each action is a per-path grant or revocation. All team management is gated on org role ≥ `maintainer` (600). This is the first Phase 2 slice of the org-context work.

Related: [Org Context & Navigation](2026-05-30-org-context-navigation-design.md) (Phase 1, shipped — the read-only Teams surfaces this extends), `~/frontierrnd/aquilla-specs/01-personas-and-roles.md` (Groups section, capability table, revocation discipline, AD-12), [auth-worker/migrations/0007_ad12_groups.sql](../../auth-worker/migrations/0007_ad12_groups.sql).

---

## Motivation

Phase 1 shipped the org-context shell with **read-only** Teams (a "Team" is the UI label for a `group` — an org-scoped permission bundle). Teams can be listed and inspected, but not created or changed: there are no group-CRUD endpoints and no management UI. The data model ([migration 0007](../../auth-worker/migrations/0007_ad12_groups.sql)) and the max-wins role resolver have supported groups since before Phase 1; only the lifecycle surface is missing.

Without it, the manager-portfolio model from the personas spec can't be expressed in-app: Come and See's leads, each over a slice of projects, are meant to be a team (group) attached to that slice at a role. This slice makes that possible.

## Goals

1. **Team CRUD:** create (name + optional description), rename/edit, delete (FK-cascades members + grants).
2. **Membership:** add an org member to a team; remove a member. Members must already belong to the org.
3. **Project attachment:** attach a project to a team at a `role_level`, change that role, detach. No cross-org attachments.
4. **Uniform gate:** every team action requires the caller's org role ≥ `maintainer` (600).
5. **Per-path revoke:** remove-member, detach-project, and delete-team are the revocation actions for this slice.
6. **Close an invariant gap:** removing an org member must also remove that user's `group_members` rows in the org (the route must cascade this; today it doesn't).

## Non-Goals (deferred)

- The AD-12 **effective-access debugger** (per-user view of every grant path on a project) and the **atomic "revoke all paths"** action. Deferred to a follow-up, per the scope decision.
- The finer capability split in the personas table (attach/detach gated on *project* maintainer rather than org maintainer). We use one uniform org-level gate; revisit if a non-org-admin project maintainer needs to attach existing teams.
- Granting a team `owner` (700) on a project beyond the caller's own org role (see the role cap below).
- Cross-org groups, nested groups, implicit/default groups (all out of v1 per the personas spec).

## Current State (verified)

- **Schema** ([migration 0007](../../auth-worker/migrations/0007_ad12_groups.sql)): `groups(id, org_id, name, description, created_by, created_at, updated_at)` UNIQUE(org_id, name); `group_members(group_id, user_id, added_by, added_at)` PK(group_id,user_id); `group_project_grants(group_id, project_id, role_level, granted_by, granted_at)` PK(group_id,project_id). FK `ON DELETE CASCADE` from group→members and group→grants, and org→groups. Two invariants the schema *cannot* enforce (documented in the migration): group members must be org members of the same org; a grant's project must be in the group's org.
- **Backend:** Phase 1 added read-only `GET /api/v2/orgs/:orgId/groups` and `GET /api/v2/orgs/:orgId/groups/:groupId` ([routes/orgs.ts](../../auth-worker/src/routes/orgs.ts), services `listOrgGroups`/`getOrgGroupDetail` in [org-permissions.ts](../../auth-worker/src/services/org-permissions.ts)). **No write endpoints exist.** `getOrgMemberRole`, `lookupUserByUsername`, and `isCanonicalRoleLevel` exist. `DELETE /orgs/:orgId/members/:userId` removes only the `org_members` row — it does **not** cascade to `group_members`.
- **Client:** `src/lib/frontier/teams.ts` has `listTeams`/`getTeam`; `src/components/org/TeamsList.tsx` + `TeamDetail.tsx` are read-only; `useActiveOrg().activeOrg.role.level` gives the caller's org role for gating affordances. `listOrgMembers` (org-member picker source) and `fetchAccessibleProjects(jwt, orgId)` (project picker source) already exist.
- **Tests:** auth-worker uses the real-D1 `@cloudflare/vitest-pool-workers` harness (helpers in `src/__tests__/helpers/d1.ts`); client uses vitest + happy-dom + RTL.

No schema changes are needed.

## Endpoints (all under `/api/v2`, all auth-required, all gated org role ≥ 600)

The gate is `getOrgMemberRole(env, orgId, user.id) >= ROLE.MAINTAINER`, else 403. All operate within `:orgId`; a group/project/member not in that org → 404.

| Method | Path | Body | Behavior & invariants |
|---|---|---|---|
| `POST` | `/orgs/:orgId/groups` | `{name, description?}` | Insert group (`created_by = caller`). Duplicate name in org → 409 (UNIQUE org_id+name). Returns `{id, name, description}`. |
| `PATCH` | `/orgs/:orgId/groups/:groupId` | `{name?, description?}` | Update; bumps `updated_at`. Duplicate name → 409. 404 if group not in org. |
| `DELETE` | `/orgs/:orgId/groups/:groupId` | — | Delete group; FK cascade removes its `group_members` + `group_project_grants`. 404 if not in org. |
| `POST` | `/orgs/:orgId/groups/:groupId/members` | `{username}` | Look up user; **must have an `org_members` row in this org** → else 409 `"user is not a member of this org"`. Upsert `group_members` (`added_by = caller`). |
| `DELETE` | `/orgs/:orgId/groups/:groupId/members/:userId` | — | Delete the `group_members` row. |
| `POST` | `/orgs/:orgId/groups/:groupId/projects` | `{projectId, roleLevel}` | **Project must be in this org** (`projects.org_id = orgId`) → else 409. `roleLevel` must be a canonical level and **≤ caller's org role** → else 403 (can't grant above your own level; matches the existing member-add rule). Upsert `group_project_grants` (`granted_by = caller`). |
| `PATCH` | `/orgs/:orgId/groups/:groupId/projects/:projectId` | `{roleLevel}` | Same canonical + ≤-caller-role cap. 404 if no such attachment. |
| `DELETE` | `/orgs/:orgId/groups/:groupId/projects/:projectId` | — | Delete the `group_project_grants` row. |

### Existing-route fix

`DELETE /api/v2/orgs/:orgId/members/:userId` ([routes/orgs.ts](../../auth-worker/src/routes/orgs.ts)) currently runs only `DELETE FROM org_members …`. Add, in the same handler, a delete of the user's group memberships scoped to the org:

```sql
DELETE FROM group_members
 WHERE user_id = ?
   AND group_id IN (SELECT id FROM groups WHERE org_id = ?)
```

so removing an org member also strips their team grants in that org (the invariant the personas spec requires the route to enforce).

### Response shapes

```ts
// POST/PATCH group → { id: number; name: string; description: string | null }
// POST member   → { userId: number; username: string }
// POST/PATCH project grant → { projectId: string; roleLevel: number }
// DELETE *       → { removed: true }
```

Error shape stays `{ error: string }`. Role names via the existing `ROLE_NAMES`.

### Service helpers (`auth-worker/src/services/org-permissions.ts`)

Add small, single-statement helpers mirroring the existing style: `createGroup`, `updateGroup`, `deleteGroup`, `addGroupMember` (with the org-member check), `removeGroupMember`, `attachGroupProject` (with the same-org + role checks), `updateGroupProjectRole`, `detachGroupProject`. Each is a focused query; the route does the gate + invariant checks and shapes the response.

## Client (extend the Phase 1 Teams surfaces — no new top-level routes)

Admin affordances appear only when `useActiveOrg().activeOrg.role.level >= 600`.

- **`TeamsList`** gains a **"New team"** button (admin-only) → a create dialog (name + description) calling `createTeam`; on success, navigate to the new team's detail.
- **`TeamDetail`** becomes read+write for admins:
  - Header: inline **rename / edit description**; a **Delete team** action (confirm dialog: "Delete '<name>'? This removes the team and all its grants").
  - **Members** section: an **org-member picker** (search/select from the org's members — *not* a free-text username, since members must already be in the org) to add; per-row **Remove**.
  - **Projects** section: a **project picker** (the org's projects) + a **role select** to attach; per-row inline role change + **Detach**.
  - Non-admins keep the current read-only view.
- **`src/lib/frontier/teams.ts`** gains typed wrappers: `createTeam`, `updateTeam`, `deleteTeam`, `addTeamMember`, `removeTeamMember`, `attachProject`, `changeProjectRole`, `detachProject` (mirroring the existing `listTeams`/`getTeam` + the `orgs.ts` wrapper style, using `fetchWithTimeout`).
- The org-member picker can reuse the existing `listOrgMembers` (already wrapped in `src/lib/frontier/orgs.ts`); the project picker can reuse `fetchAccessibleProjects(jwt, activeOrgId)`.

## Data Flow

1. Admin opens a team (`/teams/:groupId`) → `getTeam` populates members + attached projects.
2. **Add member:** pick an org member → `addTeamMember(orgId, groupId, username)` → server verifies org membership → refetch detail.
3. **Attach project:** pick an org project + role → `attachProject(orgId, groupId, projectId, roleLevel)` → server verifies same-org + role cap → refetch.
4. **Effect:** because the AD-12 max-wins resolver already reads `group_project_grants` ⋈ `group_members`, a member added to a team immediately gains the granted role on the team's attached projects on their next request — no extra wiring.
5. **Remove org member** (from MembersPage): the patched `DELETE /orgs/:orgId/members/:userId` now also clears their `group_members` rows in the org.

## Error Handling

- Gate failure → 403. Group/member/project not in the org → 404. Duplicate team name → 409. Non-org-member add → 409 with a clear message. Cross-org attach → 409. Role above caller's org role → 403. Client surfaces these inline on the relevant dialog/row.

## Testing

**Backend (real-D1 harness):** per endpoint — happy path + gate 403 (caller org role < 600) + the specific invariant rejections (duplicate name 409; non-org-member add 409; cross-org attach 409; over-cap role 403) + 404s for wrong-org ids. Plus a test for the member-remove cascade: a user in a team, removed from the org, no longer has the `group_members` row (and the projects-list resolution no longer grants via that group).

**Client (RTL):** create-team dialog → list/detail; add-member via the org-member picker (asserts the picker is org-scoped); attach-project + role select; role-change; detach; delete-team confirm. Admin vs non-admin affordance gating (role 600 shows controls; < 600 doesn't).

## Phasing

Same split as Phase 1: a **backend plan** (the 8 endpoints + service helpers + member-remove cascade fix, TDD on the real-D1 harness) then a **client plan** (the management UI on top of the Phase 1 Teams surfaces). Backend lands first so the client builds against real endpoints.

## Risks & Open Questions

1. **Role cap rule.** "≤ caller's org role" prevents an org-maintainer (600) from granting a team `owner` (700). This is the chosen rule (matches the existing member-add `role ≤ caller` rule). Confirm it's the intended ceiling rather than a fixed "≤ maintainer" cap.
2. **Member-remove cascade scope.** The cascade removes `group_members` rows but intentionally does **not** touch the user's direct `project_members` rows (a user may be a direct member independent of the org) — matching the existing remove-from-org semantics. The effective-access/revoke-all-paths follow-up is where full multi-path revocation lands.
3. **Org-member picker data.** Reuses `listOrgMembers`; for very large orgs this is unpaginated today — fine at current scale, revisit with the broader members work.
4. **No effective-access debugger yet.** Until the deferred follow-up, an admin reasons about a user's access per-path (team by team) rather than via one aggregated view. Acceptable for this slice.
