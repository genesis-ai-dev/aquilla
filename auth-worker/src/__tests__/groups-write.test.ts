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

  it("rejects a caller who is not an org member at all with 403", async () => {
    await seedOrg()
    await seedUser(8, "stranger") // exists, but no org_members row in org 1
    await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'WA', 1)").run()
    const res = await app.request("/api/v2/orgs/1/groups/10", { method: "DELETE", headers: authHeader(await jwtFor("stranger")) }, env)
    expect(res.status).toBe(403)
  })
})

describe("team membership", () => {
  async function seedTeam() {
    await seedUser(1, "wendi")
    await seedUser(2, "anna")    // org member
    await seedUser(9, "outsider") // NOT an org member
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 100, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'WA', 1)").run()
  }

  it("adds an org member to a team", async () => {
    await seedTeam()
    const res = await app.request("/api/v2/orgs/1/groups/10/members", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ username: "anna" }) }, env)
    expect(res.status).toBe(200)
    const row = await env.AQUILLA_DB.prepare("SELECT user_id FROM group_members WHERE group_id = 10 AND user_id = 2").first()
    expect(row).not.toBeNull()
  })

  it("rejects adding a non-org-member with 409", async () => {
    await seedTeam()
    const res = await app.request("/api/v2/orgs/1/groups/10/members", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ username: "outsider" }) }, env)
    expect(res.status).toBe(409)
  })

  it("removes a member", async () => {
    await seedTeam()
    await env.AQUILLA_DB.prepare("INSERT INTO group_members (group_id, user_id, added_by) VALUES (10, 2, 1)").run()
    const res = await app.request("/api/v2/orgs/1/groups/10/members/2", { method: "DELETE", headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const gone = await env.AQUILLA_DB.prepare("SELECT user_id FROM group_members WHERE group_id = 10 AND user_id = 2").first()
    expect(gone).toBeNull()
  })
})

describe("team project attachment", () => {
  async function seedTeamProjects() {
    await seedUser(1, "wendi") // org owner (700)
    await seedUser(2, "anna")  // org maintainer (600)
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1), (2, 'Other', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'WA', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Bambara', 1, 1), ('pb', 'Foreign', 2, 1)").run()
  }

  it("attaches an org project at a role, then changes + detaches it", async () => {
    await seedTeamProjects()
    const attach = await app.request("/api/v2/orgs/1/groups/10/projects", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ projectId: "pa", roleLevel: 400 }) }, env)
    expect(attach.status).toBe(200)
    let row = await env.AQUILLA_DB.prepare("SELECT role_level FROM group_project_grants WHERE group_id = 10 AND project_id = 'pa'").first<{ role_level: number }>()
    expect(row?.role_level).toBe(400)
    const patch = await app.request("/api/v2/orgs/1/groups/10/projects/pa", { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ roleLevel: 300 }) }, env)
    expect(patch.status).toBe(200)
    row = await env.AQUILLA_DB.prepare("SELECT role_level FROM group_project_grants WHERE group_id = 10 AND project_id = 'pa'").first<{ role_level: number }>()
    expect(row?.role_level).toBe(300)
    const det = await app.request("/api/v2/orgs/1/groups/10/projects/pa", { method: "DELETE", headers: authHeader(await jwtFor("wendi")) }, env)
    expect(det.status).toBe(200)
    const gone = await env.AQUILLA_DB.prepare("SELECT project_id FROM group_project_grants WHERE group_id = 10 AND project_id = 'pa'").first()
    expect(gone).toBeNull()
  })

  it("rejects attaching a project from another org with 409", async () => {
    await seedTeamProjects()
    const res = await app.request("/api/v2/orgs/1/groups/10/projects", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ projectId: "pb", roleLevel: 400 }) }, env)
    expect(res.status).toBe(409)
  })

  it("rejects granting above the caller's own org role with 403", async () => {
    await seedTeamProjects()
    // anna is org maintainer (600); granting owner (700) exceeds her level.
    const res = await app.request("/api/v2/orgs/1/groups/10/projects", { method: "POST", headers: authHeader(await jwtFor("anna")), body: JSON.stringify({ projectId: "pa", roleLevel: 700 }) }, env)
    expect(res.status).toBe(403)
  })

  it("rejects PATCH granting above the caller's own org role with 403", async () => {
    await seedTeamProjects()
    // wendi (owner) attaches pa at contributor first
    await app.request("/api/v2/orgs/1/groups/10/projects", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ projectId: "pa", roleLevel: 400 }) }, env)
    // anna (maintainer 600) tries to PATCH it up to owner (700) → 403
    const res = await app.request("/api/v2/orgs/1/groups/10/projects/pa", { method: "PATCH", headers: authHeader(await jwtFor("anna")), body: JSON.stringify({ roleLevel: 700 }) }, env)
    expect(res.status).toBe(403)
  })
})
