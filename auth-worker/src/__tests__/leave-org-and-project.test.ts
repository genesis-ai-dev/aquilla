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
