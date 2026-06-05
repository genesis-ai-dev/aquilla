import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

// Org 1 with a manager (wendi, maintainer 600) + two assignees (anna 400, bob
// 400) + an outsider (not a member). Project 'pa'. Assignments:
//   as-anna     : anna, OPEN,   books "Genesis", 3 cells (c1,c2,c3); c1+c2 validated -> done 2
//   as-bob      : bob,  OPEN,   chapters "Genesis 1", 2 cells (c4,c5); c4 validated -> done 1
//   as-anna-old : anna, UNASSIGNED (excluded everywhere), 5 cells
async function seedOrgWithAssignments() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(3, "bob")
  await seedUser(9, "outsider")
  await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
  await env.AQUILLA_DB.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 600, 1), (1, 2, 400, 1), (1, 3, 400, 1)",
  ).run()
  await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
  // Direct project grant for anna so the inbox gate (resolveProjectRole) passes.
  await env.AQUILLA_DB.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 2, 400, 1)",
  ).run()
  // One event for the cells' event_id FK (D1 enforces it).
  await env.AQUILLA_DB.prepare(
    "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e-pa', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)",
  ).run()
  await env.AQUILLA_DB.prepare(
    `INSERT INTO assignments (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, cells_total, created_by, created_at, unassigned_at) VALUES
      ('as-anna', 'pa', 2, 'books', 'Genesis', 3, 1, 1000, NULL),
      ('as-bob', 'pa', 3, 'chapters', 'Genesis 1', 2, 1, 1100, NULL),
      ('as-anna-old', 'pa', 2, 'books', 'Exodus', 5, 1, 900, 1500)`,
  ).run()
  await env.AQUILLA_DB.prepare(
    `INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES
      ('as-anna', 'f1', 'c1'), ('as-anna', 'f1', 'c2'), ('as-anna', 'f1', 'c3'),
      ('as-bob', 'f1', 'c4'), ('as-bob', 'f1', 'c5')`,
  ).run()
  // Target cells: a row exists iff that cell has a target translation; validated
  // marks reviewer sign-off. anna c1+c2 done; bob c4 done.
  await env.AQUILLA_DB.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, validated) VALUES
      ('pa', 'f1', 'c1', 'target', 'x', 'e-pa', 1, 1),
      ('pa', 'f1', 'c2', 'target', 'x', 'e-pa', 1, 1),
      ('pa', 'f1', 'c3', 'target', 'x', 'e-pa', 1, 0),
      ('pa', 'f1', 'c4', 'target', 'x', 'e-pa', 1, 1),
      ('pa', 'f1', 'c5', 'target', 'x', 'e-pa', 1, 0)`,
  ).run()
}

describe("GET /api/v2/orgs/:orgId/assignments/workload", () => {
  it("returns per-assignee open workload + derived progress (maintainer)", async () => {
    await seedOrgWithAssignments()
    const res = await app.request(
      "/api/v2/orgs/1/assignments/workload",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      workload: Array<{ userId: number; username: string | null; openAssignments: number; cellsTotal: number; cellsDone: number }>
    }
    const byUser = Object.fromEntries(body.workload.map((w) => [w.userId, w]))
    // as-anna-old is unassigned, so anna shows only the open assignment.
    expect(byUser[2]).toMatchObject({ username: "anna", openAssignments: 1, cellsTotal: 3, cellsDone: 2 })
    expect(byUser[3]).toMatchObject({ username: "bob", openAssignments: 1, cellsTotal: 2, cellsDone: 1 })
    expect(body.workload).toHaveLength(2)
  })

  it("403s a contributor and a non-member", async () => {
    await seedOrgWithAssignments()
    const annaRes = await app.request(
      "/api/v2/orgs/1/assignments/workload",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(annaRes.status).toBe(403)
    const outRes = await app.request(
      "/api/v2/orgs/1/assignments/workload",
      { headers: authHeader(await jwtFor("outsider")) },
      env,
    )
    expect(outRes.status).toBe(403)
  })
})

describe("GET /api/v2/projects/:projectId/assignments/mine", () => {
  it("returns the caller's open assignments with derived progress", async () => {
    await seedOrgWithAssignments()
    const res = await app.request(
      "/api/v2/projects/pa/assignments/mine",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      assignments: Array<{ assignmentId: string; scopeKind: string; scopeLabel: string; cellsTotal: number; cellsDone: number }>
    }
    // Only anna's OPEN assignment: as-anna-old is unassigned; as-bob is bob's.
    expect(body.assignments).toHaveLength(1)
    expect(body.assignments[0]).toMatchObject({
      assignmentId: "as-anna",
      scopeKind: "books",
      scopeLabel: "Genesis",
      cellsTotal: 3,
      cellsDone: 2,
    })
  })

  it("403s a user with no access to the project", async () => {
    await seedOrgWithAssignments()
    const res = await app.request(
      "/api/v2/projects/pa/assignments/mine",
      { headers: authHeader(await jwtFor("outsider")) },
      env,
    )
    expect(res.status).toBe(403)
  })
})

describe("GET /api/v2/projects/:projectId/files/:fileId/chapters", () => {
  it("returns distinct source-cell chapters, natural-sorted; 403s a non-member", async () => {
    await seedUser(1, "wendi")
    await seedUser(9, "outsider")
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 600, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 1, 700, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e-pa', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)").run()
    // Source cells across GEN 1, 2, 10 (dup verse in GEN 1) + a target row that
    // must be excluded by the side filter.
    await env.AQUILLA_DB.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, canonical_ref) VALUES
        ('pa','f1','c1','source','x','e-pa',1,'GEN 1:1'),
        ('pa','f1','c2','source','x','e-pa',1,'GEN 1:2'),
        ('pa','f1','c3','source','x','e-pa',1,'GEN 2:1'),
        ('pa','f1','c4','source','x','e-pa',1,'GEN 10:1'),
        ('pa','f1','c5','target','y','e-pa',1,'GEN 1:1')`,
    ).run()

    const res = await app.request(
      "/api/v2/projects/pa/files/f1/chapters",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { chapters: string[] }
    // Distinct + NATURAL sort: GEN 1, GEN 2, GEN 10 (not lexical 1, 10, 2).
    expect(body.chapters).toEqual(["GEN 1", "GEN 2", "GEN 10"])

    const denied = await app.request(
      "/api/v2/projects/pa/files/f1/chapters",
      { headers: authHeader(await jwtFor("outsider")) },
      env,
    )
    expect(denied.status).toBe(403)
  })
})

describe("GET /api/v2/orgs/:orgId/assignments/mine (consolidated, one request for the whole org)", () => {
  it("returns the caller's open assignments across the org's projects, with project name + progress", async () => {
    await seedOrgWithAssignments()
    const res = await app.request(
      "/api/v2/orgs/1/assignments/mine",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      assignments: Array<{ assignmentId: string; projectId: string; projectName: string; cellsTotal: number; cellsDone: number }>
    }
    // anna has one OPEN assignment (as-anna); as-anna-old is unassigned → excluded.
    expect(body.assignments).toHaveLength(1)
    expect(body.assignments[0]).toMatchObject({
      assignmentId: "as-anna",
      projectId: "pa",
      projectName: "John",
      cellsTotal: 3,
      cellsDone: 2,
    })
  })

  it("excludes archived projects and 403s a non-member", async () => {
    await seedOrgWithAssignments()
    await env.AQUILLA_DB.prepare("UPDATE projects SET archived_at = '2026-01-01' WHERE id='pa'").run()
    const archived = await app.request("/api/v2/orgs/1/assignments/mine", { headers: authHeader(await jwtFor("anna")) }, env)
    expect(archived.status).toBe(200)
    expect(((await archived.json()) as { assignments: unknown[] }).assignments).toHaveLength(0)

    const denied = await app.request("/api/v2/orgs/1/assignments/mine", { headers: authHeader(await jwtFor("outsider")) }, env)
    expect(denied.status).toBe(403)
  })
})

describe("GET /api/v2/projects/:projectId/assignments/all (per-project roster)", () => {
  it("returns per-assignee workload scoped to the project (maintainer)", async () => {
    await seedOrgWithAssignments()
    // Give wendi a direct project-maintainer grant so resolveProjectRole finds her.
    await env.AQUILLA_DB.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 1, 600, 1)",
    ).run()
    const res = await app.request(
      "/api/v2/projects/pa/assignments/all",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      roster: Array<{ userId: number; username: string | null; openAssignments: number; cellsTotal: number; cellsDone: number }>
    }
    const byUser = Object.fromEntries(body.roster.map((w) => [w.userId, w]))
    // anna: 1 open (as-anna-old is unassigned); bob: 1 open.
    expect(byUser[2]).toMatchObject({ username: "anna", openAssignments: 1, cellsTotal: 3, cellsDone: 2 })
    expect(byUser[3]).toMatchObject({ username: "bob", openAssignments: 1, cellsTotal: 2, cellsDone: 1 })
    expect(body.roster).toHaveLength(2)
  })

  it("403s a contributor (anna) and a non-member (outsider)", async () => {
    await seedOrgWithAssignments()
    const annaRes = await app.request(
      "/api/v2/projects/pa/assignments/all",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(annaRes.status).toBe(403)

    const outRes = await app.request(
      "/api/v2/projects/pa/assignments/all",
      { headers: authHeader(await jwtFor("outsider")) },
      env,
    )
    expect(outRes.status).toBe(403)
  })
})
