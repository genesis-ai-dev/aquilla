import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

async function seedOrg() {
  await seedUser(1, "wendi")  // owner
  await seedUser(2, "tom")    // contributor (org role 400 — below gate)
  await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)").run()
}

describe("group CRUD", () => {
  it("creates a team (admin) and rejects duplicate names", async () => {
    await seedOrg()
    const res = await app.request("/api/v2/orgs/1/groups", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "West Africa", description: "WA leads" }) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; name: string; description: string | null }
    expect(body).toMatchObject({ name: "West Africa", description: "WA leads" })
    const dup = await app.request("/api/v2/orgs/1/groups", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "West Africa" }) }, env)
    expect(dup.status).toBe(409)
  })

  it("rejects a non-admin (org role < maintainer) with 403", async () => {
    await seedOrg()
    const res = await app.request("/api/v2/orgs/1/groups", { method: "POST", headers: authHeader(await jwtFor("tom")), body: JSON.stringify({ name: "X" }) }, env)
    expect(res.status).toBe(403)
  })

  it("renames a team and deletes it (cascading members + grants)", async () => {
    await seedOrg()
    await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'Old', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO group_members (group_id, user_id, added_by) VALUES (10, 1, 1)").run()
    const patch = await app.request("/api/v2/orgs/1/groups/10", { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "New", description: "d" }) }, env)
    expect(patch.status).toBe(200)
    const renamed = await env.AQUILLA_DB.prepare("SELECT name FROM groups WHERE id = 10").first<{ name: string }>()
    expect(renamed?.name).toBe("New")
    const del = await app.request("/api/v2/orgs/1/groups/10", { method: "DELETE", headers: authHeader(await jwtFor("wendi")) }, env)
    expect(del.status).toBe(200)
    const gone = await env.AQUILLA_DB.prepare("SELECT id FROM groups WHERE id = 10").first()
    expect(gone).toBeNull()
    const members = await env.AQUILLA_DB.prepare("SELECT group_id FROM group_members WHERE group_id = 10").all()
    expect(members.results).toHaveLength(0) // FK cascade
  })

  it("404s renaming a group from another org", async () => {
    await seedOrg()
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'Other', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (20, 2, 'Foreign', 1)").run()
    const res = await app.request("/api/v2/orgs/1/groups/20", { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "Hijack" }) }, env)
    expect(res.status).toBe(404)
  })
})
