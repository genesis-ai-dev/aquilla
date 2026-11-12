import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedTwoOrgProjects() {
  await seedUser(1, "wendi")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1), (2, 'Side Org', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (2, 1, 700, 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'John', 1, 1), ('p2', 'Mark', 1, 1), ('p3', 'Side', 2, 1)").run()
}

describe("GET /api/v2/projects org scoping", () => {
  it("includes orgId on each project", async () => {
    await seedTwoOrgProjects()
    const res = await app.request("/api/v2/projects", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; orgId: number | null }> }
    const p1 = body.projects.find((p) => p.id === "p1")
    expect(p1?.orgId).toBe(1)
  })

  // AQU-473: the org switcher needs the host org's display name (not just its
  // id) to label guest orgs — the list endpoint now joins `organizations`.
  it("includes orgName on each project", async () => {
    await seedTwoOrgProjects()
    const res = await app.request("/api/v2/projects", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; orgName: string | null }> }
    const p1 = body.projects.find((p) => p.id === "p1")
    const p3 = body.projects.find((p) => p.id === "p3")
    expect(p1?.orgName).toBe("Come and See")
    expect(p3?.orgName).toBe("Side Org")
  })

  it("filters by ?orgId", async () => {
    await seedTwoOrgProjects()
    const res = await app.request("/api/v2/projects?orgId=1", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string }> }
    const ids = body.projects.map((p) => p.id).sort()
    expect(ids).toEqual(["p1", "p2"])
  })

  it("rejects a non-numeric orgId with 400", async () => {
    await seedTwoOrgProjects()
    const res = await app.request("/api/v2/projects?orgId=abc", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(400)
  })

  it("returns nothing from an org the caller is not a member of", async () => {
    await seedUser(1, "wendi")
    await seedUser(7, "stranger")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'A', 1), (2, 'B', 7)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (2, 7, 700, 7)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('a1', 'A1', 1, 1), ('b1', 'B1', 2, 7)").run()
    const res = await app.request("/api/v2/projects?orgId=2", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string }> }
    expect(body.projects).toEqual([])
  })
})

// AQU-2256 item 1: the add-to-projects picker on an org's Members page calls
// this endpoint with the invite threshold (`?minRole=600`) and the org whose
// roster is open. Both halves of that call shape are asserted here, because
// the reported symptom — "the picker lists projects from orgs the actor isn't
// in, so anyone can be added to any project" — would be a server-side leak if
// the org filter or the membership predicate ever stopped holding under
// `minRole`.
describe("GET /api/v2/projects?minRole=600 — the add-to-projects picker's call", () => {
  async function seedPickerOrgs() {
    await seedUser(1, "wendi")    // maintainer in org 1 AND org 3
    await seedUser(7, "stranger") // owns org 2; wendi is not a member
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org A', 1), (2, 'Org B', 7), (3, 'Org C', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 600, 1), (2, 7, 700, 7), (3, 1, 600, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('a1', 'A1', 1, 1), ('b1', 'B1', 2, 7), ('c1', 'C1', 3, 1)",
    ).run()
  }

  it("returns no project from an org the caller is not a member of, scoped to that org", async () => {
    await seedPickerOrgs()
    const res = await app.request(
      "/api/v2/projects?orgId=2&minRole=600",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string }> }
    expect(body.projects).toEqual([])
  })

  it("returns no project from an org the caller is not a member of, unscoped", async () => {
    await seedPickerOrgs()
    const res = await app.request(
      "/api/v2/projects?minRole=600",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    const body = (await res.json()) as { projects: Array<{ id: string }> }
    expect(body.projects.map((p) => p.id)).not.toContain("b1")
  })

  // The unscoped list is where the client-side half of the defect lived: it
  // legitimately spans every org the caller maintains, so the picker has to
  // pass `?orgId=` to keep one org's page to one org's projects.
  it("spans every org the caller maintains when no orgId is passed", async () => {
    await seedPickerOrgs()
    const res = await app.request(
      "/api/v2/projects?minRole=600",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    const body = (await res.json()) as { projects: Array<{ id: string }> }
    expect(body.projects.map((p) => p.id).sort()).toEqual(["a1", "c1"])
  })

  it("returns only the named org's projects when orgId is passed", async () => {
    await seedPickerOrgs()
    const res = await app.request(
      "/api/v2/projects?orgId=1&minRole=600",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    const body = (await res.json()) as { projects: Array<{ id: string }> }
    expect(body.projects.map((p) => p.id)).toEqual(["a1"])
  })
})

describe("POST /api/v2/projects org gating", () => {
  async function seedOrg() {
    await seedUser(1, "wendi") // org owner
    await seedUser(2, "anna")  // org maintainer
    await seedUser(3, "tom")   // org contributor
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1), (1, 3, 400, 1)").run()
  }

  async function create(username: string, body: Record<string, unknown>) {
    return app.request("/api/v2/projects", { method: "POST", headers: authHeader(await jwtFor(username)), body: JSON.stringify(body) }, env)
  }

  it("lets an org maintainer create into the org", async () => {
    await seedOrg()
    const res = await create("anna", { id: "p-new", name: "New", orgId: 1 })
    expect(res.status).toBe(200)
    const row = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = 'p-new'").first<{ org_id: number }>()
    expect(row?.org_id).toBe(1)
  })

  it("rejects an org contributor (403)", async () => {
    await seedOrg()
    const res = await create("tom", { id: "p-x", name: "X", orgId: 1 })
    expect(res.status).toBe(403)
  })

  // AQU-1352 §3.9 rule 2: the denial names the scope so the client can say
  // "you are a Contributor in Come and See" instead of a bare 403.
  it("names the org in the denial for a member, never for a non-member", async () => {
    await seedOrg()
    await seedUser(7, "outsider")
    const member = (await (await create("tom", { id: "p-y", name: "Y", orgId: 1 })).json()) as { actual: { scopePath?: string[] } }
    expect(member.actual.scopePath).toEqual(["Come and See"])
    const outsider = await create("outsider", { id: "p-z", name: "Z", orgId: 1 })
    expect(outsider.status).toBe(403)
    const body = (await outsider.json()) as { actual: { scopePath?: string[] } }
    expect(body.actual.scopePath).toBeUndefined()
  })

  it("falls back to the personal org when orgId omitted", async () => {
    await seedUser(5, "solo")
    const res = await create("solo", { id: "p-solo", name: "Solo" })
    expect(res.status).toBe(200)
    const proj = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = 'p-solo'").first<{ org_id: number }>()
    const org = await env.AQUILLA_PG.prepare("SELECT id FROM organizations WHERE owner_user_id = 5").first<{ id: number }>()
    expect(proj?.org_id).toBe(org?.id)
  })

  // AQU-1352: owning a TEAM org is not having a personal one. Matching on
  // owner_user_id alone dropped a no-orgId create into the owner's team org,
  // where every team member could then see it.
  it("creates into a new personal org, not an owned team org, when orgId omitted", async () => {
    await seedUser(6, "teamowner")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (60, 'Team Org', 6, 'team')",
    ).run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (60, 6, 700, 6)").run()
    const res = await create("teamowner", { id: "p-mine", name: "Mine" })
    expect(res.status).toBe(200)
    const proj = await env.AQUILLA_PG.prepare(
      "SELECT o.id, o.billing_scope FROM projects p JOIN organizations o ON o.id = p.org_id WHERE p.id = 'p-mine'",
    ).first<{ id: number; billing_scope: string }>()
    expect(proj?.id).not.toBe(60)
    expect(proj?.billing_scope).toBe("personal")
  })
})
