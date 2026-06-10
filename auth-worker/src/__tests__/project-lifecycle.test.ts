// FRO-214: Project active/inactive lifecycle toggle endpoint tests.
//
// Tests:
//  1. project_lead+ can deactivate a project (PATCH returns isActive: false)
//  2. project_lead+ can reactivate a project (PATCH returns isActive: true)
//  3. role < project_lead (e.g. contributor) is rejected (403)
//  4. GET /projects list includes isActive field
//  5. GET /projects/:id includes isActive field

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seed() {
  await seedUser(1, "wendi")         // owner (700)
  await seedUser(2, "translator")   // contributor (300)
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 300, 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Live Project', 1, 1)").run()
  // Add contributor as direct project member
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 2, 300, 1)"
  ).run()
}

describe("PATCH /api/v2/projects/:id/lifecycle", () => {
  it("owner can deactivate a project", async () => {
    await seed()
    const jwt = await jwtFor("wendi")
    const res = await app.request(
      "/api/v2/projects/p1/lifecycle",
      {
        method: "PATCH",
        headers: { ...authHeader(jwt), "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; isActive: boolean }
    expect(body.ok).toBe(true)
    expect(body.isActive).toBe(false)
  })

  it("owner can reactivate a project", async () => {
    await seed()
    // First deactivate
    await env.AQUILLA_PG.prepare("UPDATE projects SET is_active = FALSE WHERE id = 'p1'").run()

    const jwt = await jwtFor("wendi")
    const res = await app.request(
      "/api/v2/projects/p1/lifecycle",
      {
        method: "PATCH",
        headers: { ...authHeader(jwt), "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; isActive: boolean }
    expect(body.ok).toBe(true)
    expect(body.isActive).toBe(true)
  })

  it("contributor (role 300 < 500) is rejected with 403", async () => {
    await seed()
    const jwt = await jwtFor("translator")
    const res = await app.request(
      "/api/v2/projects/p1/lifecycle",
      {
        method: "PATCH",
        headers: { ...authHeader(jwt), "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/project_lead/)
  })

  it("persists the change: is_active flips in the DB", async () => {
    await seed()
    const jwt = await jwtFor("wendi")
    await app.request(
      "/api/v2/projects/p1/lifecycle",
      {
        method: "PATCH",
        headers: { ...authHeader(jwt), "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      },
      env,
    )
    const row = await env.AQUILLA_PG.prepare("SELECT is_active FROM projects WHERE id = 'p1'")
      .first<{ is_active: boolean }>()
    expect(row?.is_active).toBe(false)
  })
})

describe("GET /api/v2/projects — isActive in list response", () => {
  it("returns isActive: true for an active project", async () => {
    await seed()
    const jwt = await jwtFor("wendi")
    const res = await app.request("/api/v2/projects?orgId=1", { headers: authHeader(jwt) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; isActive: boolean }> }
    const p = body.projects.find((p) => p.id === "p1")
    expect(p?.isActive).toBe(true)
  })

  it("returns isActive: false after deactivation", async () => {
    await seed()
    await env.AQUILLA_PG.prepare("UPDATE projects SET is_active = FALSE WHERE id = 'p1'").run()
    const jwt = await jwtFor("wendi")
    const res = await app.request("/api/v2/projects?orgId=1", { headers: authHeader(jwt) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; isActive: boolean }> }
    const p = body.projects.find((p) => p.id === "p1")
    expect(p?.isActive).toBe(false)
  })
})

describe("GET /api/v2/projects/:id — isActive in single-project response", () => {
  it("returns isActive: true by default", async () => {
    await seed()
    const jwt = await jwtFor("wendi")
    const res = await app.request("/api/v2/projects/p1", { headers: authHeader(jwt) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { isActive: boolean }
    expect(body.isActive).toBe(true)
  })

  it("returns isActive: false after deactivation", async () => {
    await seed()
    await env.AQUILLA_PG.prepare("UPDATE projects SET is_active = FALSE WHERE id = 'p1'").run()
    const jwt = await jwtFor("wendi")
    const res = await app.request("/api/v2/projects/p1", { headers: authHeader(jwt) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { isActive: boolean }
    expect(body.isActive).toBe(false)
  })
})
