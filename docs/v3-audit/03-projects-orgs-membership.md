# v3 Audit — Projects, Orgs, Membership

## Summary

Project creation (Dashboard + onboarding) is fully D1-backed: server row created first (POST /api/v2/projects), languages persisted via settings, then local IDB cache. No legacy Yjs doc creation paths remain. Org/membership surface is architectural but disconnected—org/group routes are built (org-permissions.ts, orgs.ts) but have no UI integration beyond the MembersPage (which targets org-level admin, not the project dashboard flow).

## Chains of custody

### Project creation
Dashboard.tsx + ProjectCreateDialog.tsx: (1) createCloudProject(jwt, { id, name }) → POST /api/v2/projects on auth-worker → D1 projects row with created_by = session.id, org_id from getOrCreateUserOrg(). Creator role is 700 (owner). (2) Optional patchProjectSettings() for languages. (3) createProject() persists to local IDB. Onboarding/ProjectStep.tsx mirrors this flow via createRemoteProject(). Both paths require signed-in session.

### Project mutation (settings, archive)
Settings: patchProjectSettings() → PATCH /api/v2/projects/:id/settings (auth-worker) uses ifMatchVersion for conflict detection. Role check is 500+ (PROJECT_LEAD). Archive: Dashboard.handleTrashConfirm() → tombstoneProject() → POST /api/v2/projects/:id/archive (auth-worker), role check 700 (owner-only). sync-worker receives archive notification via notifySyncWorkerOfArchive() for state cleanup (project-archive.ts).

### Org / membership / invite
Org: getOrCreateUserOrg() called on project create (auth-worker/services/org-permissions.ts); auto-provisions user's personal org if absent. Members: auth-worker/routes/projects.ts GET/:projectId/members returns effective list (direct + org grants + creator). Invites: two surfaces—single-project (projects.ts POST/:projectId/invites) and multi-project (invites.ts POST /multi). Accept materializes project_members row. No UI integration: /members page exists but targets org management (MembersPage.tsx), not project-level invites.

## Findings

### F1: Org-level routes exist but unreachable from UI
- **Severity**: low
- **Category**: dead-code | mismatch
- **Evidence**: auth-worker/src/routes/orgs.ts (28–159): GET/POST/DELETE /api/v2/orgs/:orgId/members fully implemented. MembersPage.tsx (lines 48–113) wires useOrg() and useOrgMembers(); renders org roster + multi-project invite. But project dashboard has no "manage org" nav item (Dashboard.tsx line 179: only "Members" and "Settings" in OverflowMenu).
- **What's wrong**: Org CRUD is production-ready (getOrCreateUserOrg, listOrgMembersWithUsers, listPendingInvitesInOrg in org-permissions.ts) but user never reaches /members unless they navigate manually. MembersPage is the operational PM hub but Dashboard doesn't advertise it for project owners who are also org owners.
- **Suggested fix**: No action needed if /members is intentionally late-feature. Otherwise add "Organization" menu item to Dashboard OverflowMenu linking to /members when session.role >= org_owner.

### F2: Multi-project invites and org membership routed separately
- **Severity**: low
- **Category**: mismatch
- **Evidence**: auth-worker/src/routes/projects.ts (599–805) handles single-project invites. auth-worker/src/routes/invites.ts (72–305) handles multi-project invites with the same token spanning N rows. invites.ts POST /multi and /accept materialize project_members for each project. No frontend UI connects to /api/v2/invites/multi; MultiProjectInviteDialog.tsx exists but not imported in Dashboard (only MembersPage).
- **What's wrong**: Multi-project invite API exists but is only accessible via MembersPage (for org admins). Project owners on Dashboard see only the single-project share flow (ProjectCard). This is correct product design (org-level sharing is org feature) but creates cognitive split.
- **Suggested fix**: Document the invite split clearly in code comments. Consider marking invites.ts POST /multi as "org-admin-only" in the route comment so future dev knows why Dashboard doesn't wire it.

### F3: Project role computed 4× in single GET /api/v2/projects/:projectId
- **Severity**: medium
- **Category**: duplicate
- **Evidence**: auth-worker/src/routes/projects.ts (197–270) list query: CASE statement recomputes MAX(pm.role_level, gg.max_grant, om.role_level, creator_check) with 4× user.id binding for the same user. Single-project GET /:projectId (276–314) calls resolveProjectRoleIncludingArchived(). Every add-member POST checks resolveProjectRole() again. Archive/restore also re-resolve.
- **What's wrong**: Role resolution is correct but happens in the SQL query (for list) and via resolveProjectRole service (for single reads). SQL handles org+group+creator in one pass; the service function doesn't (it only reads project_members + creator check). This inconsistency means group-granted users may see list-only (aggregated) access that single-read won't confirm.
- **Suggested fix**: Consolidate: move the MAX(...) CASE logic into a SQL view or CTE so resolveProjectRole() delegates to the same authoritative query. Document the priority order (override > group > org > creator) in one place.

### F4: members-read.ts is unconnected to org-level member APIs
- **Severity**: low
- **Category**: mismatch
- **Evidence**: src/lib/sync/members-read.ts (44–55) wraps GET /api/v2/projects/:projectId/members as fetchProjectMembers(). MembersPage.tsx uses useOrgMembers() from src/hooks/useOrg instead, which calls auth-worker's org-level members fetch. ProjectCard avatar stack also calls useProjectMembers(). No shared cache or coercion between project and org member lists.
- **What's wrong**: Two parallel member-list surfaces (project effective members vs org members) with no shared abstraction. This is architecturally sound (different queries, different semantics) but means Dashboard + MembersPage are inconsistent if a user is org member but not project member.
- **Suggested fix**: Document in comments that "project members" (from project-members + org_members join) and "org members" are intentionally separate; call out the lack of dedup when rendering both. This is the right design but the implicit assumption needs to be explicit.

### F5: ProjectCreateDialog requires signed-in session but onboarding allows local-only creation
- **Severity**: low
- **Category**: doc-mismatch
- **Evidence**: ProjectCreateDialog.tsx (65–69) rejects with "You need to be signed in." ProjectStep.tsx (49–62) mirrors this but on line 63 it calls createLocalProject() without server row if !session.jwt. This creates a local-only project that Dashboard will render in "Your projects" section but useProject() (server-only per AD-3) will 403 when opened.
- **What's wrong**: Not critical because MembersPage.tsx explicitly checks session before rendering, but a user in onboarding (not signed in) can create a local project that appears valid on dashboard but is broken if they sign in later on another device. The local project won't sync to server.
- **Suggested fix**: Add explicit guard in onboarding ProjectStep: if !session.jwt, show "sign in required" instead of allowing local-only create. Or accept local-only as intentional for offline use and document it clearly in ProjectStep.

### F6: Stale reference to GitLab role source in members API
- **Severity**: low
- **Category**: legacy-v1 | doc-mismatch
- **Evidence**: src/lib/frontier/members.ts (8–19) ProjectMemberRole interface lists source "gitlab" (18) but auth-worker routes never set it. The field exists in the old v1 frontier-server code for legacy GitLab-synced projects. Current auth-worker project-permissions.ts only handles override/org/group/creator.
- **What's wrong**: Dead field in the type definition; not used by any current code path. Will never be returned by auth-worker because GitLab import is v1 only and D1 schema has no gitlab_project_id column in projects table.
- **Suggested fix**: Remove "gitlab" from ProjectMemberRole.source union. If supporting GitLab imports resurfaces, re-add it with an explicit migration. Current codebase is pure D1.

## Open questions
- Does the implicit dependency on getOrCreateUserOrg() during project create (org-permissions.ts:152–161) ever cause user-facing errors if D1 schema is temporarily ahead/behind? The try/catch logs a warning but continues; should this be surfaced to the user?
- Should fetchProjectMembers() (sync-wrapper) and useOrgMembers() (frontier hook) be consolidated into a single abstraction, or is the separation intentional because they have different permission semantics?
- Is the multi-project invite surface (invites.ts) intended as a future org-workspace feature, or should it be removed if orgs never become first-class UI?

## Files reviewed
- src/components/Dashboard.tsx
- src/components/ProjectCreateDialog.tsx
- src/components/onboarding/steps/ProjectStep.tsx
- src/lib/sync/cloud-projects.ts
- src/lib/sync/members-read.ts
- src/lib/sync/project-settings.ts
- src/lib/frontier/members.ts
- src/pages/MembersPage.tsx
- auth-worker/src/routes/projects.ts
- auth-worker/src/routes/orgs.ts
- auth-worker/src/routes/invites.ts
- auth-worker/src/services/org-permissions.ts
- auth-worker/src/services/project-permissions.ts
- sync-worker/src/index.ts
- sync-worker/src/project-archive.ts
