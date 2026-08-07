import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedGroups() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(9, "outsider")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 100, 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'West Africa', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO group_members (group_id, user_id) VALUES (10, 1), (10, 2)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Bambara', 1, 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO group_project_grants (group_id, project_id, role_level) VALUES (10, 'pa', 400)").run()
}

describe("GET /api/v2/orgs/:orgId/groups", () => {
  it("lists groups with counts + viewerIsMember", async () => {
    await seedGroups()
    const res = await app.request("/api/v2/orgs/1/groups", { headers: authHeader(await jwtFor("anna")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups: Array<{ id: number; name: string; memberCount: number; projectCount: number; viewerIsMember: boolean }> }
    expect(body.groups).toHaveLength(1)
    expect(body.groups[0]).toMatchObject({ id: 10, name: "West Africa", memberCount: 2, projectCount: 1, viewerIsMember: true })
  })

  it("403s for a non-org-member", async () => {
    await seedGroups()
    const res = await app.request("/api/v2/orgs/1/groups", { headers: authHeader(await jwtFor("outsider")) }, env)
    expect(res.status).toBe(403)
  })

  // Regression: AQU-158 — GET /orgs/:id/groups returned 500 after the Postgres
  // cutover because the is_internal column was missing from the live Neon DB.
  // This test verifies: (a) the endpoint returns 200 (not 500), (b) is_internal /
  // isInternal is present and has the correct default value (true), and (c) an
  // org with subgroups (teams) populates the list correctly.
  it("AQU-158 regression: returns 200 with isInternal field for orgs with subgroups", async () => {
    await seedGroups()
    // Seed a second group explicitly marked as non-internal (public team)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by, is_internal) VALUES (11, 1, 'East Africa', 1, false)",
    ).run()
    const res = await app.request("/api/v2/orgs/1/groups", { headers: authHeader(await jwtFor("wendi")) }, env)
    // Must be 200 — was 500 before AQU-158 fix (missing is_internal column on Neon)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups: Array<{ id: number; name: string; isInternal: boolean; viewerIsMember: boolean }> }
    // Org has two subgroups — both must appear
    expect(body.groups).toHaveLength(2)
    const byName = Object.fromEntries(body.groups.map((g) => [g.name, g]))
    // Default is_internal = true (existing groups after migration)
    expect(byName["West Africa"].isInternal).toBe(true)
    // Explicitly set to false
    expect(byName["East Africa"].isInternal).toBe(false)
    // Viewer (wendi) is a member of West Africa, not East Africa
    expect(byName["West Africa"].viewerIsMember).toBe(true)
    expect(byName["East Africa"].viewerIsMember).toBe(false)
  })
})

describe("GET /api/v2/orgs/:orgId/groups/:groupId", () => {
  it("returns members + attached projects", async () => {
    await seedGroups()
    const res = await app.request("/api/v2/orgs/1/groups/10", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; name: string; description: string | null; members: Array<{ username: string; email: string | null }>; projects: Array<{ id: string; name: string; grantedRoleLevel: number }> }
    expect(body.members.map((m) => m.username).sort()).toEqual(["anna", "wendi"])
    // Email comes from the users row (seedUser derives it from the username).
    expect(body.members.every((m) => typeof m.email === "string" && m.email.includes("@"))).toBe(true)
    expect(body.projects).toEqual([{ id: "pa", name: "Bambara", grantedRoleLevel: 400 }])
    // AQU-264: description must be present in the detail response (null when not set)
    expect(Object.keys(body)).toContain("description")
    expect(body.description).toBeNull()
  })

  it("AQU-264: returns description from group detail when set", async () => {
    await seedGroups()
    await env.AQUILLA_PG.prepare("UPDATE groups SET description = 'West Africa translation team' WHERE id = 10").run()
    const res = await app.request("/api/v2/orgs/1/groups/10", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { description: string | null }
    expect(body.description).toBe("West Africa translation team")
  })

  // AQU-748: a contributor must not see the member list of a team they don't
  // belong to. Seed a second team (id 11) that anna (viewer, role 100) is NOT in.
  async function seedSecondTeam() {
    await seedUser(3, "kofi")
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 3, 400, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (11, 1, 'East Africa', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO group_members (group_id, user_id) VALUES (11, 1), (11, 3)").run()
  }

  it("AQU-748: hides a team's members from an org member who is not on that team", async () => {
    await seedGroups()
    await seedSecondTeam()
    // anna (role 100, member of team 10 only) tries to read team 11's detail.
    const res = await app.request("/api/v2/orgs/1/groups/11", { headers: authHeader(await jwtFor("anna")) }, env)
    expect(res.status).toBe(404)
  })

  it("AQU-748: a member still sees their own team's members (no regression)", async () => {
    await seedGroups()
    await seedSecondTeam()
    // anna is a member of team 10 — must still see its members.
    const res = await app.request("/api/v2/orgs/1/groups/10", { headers: authHeader(await jwtFor("anna")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { members: Array<{ username: string }> }
    expect(body.members.map((m) => m.username).sort()).toEqual(["anna", "wendi"])
  })

  it("AQU-748: maintainers+ see any team's members even when not a member", async () => {
    await seedGroups()
    await seedSecondTeam()
    // wendi is an org owner (role 700) but NOT a member of team 11 in this setup?
    // wendi IS in team 11 (seedSecondTeam adds user 1). Remove her to prove the
    // admin bypass, not membership, grants access.
    await env.AQUILLA_PG.prepare("DELETE FROM group_members WHERE group_id = 11 AND user_id = 1").run()
    const res = await app.request("/api/v2/orgs/1/groups/11", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { members: Array<{ username: string }> }
    expect(body.members.map((m) => m.username)).toEqual(["kofi"])
  })

  it("excludes cross-org project grants from group detail", async () => {
    await seedGroups()
    await seedUser(8, "other")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'Other Org', 8)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pb', 'Foreign', 2, 8)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO group_project_grants (group_id, project_id, role_level) VALUES (10, 'pb', 400)").run()
    const res = await app.request("/api/v2/orgs/1/groups/10", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string }> }
    expect(body.projects.map((p) => p.id)).toEqual(["pa"]) // pb (org 2) excluded
  })
})
