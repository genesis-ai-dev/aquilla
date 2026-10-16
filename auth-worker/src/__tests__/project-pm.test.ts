import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// AQU-507: PATCH /api/v2/projects/:projectId/pm — designate/clear the project
// manager. Gated at maintainer+ (mirrors deadline); the target must be an
// effective member of the project; the PM surfaces on the list endpoint.
async function seed() {
  await seedUser(1, "wendi") // owner (project creator) → level 700
  await seedUser(2, "anna") // direct project member (contributor 400)
  await seedUser(3, "carol") // no membership anywhere → non-member
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 2, 400, 1)").run()
}

describe("PATCH /api/v2/projects/:projectId/pm", () => {
  it("assigns a PM (member target, maintainer+ caller) and clears it with null", async () => {
    await seed()
    const set = await app.request(
      "/api/v2/projects/pa/pm",
      { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ pmUserId: 2 }) },
      env,
    )
    expect(set.status).toBe(200)
    expect((await set.json())).toMatchObject({ ok: true, pm: { id: 2, username: "anna" } })
    let row = await env.AQUILLA_PG.prepare("SELECT pm_user_id FROM projects WHERE id='pa'").first<{ pm_user_id: number | null }>()
    expect(Number(row?.pm_user_id)).toBe(2)
    // AQU-984: a contributor named PM is raised to a visible Project lead.
    const raised = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id='pa' AND user_id=2",
    ).first<{ role_level: number }>()
    expect(Number(raised?.role_level)).toBe(500)

    const clear = await app.request(
      "/api/v2/projects/pa/pm",
      { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ pmUserId: null }) },
      env,
    )
    expect(clear.status).toBe(200)
    expect((await clear.json())).toMatchObject({ ok: true, pm: null })
    row = await env.AQUILLA_PG.prepare("SELECT pm_user_id FROM projects WHERE id='pa'").first<{ pm_user_id: number | null }>()
    expect(row?.pm_user_id).toBeNull()
    // Clearing the PM does not remove the Project lead membership.
    const kept = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id='pa' AND user_id=2",
    ).first<{ role_level: number }>()
    expect(Number(kept?.role_level)).toBe(500)
  })

  it("does not lower an existing role above project lead", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "UPDATE project_members SET role_level = 600 WHERE project_id='pa' AND user_id=2",
    ).run()
    const res = await app.request(
      "/api/v2/projects/pa/pm",
      { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ pmUserId: 2 }) },
      env,
    )
    expect(res.status).toBe(200)
    const role = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id='pa' AND user_id=2",
    ).first<{ role_level: number }>()
    expect(Number(role?.role_level)).toBe(600)
  })

  it("adds a visible project-lead row for an org maintainer who had none", async () => {
    await seed()
    await seedUser(4, "bob")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 4, 600, 1)",
    ).run()
    const res = await app.request(
      "/api/v2/projects/pa/pm",
      { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ pmUserId: 4 }) },
      env,
    )
    expect(res.status).toBe(200)
    const direct = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id='pa' AND user_id=4",
    ).first<{ role_level: number }>()
    expect(Number(direct?.role_level)).toBe(500)
    const orgRole = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM org_members WHERE org_id=1 AND user_id=4",
    ).first<{ role_level: number }>()
    expect(Number(orgRole?.role_level)).toBe(600)
  })

  it("rejects a target who is not a member of the project", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/projects/pa/pm",
      { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ pmUserId: 3 }) },
      env,
    )
    expect(res.status).toBe(400)
    const row = await env.AQUILLA_PG.prepare("SELECT pm_user_id FROM projects WHERE id='pa'").first<{ pm_user_id: number | null }>()
    expect(row?.pm_user_id).toBeNull()
  })

  it("403s a sub-maintainer caller", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/projects/pa/pm",
      { method: "PATCH", headers: authHeader(await jwtFor("anna")), body: JSON.stringify({ pmUserId: 2 }) },
      env,
    )
    expect(res.status).toBe(403)
  })

  it("surfaces the assigned PM on the projects list endpoint", async () => {
    await seed()
    await env.AQUILLA_PG.prepare("UPDATE projects SET pm_user_id = 2 WHERE id='pa'").run()
    const res = await app.request("/api/v2/projects", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; pm: { id: number; username: string } | null }> }
    expect(body.projects.find((p) => p.id === "pa")?.pm).toMatchObject({ id: 2, username: "anna" })
  })
})
