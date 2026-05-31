import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

describe("GET /api/v2/projects?archived", () => {
  async function seed() {
    await seedUser(1, "wendi")
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('live', 'Live', 1, 1)").run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO projects (id, name, org_id, created_by, archived_at, archived_by) VALUES ('old', 'Old', 1, 1, CURRENT_TIMESTAMP, 1)",
    ).run()
  }

  it("default list excludes archived projects", async () => {
    await seed()
    const res = await app.request("/api/v2/projects?orgId=1", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string }> }
    expect(body.projects.map((p) => p.id)).toEqual(["live"])
  })

  it("archived=true returns only archived projects, with archivedAt", async () => {
    await seed()
    const res = await app.request("/api/v2/projects?orgId=1&archived=true", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; archivedAt: string | null }> }
    expect(body.projects.map((p) => p.id)).toEqual(["old"])
    expect(body.projects[0].archivedAt).toBeTruthy()
  })
})
