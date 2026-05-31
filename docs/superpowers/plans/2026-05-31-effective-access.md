# Effective-Access + Revoke — Implementation Plan (org-manager-polish #2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]`.

**Goal:** Answer the manager's "why does Alice have edit on Project X?" by enumerating **every** grant path (direct / team-group / org / creator) with each path's role + the resolved max, and let a manager **cleanly revoke the direct grant** with the other paths' blast radius made explicit. This is AD-12's "non-negotiable in v1" effective-access surface (spec `04-features/members-and-sharing.md` lines 40, 123–125).

**Why this scope:** `listEffectiveProjectMembers` already resolves max-wins but returns only the *winning* path (its own comment defers per-path to "Pass C" — this). Revoking the **direct** path is clean + project-scoped (the existing `DELETE /api/v2/projects/:projectId/members/:userId`, maintainer+). The **org / group / creator** paths cannot be revoked per-(member,project) without over-reach (removing from a group strips other projects; removing the org row strips all projects; creator is immovable). So v1 = **full visibility + safe direct-revoke + explicit blast-radius disclosure** for the rest, honoring AD-12's "make residual access visible." Auto-deleting org/group memberships from a "revoke access to this project" button is a footgun we deliberately avoid.

**Architecture:** New read endpoint `GET /api/v2/orgs/:orgId/members/:userId/access` returns the per-project path breakdown over the org's projects where the user has a direct/group/creator path, plus the org-wide baseline role. Client renders it as an expandable per-member panel on the existing org MembersPage. Direct-revoke reuses the existing project-member DELETE.

**Tech Stack:** Hono + D1 (real-D1 vitest-pool-workers); React + RTL.

---

### Task EA1: Backend — effective-access endpoint

**Files:** modify `auth-worker/src/services/org-permissions.ts`, `auth-worker/src/routes/orgs.ts`; test `auth-worker/src/__tests__/org-member-access.test.ts`.

- [ ] **Step 1: failing test** — `auth-worker/src/__tests__/org-member-access.test.ts`:

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

async function seed() {
  await seedUser(1, "wendi")   // org owner / caller
  await seedUser(2, "anna")    // subject
  await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 100, 1)").run() // anna: org viewer (100)
  await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa','John',1,1), ('pb','Mark',1,2)").run() // anna created pb
  await env.AQUILLA_DB.prepare("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 2, 300, 1)").run() // anna: direct reviewer on pa
  await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (5, 1, 'Translators', 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO group_members (group_id, user_id) VALUES (5, 2)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (5, 'pa', 400, 1)").run() // anna: contributor on pa via group
}

describe("GET /api/v2/orgs/:orgId/members/:userId/access", () => {
  it("enumerates every grant path with the resolved max", async () => {
    await seed()
    const res = await app.request("/api/v2/orgs/1/members/2/access", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      orgRole: number | null
      projects: Array<{ projectId: string; direct: number | null; groups: { name: string; roleLevel: number }[]; org: number | null; creator: boolean; resolved: number }>
    }
    expect(body.orgRole).toBe(100)
    const pa = body.projects.find((p) => p.projectId === "pa")!
    expect(pa).toMatchObject({ direct: 300, org: 100, creator: false, resolved: 400 }) // group contributor wins
    expect(pa.groups).toEqual([{ groupId: 5, name: "Translators", roleLevel: 400 }])
    const pb = body.projects.find((p) => p.projectId === "pb")!
    expect(pb).toMatchObject({ direct: null, creator: true, resolved: 700 }) // creator of pb
  })

  it("403s a sub-maintainer caller", async () => {
    await seed()
    await seedUser(9, "tom")
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 9, 400, 1)").run()
    const res = await app.request("/api/v2/orgs/1/members/2/access", { headers: authHeader(await jwtFor("tom")) }, env)
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: run, verify fail** — `cd auth-worker && npx vitest run src/__tests__/org-member-access.test.ts`.

- [ ] **Step 3: service** in `org-permissions.ts`:

```ts
export interface ProjectAccessBreakdown {
  projectId: string
  projectName: string
  direct: number | null
  groups: { groupId: number; name: string; roleLevel: number }[]
  org: number | null
  creator: boolean
  resolved: number
}
export interface MemberEffectiveAccess {
  orgRole: number | null
  projects: ProjectAccessBreakdown[]
}

/**
 * Per-project grant-path breakdown for one org member (AD-12 effective-access).
 * Covers the org's projects where the user has a direct / group / creator path;
 * the org-wide baseline (orgRole) is reported once and folded into each
 * project's resolved max. Read-only debugger surface — "why does X have access?".
 */
export async function getMemberEffectiveAccess(env: Env, orgId: number, userId: number): Promise<MemberEffectiveAccess> {
  const orgRow = await env.AQUILLA_DB.prepare(
    "SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?",
  ).bind(orgId, userId).first<{ role_level: number }>()
  const orgRole = orgRow?.role_level ?? null

  const direct = await env.AQUILLA_DB.prepare(
    `SELECT pm.project_id AS project_id, p.name AS name, pm.role_level AS role_level
       FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE p.org_id = ? AND pm.user_id = ? AND p.archived_at IS NULL`,
  ).bind(orgId, userId).all<{ project_id: string; name: string; role_level: number }>()

  const groups = await env.AQUILLA_DB.prepare(
    `SELECT gpg.project_id AS project_id, p.name AS name, g.id AS group_id, g.name AS group_name, gpg.role_level AS role_level
       FROM group_project_grants gpg
       JOIN groups g        ON g.id = gpg.group_id
       JOIN group_members gm ON gm.group_id = gpg.group_id
       JOIN projects p       ON p.id = gpg.project_id
      WHERE p.org_id = ? AND gm.user_id = ? AND p.archived_at IS NULL`,
  ).bind(orgId, userId).all<{ project_id: string; name: string; group_id: number; group_name: string; role_level: number }>()

  const created = await env.AQUILLA_DB.prepare(
    `SELECT id AS project_id, name FROM projects WHERE org_id = ? AND created_by = ? AND archived_at IS NULL`,
  ).bind(orgId, userId).all<{ project_id: string; name: string }>()

  const map = new Map<string, ProjectAccessBreakdown>()
  const ensure = (projectId: string, name: string): ProjectAccessBreakdown => {
    let row = map.get(projectId)
    if (!row) {
      row = { projectId, projectName: name, direct: null, groups: [], org: orgRole, creator: false, resolved: 0 }
      map.set(projectId, row)
    }
    return row
  }
  for (const r of direct.results ?? []) ensure(r.project_id, r.name).direct = r.role_level
  for (const r of groups.results ?? []) ensure(r.project_id, r.name).groups.push({ groupId: r.group_id, name: r.group_name, roleLevel: r.role_level })
  for (const r of created.results ?? []) ensure(r.project_id, r.name).creator = true

  for (const row of map.values()) {
    const groupMax = row.groups.reduce((m, g) => Math.max(m, g.roleLevel), 0)
    row.resolved = Math.max(row.direct ?? 0, groupMax, row.org ?? 0, row.creator ? 700 : 0)
  }

  const projects = Array.from(map.values()).sort((a, b) => a.projectName.localeCompare(b.projectName))
  return { orgRole, projects }
}
```

- [ ] **Step 4: route** in `orgs.ts` (import `getMemberEffectiveAccess`):

```ts
orgs.get("/:orgId/members/:userId/access", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const targetUserId = parseInt(c.req.param("userId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(targetUserId)) return c.json({ error: "invalid id" }, 400)
  const role = await getOrgMemberRole(c.env, orgId, user.id)
  if (role == null || role < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  const access = await getMemberEffectiveAccess(c.env, orgId, targetUserId)
  return c.json(access)
})
```

- [ ] **Step 5: run PASS** (both cases) + full worker suite — `cd auth-worker && npx vitest run`.
- [ ] **Step 6: commit** — `git add auth-worker/src/services/org-permissions.ts auth-worker/src/routes/orgs.ts auth-worker/src/__tests__/org-member-access.test.ts && git commit -m "feat(auth-worker): per-member effective-access path breakdown endpoint (AD-12)"`

---

### Task EA2: Client — effective-access panel + safe revoke

**Files:** modify `src/lib/frontier/orgs.ts`, `src/pages/MembersPage.tsx`; test (extend `MembersPage.test.tsx` or new `src/components/org/MemberAccessPanel.test.tsx` if extracted).

- [ ] **Step 1:** add to `src/lib/frontier/orgs.ts` (mirror the existing `fetchWithTimeout`/`authHeaders` pattern):

```ts
export interface ProjectAccessBreakdown {
  projectId: string
  projectName: string
  direct: number | null
  groups: { groupId: number; name: string; roleLevel: number }[]
  org: number | null
  creator: boolean
  resolved: number
}
export interface MemberEffectiveAccess { orgRole: number | null; projects: ProjectAccessBreakdown[] }

export async function getMemberAccess(jwt: string, orgId: number, userId: number): Promise<MemberEffectiveAccess> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members/${userId}/access`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`getMemberAccess failed: HTTP ${res.status}`)
  return (await res.json()) as MemberEffectiveAccess
}
```

- [ ] **Step 2:** in `src/pages/MembersPage.tsx`, replace the lazy `ProjectChipsRow` content (which today lists only direct memberships) with a per-project **path breakdown**: when expanded, call `getMemberAccess(jwt, orgId, userId)` and for each project render its paths as labeled chips — `direct: <role>`, `team <name>: <role>`, `org: <role>`, `creator` — plus **resolved: <role>**. Show the org baseline once at the top (`Org role: <role> — applies to all projects`). For each project with a **direct** grant, render a **"Revoke direct grant"** button (maintainer+ only — the page is already admin-gated) that calls `removeProjectMember(jwt, projectId, userId)` (the existing client wrapper for `DELETE /projects/:id/members/:userId`; add it to `src/lib/frontier/members.ts` if absent) then refetches. For group/org/creator paths, render a muted note: `Also via team "X" (manage in Teams) / org role (manage in Members) / project creator` so the residual access + blast radius is explicit (no destructive auto-revoke). Use `roleName` from `@/lib/frontier/roles` for labels.

- [ ] **Step 3: test** — assert: expanding a member fetches access and renders the path chips for a project (direct + team + resolved); a project with a direct grant shows "Revoke direct grant" and clicking it calls `removeProjectMember(jwt, projectId, userId)`; a group-only project shows the team note but no direct-revoke. Mock `getMemberAccess` + `removeProjectMember`.

- [ ] **Step 4:** `npx vitest run src/pages/ src/components/org/` + `npx tsc -b`.
- [ ] **Step 5: commit** — `git add src/lib/frontier/orgs.ts src/lib/frontier/members.ts src/pages/MembersPage.tsx src/pages/MembersPage.test.tsx && git commit -m "feat(members): effective-access path breakdown + safe direct-revoke (AD-12)"`

---

## Self-Review
- Spec coverage: enumerate the 4 paths per (member, project) with resolved max ✓ (AD-12 non-negotiable visibility); safe project-scoped direct-revoke ✓; org/group/creator residual access made explicit with blast-radius notes ✓ (avoids destructive over-reach — documented deliberate scope vs the fuller project-panel revoke-all).
- Types: server `MemberEffectiveAccess`/`ProjectAccessBreakdown` mirrored client-side; `resolved = max(direct, groupMax, org, creator?700)`.
- Reuse: max-wins logic mirrors `listEffectiveProjectMembers`; direct-revoke reuses `DELETE /projects/:projectId/members/:userId` (exists, maintainer+).
- Placeholders: none. Confirm `removeProjectMember` exists in `src/lib/frontier/members.ts` (add a thin wrapper if not). Confirm `groups`/`group_members`/`group_project_grants` column names against migrations before coding the queries.
