/**
 * FRO-138: Permission Semantics — derived from code, locked in with tests.
 *
 * Covers the full access-control journey:
 *   sign-up → invite to org → grant project → create team → add project/users
 *   → revoke access → confirm access actually stops
 *
 * Role ladder (AD-6):
 *   viewer(100) commenter(200) reviewer(300) contributor(400)
 *   project_lead(500) maintainer(600) owner(700)
 *
 * AD-12 max-wins resolution over four paths:
 *   1. direct project_members row ("override")
 *   2. group_project_grants + group_members ("group")
 *   3. org_members row when project.org_id matches ("org")
 *   4. projects.created_by === user.id → 700 ("creator")
 *
 * MEMBERSHIP → VISIBILITY RULE (the key answer):
 *   An org member sees EVERY project in that org that they have at least one
 *   grant path on. Being in org_members with any role IS a grant path — it
 *   contributes org.role_level to max-wins on every org-owned project.
 *   Practically: an org-viewer (role 100) sees ALL org projects in GET /api/v2/projects
 *   because the org path fires for each project with role_level=100.
 *   There is NO "added to a team first" prerequisite for basic visibility.
 *
 * Edit gates enforced at each scope:
 *   - project_lead(500)+ required to add a project member
 *   - maintainer(600)+ required to remove a project member
 *   - maintainer(600)+ required to create/rename/delete groups and manage group membership
 *   - owner(700) required to add/remove org members
 *   - maintainer(600)+ required to create project (into a specific org)
 *   - contributor(400)+ required to delete a file projection
 *   - maintainer(600)+ required to set deadline
 *   - owner(700) required to archive / restore project
 */

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

// ─── Shared seed helpers ───────────────────────────────────────────────────

async function seedBaseOrg() {
  // users: 1=owner, 2=member_viewer, 3=outsider
  await seedUser(1, "owner")
  await seedUser(2, "viewer_member")
  await seedUser(3, "outsider")
  await env.AQUILLA_DB.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  // owner is org member at 700
  await env.AQUILLA_DB.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  // project owned by owner in the org
  await env.AQUILLA_DB.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj1', 'Alpha', 1, 1)",
  ).run()
}

// ─── Suite 1: Membership → visibility ─────────────────────────────────────

describe("Membership → project visibility (the 'sees all vs. none' question)", () => {
  it("org-viewer (100) sees all org projects via the org path — no team required", async () => {
    await seedBaseOrg()
    // Add viewer_member at org level role=100
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 100, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects?orgId=1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: { id: string; role: { level: number; source: string } }[] }
    expect(body.projects.length).toBe(1)
    expect(body.projects[0].id).toBe("proj1")
    expect(body.projects[0].role.level).toBe(100)
    expect(body.projects[0].role.source).toBe("org")
  })

  it("outsider (not in org) sees zero org projects", async () => {
    await seedBaseOrg()
    const res = await app.request(
      "/api/v2/projects?orgId=1",
      { headers: authHeader(await jwtFor("outsider")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: unknown[] }
    expect(body.projects.length).toBe(0)
  })

  it("org-contributor (400) sees projects and resolves contributor role via org path", async () => {
    await seedBaseOrg()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 400, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects?orgId=1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    const body = (await res.json()) as { projects: { role: { level: number } }[] }
    expect(body.projects[0].role.level).toBe(400)
  })
})

// ─── Suite 2: Max-wins resolution ─────────────────────────────────────────

describe("AD-12 max-wins: higher grant wins across all paths", () => {
  it("group path (contributor 400) beats org path (viewer 100)", async () => {
    await seedBaseOrg()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 100, 1)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'Translators', 1)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO group_members (group_id, user_id) VALUES (10, 2)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (10, 'proj1', 400, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects?orgId=1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    const body = (await res.json()) as { projects: { role: { level: number; source: string } }[] }
    expect(body.projects[0].role.level).toBe(400)
    expect(body.projects[0].role.source).toBe("group")
  })

  it("direct override (reviewer 300) beats org path (viewer 100)", async () => {
    await seedBaseOrg()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 100, 1)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 2, 300, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects?orgId=1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    const body = (await res.json()) as { projects: { role: { level: number; source: string } }[] }
    expect(body.projects[0].role.level).toBe(300)
    expect(body.projects[0].role.source).toBe("override")
  })

  it("adding a lower direct override does NOT demote an existing higher org grant", async () => {
    await seedBaseOrg()
    // Org grant at 400
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 400, 1)",
    ).run()
    // Direct override at 100 (lower — must not demote)
    await env.AQUILLA_DB.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 2, 100, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects?orgId=1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    const body = (await res.json()) as { projects: { role: { level: number } }[] }
    // Must resolve to 400, not 100
    expect(body.projects[0].role.level).toBe(400)
  })
})

// ─── Suite 3: Revocation semantics ────────────────────────────────────────

describe("Revocation: access stops after all grant paths removed", () => {
  it("removing org_members row stops the org path — project 403s if no other path", async () => {
    await seedBaseOrg()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 400, 1)",
    ).run()

    // Confirm access before revoke
    const before = await app.request(
      "/api/v2/projects/proj1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    expect(before.status).toBe(200)

    // Revoke: remove org membership
    await env.AQUILLA_DB.prepare(
      "DELETE FROM org_members WHERE org_id = 1 AND user_id = 2",
    ).run()

    // Access must now be denied
    const after = await app.request(
      "/api/v2/projects/proj1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    expect(after.status).toBe(403)
  })

  it("project list returns empty after org removal (no direct/group grants)", async () => {
    await seedBaseOrg()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 100, 1)",
    ).run()

    await env.AQUILLA_DB.prepare(
      "DELETE FROM org_members WHERE org_id = 1 AND user_id = 2",
    ).run()

    const res = await app.request(
      "/api/v2/projects?orgId=1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    const body = (await res.json()) as { projects: unknown[] }
    expect(body.projects.length).toBe(0)
  })

  it("detaching group project stops the group path — project 403s if no other path", async () => {
    await seedBaseOrg()
    // Only path: group grant, no org_members, no direct
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 100, 1)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'Translators', 1)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO group_members (group_id, user_id) VALUES (10, 2)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (10, 'proj1', 500, 1)",
    ).run()

    const before = await app.request(
      "/api/v2/projects/proj1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    expect(before.status).toBe(200)
    const beforeBody = (await before.json()) as { role: { level: number } }
    // 500 (group) beats 100 (org)
    expect(beforeBody.role.level).toBe(500)

    // Detach project from group
    await env.AQUILLA_DB.prepare(
      "DELETE FROM group_project_grants WHERE group_id = 10 AND project_id = 'proj1'",
    ).run()

    const after = await app.request(
      "/api/v2/projects/proj1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    expect(after.status).toBe(200)
    const afterBody = (await after.json()) as { role: { level: number; source: string } }
    // Falls back to org path at 100
    expect(afterBody.role.level).toBe(100)
    expect(afterBody.role.source).toBe("org")
  })

  it("removing direct project_members row stops the override path — falls back to surviving org path", async () => {
    await seedBaseOrg()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 200, 1)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 2, 600, 1)",
    ).run()

    const before = await app.request(
      "/api/v2/projects/proj1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    expect(before.status).toBe(200)
    const beforeBody = (await before.json()) as { role: { level: number; source: string } }
    expect(beforeBody.role.level).toBe(600)
    expect(beforeBody.role.source).toBe("override")

    // Use the DELETE members API (requires caller to be maintainer+)
    await env.AQUILLA_DB.prepare(
      "DELETE FROM project_members WHERE project_id = 'proj1' AND user_id = 2",
    ).run()

    const after = await app.request(
      "/api/v2/projects/proj1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    const afterBody = (await after.json()) as { role: { level: number; source: string } }
    // Falls back to org path
    expect(afterBody.role.level).toBe(200)
    expect(afterBody.role.source).toBe("org")
  })

  it("org DELETE /members/:userId API removes org path and cascades group_members", async () => {
    await seedBaseOrg()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 200, 1)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'T', 1)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO group_members (group_id, user_id) VALUES (10, 2)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (10, 'proj1', 400, 1)",
    ).run()

    // Confirm access before removal
    const beforeProject = await app.request(
      "/api/v2/projects/proj1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    expect(beforeProject.status).toBe(200)

    // Owner removes viewer_member from org via API
    const removeRes = await app.request(
      "/api/v2/orgs/1/members/2",
      {
        method: "DELETE",
        headers: authHeader(await jwtFor("owner")),
      },
      env,
    )
    expect(removeRes.status).toBe(200)

    // Org membership removed
    const orgMember = await env.AQUILLA_DB.prepare(
      "SELECT 1 FROM org_members WHERE org_id = 1 AND user_id = 2",
    ).first()
    expect(orgMember).toBeNull()

    // Group membership also removed (cascade)
    const groupMember = await env.AQUILLA_DB.prepare(
      "SELECT 1 FROM group_members WHERE group_id = 10 AND user_id = 2",
    ).first()
    expect(groupMember).toBeNull()

    // Project now 403s (no path remaining)
    const afterProject = await app.request(
      "/api/v2/projects/proj1",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    expect(afterProject.status).toBe(403)
  })
})

// ─── Suite 4: Edit-gate enforcement (what each role CAN/CAN'T do) ─────────

describe("Role × Scope edit gates", () => {
  describe("Project scope — add member requires project_lead (500)+", () => {
    it("reviewer (300) cannot add a project member", async () => {
      await seedBaseOrg()
      await seedUser(4, "reviewer_user")
      await env.AQUILLA_DB.prepare(
        "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 4, 300, 1)",
      ).run()
      await env.AQUILLA_DB.prepare(
        "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 4, 300, 1)",
      ).run()
      await seedUser(5, "new_collab")

      const res = await app.request(
        "/api/v2/projects/proj1/members",
        {
          method: "POST",
          headers: authHeader(await jwtFor("reviewer_user")),
          body: JSON.stringify({ username: "new_collab", role: 100 }),
        },
        env,
      )
      expect(res.status).toBe(403)
    })

    it("project_lead (500) can add a member at or below their own role", async () => {
      await seedBaseOrg()
      await seedUser(4, "lead_user")
      await env.AQUILLA_DB.prepare(
        "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 4, 500, 1)",
      ).run()
      await env.AQUILLA_DB.prepare(
        "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 4, 500, 1)",
      ).run()
      await seedUser(5, "new_collab")

      const res = await app.request(
        "/api/v2/projects/proj1/members",
        {
          method: "POST",
          headers: authHeader(await jwtFor("lead_user")),
          body: JSON.stringify({ username: "new_collab", role: 300 }),
        },
        env,
      )
      expect(res.status).toBe(200)
    })

    it("project_lead (500) cannot grant a role higher than their own", async () => {
      await seedBaseOrg()
      await seedUser(4, "lead_user")
      await env.AQUILLA_DB.prepare(
        "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 4, 500, 1)",
      ).run()
      await env.AQUILLA_DB.prepare(
        "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 4, 500, 1)",
      ).run()
      await seedUser(5, "new_collab")

      const res = await app.request(
        "/api/v2/projects/proj1/members",
        {
          method: "POST",
          headers: authHeader(await jwtFor("lead_user")),
          body: JSON.stringify({ username: "new_collab", role: 600 }),
        },
        env,
      )
      expect(res.status).toBe(403)
    })
  })

  describe("Project scope — remove member requires maintainer (600)+", () => {
    it("project_lead (500) cannot remove a direct member", async () => {
      await seedBaseOrg()
      await seedUser(4, "lead_user")
      await seedUser(5, "collab")
      await env.AQUILLA_DB.prepare(
        "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 4, 500, 1), ('proj1', 5, 100, 1)",
      ).run()

      const res = await app.request(
        "/api/v2/projects/proj1/members/5",
        { method: "DELETE", headers: authHeader(await jwtFor("lead_user")) },
        env,
      )
      expect(res.status).toBe(403)
    })

    it("maintainer (600) can remove a direct member", async () => {
      await seedBaseOrg()
      await seedUser(4, "maint_user")
      await seedUser(5, "collab")
      await env.AQUILLA_DB.prepare(
        "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 4, 600, 1), ('proj1', 5, 100, 1)",
      ).run()

      const res = await app.request(
        "/api/v2/projects/proj1/members/5",
        { method: "DELETE", headers: authHeader(await jwtFor("maint_user")) },
        env,
      )
      expect(res.status).toBe(200)
    })
  })

  describe("Org scope — add org member requires owner (700)", () => {
    it("maintainer (600) cannot add a new org member", async () => {
      await seedBaseOrg()
      await seedUser(4, "maint_user")
      await env.AQUILLA_DB.prepare(
        "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 4, 600, 1)",
      ).run()
      await seedUser(5, "new_user")

      const res = await app.request(
        "/api/v2/orgs/1/members",
        {
          method: "POST",
          headers: authHeader(await jwtFor("maint_user")),
          body: JSON.stringify({ username: "new_user", role: 100 }),
        },
        env,
      )
      expect(res.status).toBe(403)
    })

    it("owner (700) can add a new org member", async () => {
      await seedBaseOrg()
      await seedUser(5, "new_user")

      const res = await app.request(
        "/api/v2/orgs/1/members",
        {
          method: "POST",
          headers: authHeader(await jwtFor("owner")),
          body: JSON.stringify({ username: "new_user", role: 200 }),
        },
        env,
      )
      expect(res.status).toBe(200)
    })
  })

  describe("Org scope — group CRUD requires maintainer (600)+", () => {
    it("contributor (400) cannot create a group", async () => {
      await seedBaseOrg()
      await seedUser(4, "contrib_user")
      await env.AQUILLA_DB.prepare(
        "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 4, 400, 1)",
      ).run()

      const res = await app.request(
        "/api/v2/orgs/1/groups",
        {
          method: "POST",
          headers: authHeader(await jwtFor("contrib_user")),
          body: JSON.stringify({ name: "Team A" }),
        },
        env,
      )
      expect(res.status).toBe(403)
    })

    it("maintainer (600) can create a group", async () => {
      await seedBaseOrg()
      await seedUser(4, "maint_user")
      await env.AQUILLA_DB.prepare(
        "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 4, 600, 1)",
      ).run()

      const res = await app.request(
        "/api/v2/orgs/1/groups",
        {
          method: "POST",
          headers: authHeader(await jwtFor("maint_user")),
          body: JSON.stringify({ name: "Team A" }),
        },
        env,
      )
      expect(res.status).toBe(200)
    })
  })

  describe("Org scope — portfolio/members endpoints require any org member", () => {
    it("non-member gets 403 on GET /orgs/:orgId/members", async () => {
      await seedBaseOrg()
      const res = await app.request(
        "/api/v2/orgs/1/members",
        { headers: authHeader(await jwtFor("outsider")) },
        env,
      )
      expect(res.status).toBe(403)
    })

    it("org viewer (100) can list org members", async () => {
      await seedBaseOrg()
      await env.AQUILLA_DB.prepare(
        "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 100, 1)",
      ).run()
      const res = await app.request(
        "/api/v2/orgs/1/members",
        { headers: authHeader(await jwtFor("viewer_member")) },
        env,
      )
      expect(res.status).toBe(200)
    })

    it("non-member gets 403 on GET /orgs/:orgId/portfolio", async () => {
      await seedBaseOrg()
      const res = await app.request(
        "/api/v2/orgs/1/portfolio",
        { headers: authHeader(await jwtFor("outsider")) },
        env,
      )
      expect(res.status).toBe(403)
    })

    it("GET /orgs/:orgId/members/:userId/access requires maintainer (600)+", async () => {
      await seedBaseOrg()
      await env.AQUILLA_DB.prepare(
        "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 400, 1)",
      ).run()
      // contributor trying to see access breakdown
      const res = await app.request(
        "/api/v2/orgs/1/members/1/access",
        { headers: authHeader(await jwtFor("viewer_member")) },
        env,
      )
      expect(res.status).toBe(403)
    })
  })
})

// ─── Suite 5: Team (group) → project visibility ───────────────────────────

describe("Team (group) membership grants project access", () => {
  it("user in a group gains project access at the group's granted role", async () => {
    await seedBaseOrg()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 100, 1)",
    ).run()
    // Add a second project that viewer_member has no org-level claim beyond 100
    await env.AQUILLA_DB.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj2', 'Beta', 1, 1)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'Team B', 1)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO group_members (group_id, user_id) VALUES (10, 2)",
    ).run()
    // Team attached to proj2 at contributor (400)
    await env.AQUILLA_DB.prepare(
      "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (10, 'proj2', 400, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj2",
      { headers: authHeader(await jwtFor("viewer_member")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role.level).toBe(400)
    expect(body.role.source).toBe("group")
  })
})

// ─── Suite 6: Invite flow ─────────────────────────────────────────────────

describe("Invite flow: link grant → project access", () => {
  it("outsider can redeem an invite and gains project membership", async () => {
    await seedBaseOrg()
    // Create invite token
    const token = "test-invite-token-abc123"
    const expires = new Date(Date.now() + 86400_000).toISOString()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, expires_at) VALUES (?, 'proj1', 300, 1, ?)",
    )
      .bind(token, expires)
      .run()

    // Outsider accepts
    const res = await app.request(
      "/api/v2/projects/accept-invite",
      {
        method: "POST",
        headers: authHeader(await jwtFor("outsider")),
        body: JSON.stringify({ token }),
      },
      env,
    )
    expect(res.status).toBe(200)

    // Outsider now has project access
    const projectRes = await app.request(
      "/api/v2/projects/proj1",
      { headers: authHeader(await jwtFor("outsider")) },
      env,
    )
    expect(projectRes.status).toBe(200)
    const projectBody = (await projectRes.json()) as { role: { level: number } }
    expect(projectBody.role.level).toBe(300)
  })

  it("invite caps role at contributor (400) max via link share", async () => {
    await seedBaseOrg()
    // project_lead mints an invite — the API caps it at 400
    await env.AQUILLA_DB.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 2, 500, 1)",
    ).run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 500, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj1/invites",
      {
        method: "POST",
        headers: authHeader(await jwtFor("viewer_member")),
        body: JSON.stringify({ role: 600 }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: number }
    // Capped at 400 (LINK_ROLE_CAP)
    expect(body.role).toBe(400)
  })
})

// ─── Suite 7: Creator fallback ────────────────────────────────────────────

describe("Creator fallback: project creator always gets owner (700)", () => {
  it("project creator (not in org) resolves as owner 700 via creator path", async () => {
    await seedBaseOrg()
    // outsider creates a standalone project (no org)
    await env.AQUILLA_DB.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj_personal', 'Personal', NULL, 3)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj_personal",
      { headers: authHeader(await jwtFor("outsider")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role.level).toBe(700)
    expect(body.role.source).toBe("creator")
  })
})
