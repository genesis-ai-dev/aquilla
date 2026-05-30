import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

async function seedGroups() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(9, "outsider")
  await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 100, 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'West Africa', 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO group_members (group_id, user_id) VALUES (10, 1), (10, 2)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Bambara', 1, 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO group_project_grants (group_id, project_id, role_level) VALUES (10, 'pa', 400)").run()
}

describe("GET /api/v2/orgs/:orgId/groups", () => {
  it("lists groups with counts + viewerIsMember", async () => {
    await seedGroups()
    const res = await app.request("/api/v2/orgs/1/groups", { headers: authHeader(await jwtFor("anna")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups: Array<{ id: number; name: string; memberCount: number; projectCount: number; viewerIsMember: boolean }> }
    expect(body.groups).toHaveLength(1)
    expect(body.groups[0]).toMatchObject({ id: 10, name: "West Africa", memberCount: 2, projectCount: 1, viewerIsMember: true })
  })

  it("403s for a non-org-member", async () => {
    await seedGroups()
    const res = await app.request("/api/v2/orgs/1/groups", { headers: authHeader(await jwtFor("outsider")) }, env)
    expect(res.status).toBe(403)
  })
})

describe("GET /api/v2/orgs/:orgId/groups/:groupId", () => {
  it("returns members + attached projects", async () => {
    await seedGroups()
    const res = await app.request("/api/v2/orgs/1/groups/10", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; name: string; members: Array<{ username: string }>; projects: Array<{ id: string; name: string; grantedRoleLevel: number }> }
    expect(body.members.map((m) => m.username).sort()).toEqual(["anna", "wendi"])
    expect(body.projects).toEqual([{ id: "pa", name: "Bambara", grantedRoleLevel: 400 }])
  })
})
