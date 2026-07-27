/**
 * AQU-435 (#215): org-wide project visibility is Maintainer+ only.
 *
 * Org membership used to be a blanket grant path — any org member (even a
 * Contributor, 400) saw and could open EVERY project in the org. The org path
 * is now *oversight*: it fires only at role_level >= 600. A Contributor
 * reaches a project through direct membership or a team (group) grant, and
 * through nothing else.
 *
 * Encodes the issue's acceptance criteria against both surfaces: the list
 * query (GET /api/v2/projects) and the single-project resolver
 * (resolveProjectRole via GET /api/v2/projects/:projectId).
 */

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

interface ListedProject {
  id: string
  role: { level: number; name: string; source: string }
}

async function listProjects(username: string, query = ""): Promise<ListedProject[]> {
  const res = await app.request(
    `/api/v2/projects${query}`,
    { headers: authHeader(await jwtFor(username)) },
    env,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { projects: ListedProject[] }
  return body.projects
}

// users: 1=org owner, 2=contributor (the Kathryn repro), 3=maintainer
// projects: bible-a + bible-b org-owned by user 1; contributor has NO
// direct/team path to either at seed time.
async function seed() {
  await seedUser(1, "org_owner")
  await seedUser(2, "contributor")
  await seedUser(3, "maintainer")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Biblica', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
     VALUES (1, 1, 700, 1), (1, 2, 400, 1), (1, 3, 600, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by)
     VALUES ('bible-a', 'Algerian Bible', 1, 1), ('bible-b', 'ETT Test', 1, 1)`,
  ).run()
}

describe("AQU-435 — org-wide visibility floor (list query)", () => {
  it("a Contributor org member with no team/direct membership sees ZERO org projects", async () => {
    await seed()
    expect(await listProjects("contributor")).toEqual([])
  })

  it("the same Contributor added to a team sees exactly that team's projects", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (5, 1, 'Algerian Team', 1)",
    ).run()
    await env.AQUILLA_PG.prepare("INSERT INTO group_members (group_id, user_id) VALUES (5, 2)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (5, 'bible-a', 400, 1)",
    ).run()

    const projects = await listProjects("contributor")
    expect(projects.map((p) => p.id)).toEqual(["bible-a"])
    expect(projects[0].role).toMatchObject({ level: 400, source: "group" })
  })

  it("a direct project grant reveals that project only, attributed to the override path", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('bible-a', 2, 100, 1)",
    ).run()

    const projects = await listProjects("contributor")
    expect(projects.map((p) => p.id)).toEqual(["bible-a"])
    // The sub-floor org role (400) must not inflate the resolved level.
    expect(projects[0].role).toMatchObject({ level: 100, source: "override" })
  })

  it("Maintainer (600) and Owner (700) still see all org projects via the org path", async () => {
    await seed()
    const maintainer = await listProjects("maintainer")
    expect(maintainer.map((p) => p.id).sort()).toEqual(["bible-a", "bible-b"])
    for (const p of maintainer) expect(p.role).toMatchObject({ level: 600, source: "org" })

    const owner = await listProjects("org_owner")
    expect(owner.map((p) => p.id).sort()).toEqual(["bible-a", "bible-b"])
  })

  it("a Contributor still sees their own personal project (creator path)", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('personal', 'My Draft', NULL, 2)",
    ).run()

    const projects = await listProjects("contributor")
    expect(projects.map((p) => p.id)).toEqual(["personal"])
    expect(projects[0].role).toMatchObject({ level: 700, source: "creator" })
  })

  it("a Contributor-created ORG project also stays visible to them (creator path)", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('own-org-proj', 'Their Project', 1, 2)",
    ).run()

    const projects = await listProjects("contributor", "?orgId=1")
    expect(projects.map((p) => p.id)).toEqual(["own-org-proj"])
    expect(projects[0].role).toMatchObject({ level: 700, source: "creator" })
  })
})

describe("AQU-435 — org-wide visibility floor (single-project resolver)", () => {
  it("resolveProjectRole yields NO org contribution for a Contributor — the project 403s", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/projects/bible-b",
      { headers: authHeader(await jwtFor("contributor")) },
      env,
    )
    expect(res.status).toBe(403)
  })

  it("resolveProjectRole still yields the org contribution for Maintainer+", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/projects/bible-b",
      { headers: authHeader(await jwtFor("maintainer")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role).toMatchObject({ level: 600, source: "org" })
  })

  it("a Contributor's direct grant opens the project at the granted level, not the org level", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('bible-b', 2, 300, 1)",
    ).run()
    const res = await app.request(
      "/api/v2/projects/bible-b",
      { headers: authHeader(await jwtFor("contributor")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role).toMatchObject({ level: 300, source: "override" })
  })
})

describe("AQU-435 — access panels agree with the new semantics", () => {
  it("project members list does not claim a sub-maintainer has access through the org", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/projects/bible-a/members",
      { headers: authHeader(await jwtFor("org_owner")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { members: Array<{ userId: number; role: { source: string } }> }
    const ids = body.members.map((m) => m.userId).sort()
    // owner (creator/org) + maintainer (org) — the contributor is absent.
    expect(ids).toEqual([1, 3])
  })

  it("removing a Contributor's only direct grant leaves no surviving org path", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('bible-a', 2, 400, 1)",
    ).run()
    const res = await app.request(
      "/api/v2/projects/bible-a/members/2/revoke-all",
      { method: "POST", headers: authHeader(await jwtFor("org_owner")), body: "{}" },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { removed: boolean; grantPaths: Array<{ source: string }> }
    expect(body.removed).toBe(true)
    // Pre-AQU-435 an "org" path (400) survived here and kept them a member.
    expect(body.grantPaths.filter((p) => p.source !== "override")).toEqual([])
  })
})
