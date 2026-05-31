import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

describe("POST /api/v2/orgs (create)", () => {
  it("creates a named org with the caller as owner", async () => {
    await seedUser(1, "wendi")
    const res = await app.request("/api/v2/orgs", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "Come and See" }) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; name: string; role: { level: number } }
    expect(body).toMatchObject({ name: "Come and See", role: { level: 700 } })
    const mem = await env.AQUILLA_DB.prepare("SELECT role_level FROM org_members WHERE org_id = ? AND user_id = 1").bind(body.id).first<{ role_level: number }>()
    expect(mem?.role_level).toBe(700)
    const org = await env.AQUILLA_DB.prepare("SELECT owner_user_id FROM organizations WHERE id = ?").bind(body.id).first<{ owner_user_id: number }>()
    expect(org?.owner_user_id).toBe(1)
  })
})

describe("PATCH /api/v2/orgs/:orgId (rename)", () => {
  async function seedOrg() {
    await seedUser(1, "wendi"); await seedUser(2, "tom")
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Old Name', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)").run()
  }
  it("renames the org for a maintainer+ caller", async () => {
    await seedOrg()
    const res = await app.request("/api/v2/orgs/1", { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "Come and See" }) }, env)
    expect(res.status).toBe(200)
    const row = await env.AQUILLA_DB.prepare("SELECT name FROM organizations WHERE id = 1").first<{ name: string }>()
    expect(row?.name).toBe("Come and See")
  })
  it("rejects a sub-maintainer caller with 403", async () => {
    await seedOrg()
    const res = await app.request("/api/v2/orgs/1", { method: "PATCH", headers: authHeader(await jwtFor("tom")), body: JSON.stringify({ name: "Hijack" }) }, env)
    expect(res.status).toBe(403)
  })
})
