import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

async function seed() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 300, 1)").run() // anna: reviewer (sub-maintainer)
  await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
}

describe("PATCH /api/v2/projects/:projectId/deadline", () => {
  it("sets a deadline for a maintainer+ caller and clears it with null", async () => {
    await seed()
    const set = await app.request("/api/v2/projects/pa/deadline", { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ deadline: "2026-07-01" }) }, env)
    expect(set.status).toBe(200)
    let row = await env.AQUILLA_DB.prepare("SELECT deadline_at FROM projects WHERE id='pa'").first<{ deadline_at: string | null }>()
    expect(row?.deadline_at).toBe("2026-07-01")
    const clear = await app.request("/api/v2/projects/pa/deadline", { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ deadline: null }) }, env)
    expect(clear.status).toBe(200)
    row = await env.AQUILLA_DB.prepare("SELECT deadline_at FROM projects WHERE id='pa'").first<{ deadline_at: string | null }>()
    expect(row?.deadline_at).toBeNull()
  })

  it("403s a sub-maintainer caller", async () => {
    await seed()
    const res = await app.request("/api/v2/projects/pa/deadline", { method: "PATCH", headers: authHeader(await jwtFor("anna")), body: JSON.stringify({ deadline: "2026-07-01" }) }, env)
    expect(res.status).toBe(403)
  })

  it("includes deadlineAt in the org portfolio", async () => {
    await seed()
    await env.AQUILLA_DB.prepare("UPDATE projects SET deadline_at = '2026-07-01' WHERE id='pa'").run()
    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; deadlineAt: string | null }> }
    expect(body.projects.find((p) => p.id === "pa")?.deadlineAt).toBe("2026-07-01")
  })
})
