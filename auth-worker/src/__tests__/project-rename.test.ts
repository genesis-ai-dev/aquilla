import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// AQU-765: projects had no rename endpoint (INSERT-only), so a mistyped/test
// project name was fixed forever. PATCH /api/v2/projects/:id renames the row
// that the org list, breadcrumbs, portfolio, and search all read from.
async function seed() {
  await seedUser(1, "wendi") // org owner
  await seedUser(2, "anna") // reviewer (sub-maintainer, level 300)
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 300, 1)",
  ).run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'BGP test', 1, 1)").run()
}

describe("PATCH /api/v2/projects/:projectId (rename)", () => {
  it("renames the project for a maintainer+ caller", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/projects/pa",
      { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "Bible Genesis Project" }) },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "pa", name: "Bible Genesis Project" })
    const row = await env.AQUILLA_PG.prepare("SELECT name FROM projects WHERE id='pa'").first<{ name: string }>()
    expect(row?.name).toBe("Bible Genesis Project")
  })

  it("trims surrounding whitespace before persisting", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/projects/pa",
      { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "  Trimmed Name  " }) },
      env,
    )
    expect(res.status).toBe(200)
    const row = await env.AQUILLA_PG.prepare("SELECT name FROM projects WHERE id='pa'").first<{ name: string }>()
    expect(row?.name).toBe("Trimmed Name")
  })

  it("rejects an empty / whitespace-only name with 400 and leaves the name unchanged", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/projects/pa",
      { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "   " }) },
      env,
    )
    expect(res.status).toBe(400)
    const row = await env.AQUILLA_PG.prepare("SELECT name FROM projects WHERE id='pa'").first<{ name: string }>()
    expect(row?.name).toBe("BGP test")
  })

  it("403s a sub-maintainer caller and leaves the name unchanged", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/projects/pa",
      { method: "PATCH", headers: authHeader(await jwtFor("anna")), body: JSON.stringify({ name: "hijacked" }) },
      env,
    )
    expect(res.status).toBe(403)
    const row = await env.AQUILLA_PG.prepare("SELECT name FROM projects WHERE id='pa'").first<{ name: string }>()
    expect(row?.name).toBe("BGP test")
  })

  it("403s a caller with no access to the project", async () => {
    await seed()
    await seedUser(3, "stranger")
    const res = await app.request(
      "/api/v2/projects/pa",
      { method: "PATCH", headers: authHeader(await jwtFor("stranger")), body: JSON.stringify({ name: "nope" }) },
      env,
    )
    expect(res.status).toBe(403)
  })

  it("the renamed value shows up in the org portfolio", async () => {
    await seed()
    await app.request(
      "/api/v2/projects/pa",
      { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "Genesis (renamed)" }) },
      env,
    )
    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; name: string }> }
    expect(body.projects.find((p) => p.id === "pa")?.name).toBe("Genesis (renamed)")
  })
})
