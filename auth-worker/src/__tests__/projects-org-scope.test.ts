import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedTwoOrgProjects() {
  await seedUser(1, "wendi")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1), (2, 'Side Org', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (2, 1, 700, 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'John', 1, 1), ('p2', 'Mark', 1, 1), ('p3', 'Side', 2, 1)").run()
}

describe("GET /api/v2/projects org scoping", () => {
  it("includes orgId on each project", async () => {
    await seedTwoOrgProjects()
    const res = await app.request("/api/v2/projects", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; orgId: number | null }> }
    const p1 = body.projects.find((p) => p.id === "p1")
    expect(p1?.orgId).toBe(1)
  })

  it("filters by ?orgId", async () => {
    await seedTwoOrgProjects()
    const res = await app.request("/api/v2/projects?orgId=1", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string }> }
    const ids = body.projects.map((p) => p.id).sort()
    expect(ids).toEqual(["p1", "p2"])
  })

  it("rejects a non-numeric orgId with 400", async () => {
    await seedTwoOrgProjects()
    const res = await app.request("/api/v2/projects?orgId=abc", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(400)
  })

  it("returns nothing from an org the caller is not a member of", async () => {
    await seedUser(1, "wendi")
    await seedUser(7, "stranger")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'A', 1), (2, 'B', 7)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (2, 7, 700, 7)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('a1', 'A1', 1, 1), ('b1', 'B1', 2, 7)").run()
    const res = await app.request("/api/v2/projects?orgId=2", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string }> }
    expect(body.projects).toEqual([])
  })
})

describe("POST /api/v2/projects org gating", () => {
  async function seedOrg() {
    await seedUser(1, "wendi") // org owner
    await seedUser(2, "anna")  // org maintainer
    await seedUser(3, "tom")   // org contributor
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1), (1, 3, 400, 1)").run()
  }

  async function create(username: string, body: Record<string, unknown>) {
    return app.request("/api/v2/projects", { method: "POST", headers: authHeader(await jwtFor(username)), body: JSON.stringify(body) }, env)
  }

  it("lets an org maintainer create into the org", async () => {
    await seedOrg()
    const res = await create("anna", { id: "p-new", name: "New", orgId: 1 })
    expect(res.status).toBe(200)
    const row = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = 'p-new'").first<{ org_id: number }>()
    expect(row?.org_id).toBe(1)
  })

  it("rejects an org contributor (403)", async () => {
    await seedOrg()
    const res = await create("tom", { id: "p-x", name: "X", orgId: 1 })
    expect(res.status).toBe(403)
  })

  it("falls back to the personal org when orgId omitted", async () => {
    await seedUser(5, "solo")
    const res = await create("solo", { id: "p-solo", name: "Solo" })
    expect(res.status).toBe(200)
    const proj = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = 'p-solo'").first<{ org_id: number }>()
    const org = await env.AQUILLA_PG.prepare("SELECT id FROM organizations WHERE owner_user_id = 5").first<{ id: number }>()
    expect(proj?.org_id).toBe(org?.id)
  })
})
