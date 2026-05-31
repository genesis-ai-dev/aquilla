import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

async function seed() {
  await seedUser(1, "wendi") // org owner / caller
  await seedUser(2, "anna") // subject
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
      projects: Array<{ projectId: string; direct: number | null; groups: { groupId: number; name: string; roleLevel: number }[]; org: number | null; creator: boolean; resolved: number }>
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
