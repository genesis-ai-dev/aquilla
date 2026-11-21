// AQU-1993: a member can leave an organization, and a member can leave a
// project they were individually added to.
//
// Before this there was no route for either. The owner-only
// DELETE /orgs/:orgId/members/:userId explicitly refused self-removal
// ("owner cannot remove self"), and DELETE /projects/:projectId/members/
// :userId both parsed "me" as NaN and required maintainer+ — so the invited
// contributor who wanted out was the one person who could not act.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

/** Team org 1 "Guild": user 1 owner, user 2 contributor on team 10. */
async function seedOrg(): Promise<void> {
  await seedUser(1, "olive") // owner
  await seedUser(2, "cass") // contributor
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (1, 'Guild', 1, 'team')",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'Reviewers', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO group_members (group_id, user_id, added_by) VALUES (10, 2, 1)",
  ).run()
}

describe("AQU-1993 DELETE /api/v2/orgs/:orgId/members/me", () => {
  it("lets a member leave, cascading their team rows in that org", async () => {
    await seedOrg()

    const res = await app.request(
      "/api/v2/orgs/1/members/me",
      { method: "DELETE", headers: authHeader(await jwtFor("cass")) },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ left: true })

    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT user_id FROM org_members WHERE org_id = 1 AND user_id = 2",
      ).first(),
    ).toBeNull()
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT user_id FROM group_members WHERE group_id = 10 AND user_id = 2",
      ).first(),
    ).toBeNull()
  })

  it("refuses the last owner, so the org cannot be left unadministered", async () => {
    await seedOrg()

    const res = await app.request(
      "/api/v2/orgs/1/members/me",
      { method: "DELETE", headers: authHeader(await jwtFor("olive")) },
      env,
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("last_owner")

    const row = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM org_members WHERE org_id = 1 AND user_id = 1",
    ).first<{ role_level: number }>()
    expect(row?.role_level).toBe(700)
  })

  it("lets an owner leave once another owner remains", async () => {
    await seedOrg()
    await env.AQUILLA_PG.prepare(
      "UPDATE org_members SET role_level = 700 WHERE org_id = 1 AND user_id = 2",
    ).run()

    const res = await app.request(
      "/api/v2/orgs/1/members/me",
      { method: "DELETE", headers: authHeader(await jwtFor("olive")) },
      env,
    )
    expect(res.status).toBe(200)
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT user_id FROM org_members WHERE org_id = 1 AND user_id = 1",
      ).first(),
    ).toBeNull()
  })

  it("refuses a personal workspace — that one is deleted, not left", async () => {
    await seedUser(1, "olive")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (2, 'Olive workspace', 1, 'personal')",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (2, 1, 700, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/orgs/2/members/me",
      { method: "DELETE", headers: authHeader(await jwtFor("olive")) },
      env,
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("cannot_leave_personal_org")
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT user_id FROM org_members WHERE org_id = 2 AND user_id = 1",
      ).first(),
    ).not.toBeNull()
  })

  it("404s when the caller is not a member", async () => {
    await seedOrg()
    await seedUser(3, "stranger")

    const res = await app.request(
      "/api/v2/orgs/1/members/me",
      { method: "DELETE", headers: authHeader(await jwtFor("stranger")) },
      env,
    )
    expect(res.status).toBe(404)
  })
})

describe("AQU-1993 DELETE /api/v2/projects/:projectId/members/me", () => {
  it("lets an individually added contributor drop their own grant", async () => {
    await seedUser(1, "olive")
    await seedUser(2, "cass")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-leave', 'Leave', NULL, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-leave', 2, 400, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj-leave/members/me",
      { method: "DELETE", headers: authHeader(await jwtFor("cass")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { left: boolean; stillHasAccess: boolean }
    expect(body.left).toBe(true)
    expect(body.stillHasAccess).toBe(false)

    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT user_id FROM project_members WHERE project_id = 'proj-leave' AND user_id = 2",
      ).first(),
    ).toBeNull()
  })

  it("reports the surviving org path instead of pretending access is gone", async () => {
    await seedOrg()
    // Maintainer is the org-wide access floor (AQU-435, orgPathContribution):
    // below it an org role grants no project access on its own, so the org
    // path only survives for a maintainer+.
    await env.AQUILLA_PG.prepare(
      "UPDATE org_members SET role_level = 600 WHERE org_id = 1 AND user_id = 2",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-org', 'OrgProj', 1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-org', 2, 500, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj-org/members/me",
      { method: "DELETE", headers: authHeader(await jwtFor("cass")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { stillHasAccess: boolean; remainingSource: string | null }
    expect(body.stillHasAccess).toBe(true)
    expect(body.remainingSource).toBe("org")
  })

  it("409s when there is no individual grant to give up", async () => {
    await seedOrg()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-inherit', 'Inherit', 1, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj-inherit/members/me",
      { method: "DELETE", headers: authHeader(await jwtFor("cass")) },
      env,
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("no_direct_membership")
  })
})

describe("AQU-2357 ordinary Owner grant", () => {
  async function token(username: string) {
    return authHeader(await jwtFor(username))
  }

  async function sync(username: string, projectId: string) {
    return app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: await token(username),
        body: JSON.stringify({ projectId, fileId: "__project__" }),
      },
      env,
    )
  }

  it("writes a direct Owner grant, lets another Owner remove the creator, and refuses the last Owner", async () => {
    await seedUser(1, "olive")
    await seedUser(2, "ada")
    await seedUser(3, "bea")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (1, 'Guild', 1, 'team')",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)",
    ).run()

    const created = await app.request(
      "/api/v2/projects",
      {
        method: "POST",
        headers: await token("olive"),
        body: JSON.stringify({ id: "olive-book", name: "Olive", orgId: 1 }),
      },
      env,
    )
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({
      role: { level: 700, name: "owner", source: "override" },
    })
    const oliveGrant = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id = 'olive-book' AND user_id = 1",
    ).first<{ role_level: number }>()
    expect(oliveGrant?.role_level).toBe(700)

    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('solo', 'Solo', NULL, 2)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('solo', 2, 700, 2), ('solo', 3, 700, 2)",
    ).run()

    const removed = await app.request(
      "/api/v2/projects/solo/members/2",
      { method: "DELETE", headers: await token("bea") },
      env,
    )
    expect(removed.status).toBe(200)
    expect((await sync("ada", "solo")).status).toBe(403)
    expect((await sync("bea", "solo")).status).toBe(200)

    const last = await app.request(
      "/api/v2/projects/solo/members/me",
      { method: "DELETE", headers: await token("bea") },
      env,
    )
    expect(last.status).toBe(409)
    const lastBody = (await last.json()) as { error: string; message: string }
    expect(lastBody.error).toBe("last_owner")
    expect(lastBody.message).toContain("at least one owner")
    const beaGrant = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id = 'solo' AND user_id = 3",
    ).first<{ role_level: number }>()
    expect(beaGrant?.role_level).toBe(700)

    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('guild-book', 'Guild Book', 1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('guild-book', 2, 500, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_at) VALUES ('guild-book', 2, 'file', 'f1', 1)",
    ).run()

    const dropped = await app.request(
      "/api/v2/orgs/1/members/2",
      { method: "DELETE", headers: await token("olive") },
      env,
    )
    expect(dropped.status).toBe(200)
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT user_id FROM project_members WHERE project_id = 'guild-book' AND user_id = 2",
      ).first(),
    ).toBeNull()
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT user_id FROM project_member_scopes WHERE project_id = 'guild-book' AND user_id = 2",
      ).first(),
    ).toBeNull()
    expect((await sync("ada", "guild-book")).status).toBe(403)
  })

  it("keeps a direct Owner on the project when the org already has an Owner", async () => {
    await seedUser(1, "olive")
    await seedUser(2, "ada")
    await seedUser(3, "bea")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (1, 'Guild', 1, 'team')",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('book', 'Book', 1, 2)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('book', 2, 700, 1)",
    ).run()

    const olive = authHeader(await jwtFor("olive"))
    const demote = await app.request(
      "/api/v2/projects/book/members",
      { method: "POST", headers: olive, body: JSON.stringify({ username: "ada", role: 400 }) },
      env,
    )
    expect(demote.status).toBe(409)
    expect(((await demote.json()) as { error: string }).error).toBe("last_owner")

    const removed = await app.request(
      "/api/v2/projects/book/members/2",
      { method: "DELETE", headers: olive },
      env,
    )
    expect(removed.status).toBe(409)

    const fromOrg = await app.request(
      "/api/v2/orgs/1/members/2",
      { method: "DELETE", headers: olive },
      env,
    )
    expect(fromOrg.status).toBe(409)
    expect(((await fromOrg.json()) as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual(["book"])
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT role_level FROM project_members WHERE project_id = 'book' AND user_id = 2",
      ).first<{ role_level: number }>(),
    ).toMatchObject({ role_level: 700 })
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT user_id FROM org_members WHERE org_id = 1 AND user_id = 2",
      ).first(),
    ).not.toBeNull()

    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('book', 3, 700, 1)",
    ).run()
    const dropped = await app.request(
      "/api/v2/orgs/1/members/2",
      { method: "DELETE", headers: olive },
      env,
    )
    expect(dropped.status).toBe(200)
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT user_id FROM project_members WHERE project_id = 'book' AND user_id = 2",
      ).first(),
    ).toBeNull()
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT role_level FROM project_members WHERE project_id = 'book' AND user_id = 3",
      ).first<{ role_level: number }>(),
    ).toMatchObject({ role_level: 700 })
  })
})
