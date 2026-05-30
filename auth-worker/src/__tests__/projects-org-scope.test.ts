import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

async function seedTwoOrgProjects() {
  await seedUser(1, "wendi")
  await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1), (2, 'Side Org', 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (2, 1, 700, 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'John', 1, 1), ('p2', 'Mark', 1, 1), ('p3', 'Side', 2, 1)").run()
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
})
