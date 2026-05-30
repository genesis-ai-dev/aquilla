# Teams Lifecycle — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `auth-worker` write endpoints for team (group) lifecycle: create/rename/delete teams, add/remove members, attach/detach projects at a role — plus fix the org-member-remove route to cascade into `group_members`.

**Architecture:** Eight new routes on the existing orgs router (`auth-worker/src/routes/orgs.ts`), each gated on `getOrgMemberRole ≥ ROLE.MAINTAINER (600)`, backed by small single-statement service helpers in `auth-worker/src/services/org-permissions.ts`. No schema changes — [migration 0007](../../auth-worker/migrations/0007_ad12_groups.sql) already defines `groups`/`group_members`/`group_project_grants`. Tests run against real D1 via the existing `@cloudflare/vitest-pool-workers` harness.

**Tech Stack:** TypeScript, Hono, Cloudflare D1, Vitest (real-D1 pool). Reuses `getOrgMemberRole`, `ROLE`, `ROLE_NAMES`, `isCanonicalRoleLevel`, `lookupUserByUsername`, and the `seedUser`/`jwtFor`/`authHeader` test helpers — all already present.

**Spec:** [docs/superpowers/specs/2026-05-30-teams-lifecycle-management-design.md](../specs/2026-05-30-teams-lifecycle-management-design.md). Client plan is a separate document.

---

## File Structure

- `auth-worker/src/services/org-permissions.ts` — **modify**: add `createGroup`, `updateGroup`, `deleteGroup`, `addGroupMember`, `removeGroupMember`, `attachGroupProject`, `updateGroupProjectRole`, `detachGroupProject`, plus a `groupExistsInOrg` guard helper.
- `auth-worker/src/routes/orgs.ts` — **modify**: add the 8 routes; patch the existing `DELETE /:orgId/members/:userId` for the cascade.
- `auth-worker/src/__tests__/groups-write.test.ts` — **new**: all endpoint tests.
- `auth-worker/src/__tests__/org-member-remove-cascade.test.ts` — **new**: the cascade fix test.

Run worker tests from the worker dir: `cd auth-worker && npx vitest run <path>`. All routes are gated `org role ≥ 600`; use this guard shape (matching the existing `POST /:orgId/members`):

```ts
const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
if (callerRole == null || callerRole < ROLE.MAINTAINER) {
  return c.json({ error: "org role >= maintainer required" }, 403)
}
```

`ROLE` is exported from `../types`; `getOrgMemberRole` from `../services/org-permissions`; add `ROLE` to the route file's imports if not present.

---

### Task 1: Group CRUD (create / rename / delete)

**Files:**
- Modify: `auth-worker/src/services/org-permissions.ts`
- Modify: `auth-worker/src/routes/orgs.ts`
- Test: `auth-worker/src/__tests__/groups-write.test.ts`

- [ ] **Step 1: Write the failing test** — create `auth-worker/src/__tests__/groups-write.test.ts`:

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

async function seedOrg() {
  await seedUser(1, "wendi")  // owner
  await seedUser(2, "tom")    // contributor (org role 400 — below gate)
  await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)").run()
}

describe("group CRUD", () => {
  it("creates a team (admin) and rejects duplicate names", async () => {
    await seedOrg()
    const res = await app.request("/api/v2/orgs/1/groups", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "West Africa", description: "WA leads" }) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; name: string; description: string | null }
    expect(body).toMatchObject({ name: "West Africa", description: "WA leads" })
    const dup = await app.request("/api/v2/orgs/1/groups", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "West Africa" }) }, env)
    expect(dup.status).toBe(409)
  })

  it("rejects a non-admin (org role < maintainer) with 403", async () => {
    await seedOrg()
    const res = await app.request("/api/v2/orgs/1/groups", { method: "POST", headers: authHeader(await jwtFor("tom")), body: JSON.stringify({ name: "X" }) }, env)
    expect(res.status).toBe(403)
  })

  it("renames a team and deletes it (cascading members + grants)", async () => {
    await seedOrg()
    await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'Old', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO group_members (group_id, user_id, added_by) VALUES (10, 1, 1)").run()
    const patch = await app.request("/api/v2/orgs/1/groups/10", { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "New", description: "d" }) }, env)
    expect(patch.status).toBe(200)
    const renamed = await env.AQUILLA_DB.prepare("SELECT name FROM groups WHERE id = 10").first<{ name: string }>()
    expect(renamed?.name).toBe("New")
    const del = await app.request("/api/v2/orgs/1/groups/10", { method: "DELETE", headers: authHeader(await jwtFor("wendi")) }, env)
    expect(del.status).toBe(200)
    const gone = await env.AQUILLA_DB.prepare("SELECT id FROM groups WHERE id = 10").first()
    expect(gone).toBeNull()
    const members = await env.AQUILLA_DB.prepare("SELECT group_id FROM group_members WHERE group_id = 10").all()
    expect(members.results).toHaveLength(0) // FK cascade
  })

  it("404s renaming a group from another org", async () => {
    await seedOrg()
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'Other', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (20, 2, 'Foreign', 1)").run()
    const res = await app.request("/api/v2/orgs/1/groups/20", { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "Hijack" }) }, env)
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run, verify fail** — `cd auth-worker && npx vitest run src/__tests__/groups-write.test.ts` → FAIL (routes 404).

- [ ] **Step 3: Add the service helpers** in `auth-worker/src/services/org-permissions.ts`:

```ts
/** True if a group with this id exists in this org. */
export async function groupExistsInOrg(env: Env, orgId: number, groupId: number): Promise<boolean> {
  const row = await env.AQUILLA_DB.prepare(
    "SELECT 1 AS ok FROM groups WHERE id = ? AND org_id = ?",
  ).bind(groupId, orgId).first<{ ok: number }>()
  return row != null
}

export interface GroupRow { id: number; name: string; description: string | null }

/** Create a group. Returns null if the name already exists in the org. */
export async function createGroup(env: Env, orgId: number, name: string, description: string | null, createdBy: number): Promise<GroupRow | null> {
  const existing = await env.AQUILLA_DB.prepare(
    "SELECT id FROM groups WHERE org_id = ? AND name = ?",
  ).bind(orgId, name).first<{ id: number }>()
  if (existing) return null
  const row = await env.AQUILLA_DB.prepare(
    "INSERT INTO groups (org_id, name, description, created_by) VALUES (?, ?, ?, ?) RETURNING id, name, description",
  ).bind(orgId, name, description, createdBy).first<GroupRow>()
  return row
}

/** Update name/description. Returns null on duplicate-name conflict. */
export async function updateGroup(env: Env, orgId: number, groupId: number, name: string | undefined, description: string | undefined): Promise<GroupRow | null> {
  if (name != null) {
    const clash = await env.AQUILLA_DB.prepare(
      "SELECT id FROM groups WHERE org_id = ? AND name = ? AND id != ?",
    ).bind(orgId, name, groupId).first<{ id: number }>()
    if (clash) return null
  }
  await env.AQUILLA_DB.prepare(
    `UPDATE groups SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND org_id = ?`,
  ).bind(name ?? null, description ?? null, groupId, orgId).run()
  return env.AQUILLA_DB.prepare(
    "SELECT id, name, description FROM groups WHERE id = ?",
  ).bind(groupId).first<GroupRow>()
}

/** Delete a group (FK cascades members + grants). */
export async function deleteGroup(env: Env, orgId: number, groupId: number): Promise<void> {
  await env.AQUILLA_DB.prepare("DELETE FROM groups WHERE id = ? AND org_id = ?").bind(groupId, orgId).run()
}
```

- [ ] **Step 4: Add the routes** in `auth-worker/src/routes/orgs.ts`. Ensure imports include `createGroup, updateGroup, deleteGroup, groupExistsInOrg` (from the service) and `ROLE` (from `../types`). Add after the existing `GET /:orgId/groups/:groupId` route:

```ts
const groupBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
})

orgs.post("/:orgId/groups", zValidator("json", groupBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  const { name, description } = c.req.valid("json")
  const group = await createGroup(c.env, orgId, name, description ?? null, user.id)
  if (!group) return c.json({ error: "a team with that name already exists" }, 409)
  return c.json(group)
})

const groupPatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
})

orgs.patch("/:orgId/groups/:groupId", zValidator("json", groupPatchBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  const { name, description } = c.req.valid("json")
  const updated = await updateGroup(c.env, orgId, groupId, name, description)
  if (!updated) return c.json({ error: "a team with that name already exists" }, 409)
  return c.json(updated)
})

orgs.delete("/:orgId/groups/:groupId", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  await deleteGroup(c.env, orgId, groupId)
  return c.json({ removed: true })
})
```

(`z` and `zValidator` are already imported in `orgs.ts`.)

- [ ] **Step 5: Run, verify PASS** — `cd auth-worker && npx vitest run src/__tests__/groups-write.test.ts` (the 4 group-CRUD cases).

- [ ] **Step 6: Commit**

```bash
git add auth-worker/src/services/org-permissions.ts auth-worker/src/routes/orgs.ts auth-worker/src/__tests__/groups-write.test.ts
git commit -m "feat(auth-worker): team (group) create/rename/delete endpoints"
```

---

### Task 2: Team membership (add / remove)

**Files:**
- Modify: `auth-worker/src/services/org-permissions.ts`, `auth-worker/src/routes/orgs.ts`
- Test: append to `auth-worker/src/__tests__/groups-write.test.ts`

- [ ] **Step 1: Write the failing test** — append to `groups-write.test.ts`:

```ts
describe("team membership", () => {
  async function seedTeam() {
    await seedUser(1, "wendi")
    await seedUser(2, "anna")    // org member
    await seedUser(9, "outsider") // NOT an org member
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 100, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'WA', 1)").run()
  }

  it("adds an org member to a team", async () => {
    await seedTeam()
    const res = await app.request("/api/v2/orgs/1/groups/10/members", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ username: "anna" }) }, env)
    expect(res.status).toBe(200)
    const row = await env.AQUILLA_DB.prepare("SELECT user_id FROM group_members WHERE group_id = 10 AND user_id = 2").first()
    expect(row).not.toBeNull()
  })

  it("rejects adding a non-org-member with 409", async () => {
    await seedTeam()
    const res = await app.request("/api/v2/orgs/1/groups/10/members", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ username: "outsider" }) }, env)
    expect(res.status).toBe(409)
  })

  it("removes a member", async () => {
    await seedTeam()
    await env.AQUILLA_DB.prepare("INSERT INTO group_members (group_id, user_id, added_by) VALUES (10, 2, 1)").run()
    const res = await app.request("/api/v2/orgs/1/groups/10/members/2", { method: "DELETE", headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const gone = await env.AQUILLA_DB.prepare("SELECT user_id FROM group_members WHERE group_id = 10 AND user_id = 2").first()
    expect(gone).toBeNull()
  })
})
```

- [ ] **Step 2: Run, verify fail** — `cd auth-worker && npx vitest run src/__tests__/groups-write.test.ts` (the 3 new cases fail).

- [ ] **Step 3: Add service helpers** in `org-permissions.ts`:

```ts
/** Add an org member to a group. Returns "not-org-member" if the target isn't in the org. */
export async function addGroupMember(env: Env, orgId: number, groupId: number, targetUserId: number, addedBy: number): Promise<"ok" | "not-org-member"> {
  const orgRole = await getOrgMemberRole(env, orgId, targetUserId)
  if (orgRole == null) return "not-org-member"
  await env.AQUILLA_DB.prepare(
    "INSERT INTO group_members (group_id, user_id, added_by) VALUES (?, ?, ?) ON CONFLICT(group_id, user_id) DO NOTHING",
  ).bind(groupId, targetUserId, addedBy).run()
  return "ok"
}

export async function removeGroupMember(env: Env, groupId: number, userId: number): Promise<void> {
  await env.AQUILLA_DB.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").bind(groupId, userId).run()
}
```

- [ ] **Step 4: Add routes** in `orgs.ts` (import `addGroupMember, removeGroupMember`, and `lookupUserByUsername` if not already imported — it is used elsewhere in this file). After the group-CRUD routes:

```ts
const memberBody = z.object({ username: z.string().min(1) })

orgs.post("/:orgId/groups/:groupId/members", zValidator("json", memberBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  const { username } = c.req.valid("json")
  const target = await lookupUserByUsername(c.env, username)
  if (!target) return c.json({ error: "user not found" }, 404)
  const result = await addGroupMember(c.env, orgId, groupId, target.id, user.id)
  if (result === "not-org-member") return c.json({ error: "user is not a member of this org" }, 409)
  return c.json({ userId: target.id, username: target.username })
})

orgs.delete("/:orgId/groups/:groupId/members/:userId", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  const targetUserId = parseInt(c.req.param("userId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId) || !Number.isFinite(targetUserId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  await removeGroupMember(c.env, groupId, targetUserId)
  return c.json({ removed: true })
})
```

- [ ] **Step 5: Run, verify PASS** — `cd auth-worker && npx vitest run src/__tests__/groups-write.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add auth-worker/src/services/org-permissions.ts auth-worker/src/routes/orgs.ts auth-worker/src/__tests__/groups-write.test.ts
git commit -m "feat(auth-worker): team membership add/remove endpoints"
```

---

### Task 3: Project attachment (attach / change-role / detach)

**Files:**
- Modify: `auth-worker/src/services/org-permissions.ts`, `auth-worker/src/routes/orgs.ts`
- Test: append to `auth-worker/src/__tests__/groups-write.test.ts`

- [ ] **Step 1: Write the failing test** — append to `groups-write.test.ts`:

```ts
describe("team project attachment", () => {
  async function seedTeamProjects() {
    await seedUser(1, "wendi") // org owner (700)
    await seedUser(2, "anna")  // org maintainer (600)
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1), (2, 'Other', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'WA', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Bambara', 1, 1), ('pb', 'Foreign', 2, 1)").run()
  }

  it("attaches an org project at a role, then changes + detaches it", async () => {
    await seedTeamProjects()
    const attach = await app.request("/api/v2/orgs/1/groups/10/projects", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ projectId: "pa", roleLevel: 400 }) }, env)
    expect(attach.status).toBe(200)
    let row = await env.AQUILLA_DB.prepare("SELECT role_level FROM group_project_grants WHERE group_id = 10 AND project_id = 'pa'").first<{ role_level: number }>()
    expect(row?.role_level).toBe(400)
    const patch = await app.request("/api/v2/orgs/1/groups/10/projects/pa", { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ roleLevel: 300 }) }, env)
    expect(patch.status).toBe(200)
    row = await env.AQUILLA_DB.prepare("SELECT role_level FROM group_project_grants WHERE group_id = 10 AND project_id = 'pa'").first<{ role_level: number }>()
    expect(row?.role_level).toBe(300)
    const det = await app.request("/api/v2/orgs/1/groups/10/projects/pa", { method: "DELETE", headers: authHeader(await jwtFor("wendi")) }, env)
    expect(det.status).toBe(200)
    const gone = await env.AQUILLA_DB.prepare("SELECT project_id FROM group_project_grants WHERE group_id = 10 AND project_id = 'pa'").first()
    expect(gone).toBeNull()
  })

  it("rejects attaching a project from another org with 409", async () => {
    await seedTeamProjects()
    const res = await app.request("/api/v2/orgs/1/groups/10/projects", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ projectId: "pb", roleLevel: 400 }) }, env)
    expect(res.status).toBe(409)
  })

  it("rejects granting above the caller's own org role with 403", async () => {
    await seedTeamProjects()
    // anna is org maintainer (600); granting owner (700) exceeds her level.
    const res = await app.request("/api/v2/orgs/1/groups/10/projects", { method: "POST", headers: authHeader(await jwtFor("anna")), body: JSON.stringify({ projectId: "pa", roleLevel: 700 }) }, env)
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run, verify fail** — `cd auth-worker && npx vitest run src/__tests__/groups-write.test.ts`.

- [ ] **Step 3: Add service helpers** in `org-permissions.ts`:

```ts
/** Attach (or re-grant) a project to a group. Returns "cross-org" if the project isn't in this org. */
export async function attachGroupProject(env: Env, orgId: number, groupId: number, projectId: string, roleLevel: number, grantedBy: number): Promise<"ok" | "cross-org" | "no-project"> {
  const proj = await env.AQUILLA_DB.prepare("SELECT org_id FROM projects WHERE id = ?").bind(projectId).first<{ org_id: number | null }>()
  if (!proj) return "no-project"
  if (proj.org_id !== orgId) return "cross-org"
  await env.AQUILLA_DB.prepare(
    `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(group_id, project_id) DO UPDATE SET role_level = excluded.role_level, granted_by = excluded.granted_by`,
  ).bind(groupId, projectId, roleLevel, grantedBy).run()
  return "ok"
}

/** Change the granted role for an existing attachment. Returns false if no attachment. */
export async function updateGroupProjectRole(env: Env, groupId: number, projectId: string, roleLevel: number): Promise<boolean> {
  const existing = await env.AQUILLA_DB.prepare(
    "SELECT role_level FROM group_project_grants WHERE group_id = ? AND project_id = ?",
  ).bind(groupId, projectId).first()
  if (!existing) return false
  await env.AQUILLA_DB.prepare(
    "UPDATE group_project_grants SET role_level = ? WHERE group_id = ? AND project_id = ?",
  ).bind(roleLevel, groupId, projectId).run()
  return true
}

export async function detachGroupProject(env: Env, groupId: number, projectId: string): Promise<void> {
  await env.AQUILLA_DB.prepare("DELETE FROM group_project_grants WHERE group_id = ? AND project_id = ?").bind(groupId, projectId).run()
}
```

- [ ] **Step 4: Add routes** in `orgs.ts` (import `attachGroupProject, updateGroupProjectRole, detachGroupProject`, and `isCanonicalRoleLevel` from `../services/project-permissions`). After the membership routes:

```ts
const attachBody = z.object({ projectId: z.string().min(1), roleLevel: z.number().int() })
const roleBody = z.object({ roleLevel: z.number().int() })

orgs.post("/:orgId/groups/:groupId/projects", zValidator("json", attachBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  const { projectId, roleLevel } = c.req.valid("json")
  if (!isCanonicalRoleLevel(roleLevel) || roleLevel > callerRole) return c.json({ error: "invalid or too-high role level" }, 403)
  const result = await attachGroupProject(c.env, orgId, groupId, projectId, roleLevel, user.id)
  if (result === "no-project") return c.json({ error: "project not found" }, 404)
  if (result === "cross-org") return c.json({ error: "project is not in this org" }, 409)
  return c.json({ projectId, roleLevel })
})

orgs.patch("/:orgId/groups/:groupId/projects/:projectId", zValidator("json", roleBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  const projectId = c.req.param("projectId")
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  const { roleLevel } = c.req.valid("json")
  if (!isCanonicalRoleLevel(roleLevel) || roleLevel > callerRole) return c.json({ error: "invalid or too-high role level" }, 403)
  const ok = await updateGroupProjectRole(c.env, groupId, projectId, roleLevel)
  if (!ok) return c.json({ error: "attachment not found" }, 404)
  return c.json({ projectId, roleLevel })
})

orgs.delete("/:orgId/groups/:groupId/projects/:projectId", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  const projectId = c.req.param("projectId")
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  await detachGroupProject(c.env, groupId, projectId)
  return c.json({ removed: true })
})
```

- [ ] **Step 5: Run, verify PASS** — `cd auth-worker && npx vitest run src/__tests__/groups-write.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add auth-worker/src/services/org-permissions.ts auth-worker/src/routes/orgs.ts auth-worker/src/__tests__/groups-write.test.ts
git commit -m "feat(auth-worker): team project attach/change-role/detach endpoints"
```

---

### Task 4: Cascade group_members on org-member removal

**Files:**
- Modify: `auth-worker/src/routes/orgs.ts` (the existing `DELETE /:orgId/members/:userId` handler)
- Test: `auth-worker/src/__tests__/org-member-remove-cascade.test.ts`

- [ ] **Step 1: Write the failing test** — create `auth-worker/src/__tests__/org-member-remove-cascade.test.ts`:

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

describe("org member removal cascades to group_members", () => {
  it("removes the user's team memberships in the org", async () => {
    await seedUser(1, "wendi") // owner
    await seedUser(2, "anna")  // member, on a team
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'WA', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO group_members (group_id, user_id, added_by) VALUES (10, 2, 1)").run()

    const res = await app.request("/api/v2/orgs/1/members/2", { method: "DELETE", headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)

    const orgMember = await env.AQUILLA_DB.prepare("SELECT user_id FROM org_members WHERE org_id = 1 AND user_id = 2").first()
    expect(orgMember).toBeNull()
    const groupMember = await env.AQUILLA_DB.prepare("SELECT user_id FROM group_members WHERE group_id = 10 AND user_id = 2").first()
    expect(groupMember).toBeNull() // cascaded
  })
})
```

- [ ] **Step 2: Run, verify fail** — `cd auth-worker && npx vitest run src/__tests__/org-member-remove-cascade.test.ts` → FAIL (group_members row still present).

- [ ] **Step 3: Patch the handler** — in `auth-worker/src/routes/orgs.ts`, find the `orgs.delete("/:orgId/members/:userId", …)` handler. After the existing `DELETE FROM org_members WHERE org_id = ? AND user_id = ?` statement runs, add a second statement before returning:

```ts
  await c.env.AQUILLA_DB.prepare(
    `DELETE FROM group_members
       WHERE user_id = ?
         AND group_id IN (SELECT id FROM groups WHERE org_id = ?)`,
  ).bind(targetUserId, orgId).run()
```

(Use the handler's existing `targetUserId` and `orgId` locals — match their names if they differ.)

- [ ] **Step 4: Run, verify PASS** — `cd auth-worker && npx vitest run src/__tests__/org-member-remove-cascade.test.ts`.

- [ ] **Step 5: Full suite + commit**

Run: `cd auth-worker && npx vitest run` — all tests pass (Phase 1 + the new Teams suites), no regressions.

```bash
git add auth-worker/src/routes/orgs.ts auth-worker/src/__tests__/org-member-remove-cascade.test.ts
git commit -m "fix(auth-worker): cascade group_members on org-member removal"
```

---

## Self-Review

- **Spec coverage:** create/rename/delete (Task 1) ✓; add/remove members with org-member invariant (Task 2) ✓; attach/change-role/detach with cross-org + role-cap invariants (Task 3) ✓; member-remove cascade (Task 4) ✓. All gated org ≥ maintainer ✓. Role cap = `roleLevel > callerRole → 403` ✓. Response shapes match the spec.
- **Type consistency:** service helpers (`createGroup`/`updateGroup`/`deleteGroup`/`groupExistsInOrg`/`addGroupMember`/`removeGroupMember`/`attachGroupProject`/`updateGroupProjectRole`/`detachGroupProject`) are defined in the task that first uses them and consumed by that task's routes. `ROLE.MAINTAINER`, `isCanonicalRoleLevel`, `lookupUserByUsername`, `getOrgMemberRole` are all pre-existing imports.
- **Placeholder scan:** none — every step has runnable code/commands. Note for the implementer: confirm the existing `DELETE /:orgId/members/:userId` handler's local variable names (Task 4 Step 3) and the exact import lines before editing.

## Execution Handoff

Client plan (the management UI on the Phase 1 Teams surfaces) is a separate document, written after this backend lands.
