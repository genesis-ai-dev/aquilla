import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// AQU-2458: a project-only member's assignments.
//
// TR1 is added DIRECTLY to one of org 1's projects (contributor) and is NOT in
// `org_members` — the app calls that a "guest org". TR2 reaches the same
// project through the org. Both are handed the same kind of work, and both
// must be able to find it: in the project ("My assignments") and across
// projects ("Assigned to me").
//
// The org-wide list used to 403 TR1 because it gated on org membership, even
// though its query is keyed to `assignee_user_id = caller` and so can only
// ever return the caller's own rows. OUT is a real outsider: no org role, no
// grant, no assignment — still 403, which is the part that must not regress.
async function seed() {
  await seedUser(1, "own")
  await seedUser(2, "tr1")
  await seedUser(3, "tr2")
  await seedUser(9, "out")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'PMR', 1)",
  ).run()
  // TR1 is deliberately absent here — that is what makes them project-only.
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 3, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'PMR Alpha', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 2, 400, 1), ('pa', 3, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e-pa', 1, 'pa', 'file.create', 'own', '{}', 1000, 1000, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, event_id) VALUES ('f1', 'pa', '01-GEN.usfm', 'e-pa')",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignments (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, cells_total, deadline, note, created_by, created_at) VALUES
      ('as-tr1', 'pa', 2, 'books', 'Genesis', 2, '2026-12-01', 'start here', 1, 1000),
      ('as-tr2', 'pa', 3, 'books', 'Genesis', 2, '2026-12-01', 'ditto', 1, 1100)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES
      ('as-tr1', 'f1', 'c1'), ('as-tr1', 'f1', 'c2'),
      ('as-tr2', 'f1', 'c1'), ('as-tr2', 'f1', 'c2')`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at) VALUES
      ('pa', 'f1', 'c1', 'source', 's', 'e-pa', 1),
      ('pa', 'f1', 'c2', 'source', 's', 'e-pa', 1)`,
  ).run()
}

async function get(path: string, username: string) {
  const res = await app.request(path, { headers: authHeader(await jwtFor(username)) }, env)
  if (res.status !== 200) return { status: res.status, ids: [] as string[] }
  const body = (await res.json()) as { assignments: Array<{ assignmentId: string; deadline: string | null; note: string | null }> }
  return { status: 200, ids: body.assignments.map((a) => a.assignmentId), rows: body.assignments }
}

describe("GET /api/v2/projects/:projectId/assignments/mine — project-only member", () => {
  it("lists a project-only member's own assignment, with its deadline and note", async () => {
    await seed()
    const got = await get("/api/v2/projects/pa/assignments/mine", "tr1")
    expect(got.status).toBe(200)
    expect(got.ids).toEqual(["as-tr1"])
    expect(got.rows?.[0]).toMatchObject({ deadline: "2026-12-01", note: "start here" })
  })

  it("still lists an org member's own assignment, and never the other person's", async () => {
    await seed()
    expect((await get("/api/v2/projects/pa/assignments/mine", "tr2")).ids).toEqual(["as-tr2"])
  })

  it("403s someone with no access to the project", async () => {
    await seed()
    expect((await get("/api/v2/projects/pa/assignments/mine", "out")).status).toBe(403)
  })
})

// TR1 is a contributor on ONE lane of a multi-lane project ("Spanish only"),
// and the work they were handed is on that lane. Neither read filters by the
// caller's lane scopes, so the lane shape must not change the answer.
describe("a project-only member scoped to one lane of a multi-lane project", () => {
  async function seedLanes() {
    await seed()
    // The project insert already carries a source lane and a default target
    // lane; Spanish is the second target lane, and TR1's only one.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position) VALUES
        ('ln-tgt-es', 'pa', 'target', 'Spanish', 'es', 9)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      "UPDATE assignments SET lane_id = 'ln-tgt-es' WHERE assignment_id IN ('as-tr1', 'as-tr2')",
    ).run()
  }

  it("lists the lane's assignment in the project and across the org", async () => {
    await seedLanes()
    expect((await get("/api/v2/projects/pa/assignments/mine", "tr1")).ids).toEqual(["as-tr1"])
    expect((await get("/api/v2/orgs/1/assignments/mine", "tr1")).ids).toEqual(["as-tr1"])
  })
})

describe("GET /api/v2/orgs/:orgId/assignments/mine — project-only member (AQU-2458)", () => {
  it("gives a project-only member their cross-project list instead of 403", async () => {
    await seed()
    const got = await get("/api/v2/orgs/1/assignments/mine", "tr1")
    expect(got.status).toBe(200)
    expect(got.ids).toEqual(["as-tr1"])
  })

  it("still answers an org member with their own rows only", async () => {
    await seed()
    expect((await get("/api/v2/orgs/1/assignments/mine", "tr2")).ids).toEqual(["as-tr2"])
  })

  it("403s an outsider with no role and no project in the org", async () => {
    await seed()
    expect((await get("/api/v2/orgs/1/assignments/mine", "out")).status).toBe(403)
  })

  // The guest who opens the page before any work has been handed out: they
  // reach the org's project, so the page says "no open assignments" rather
  // than showing them an access error.
  it("answers a project-only member with nothing assigned with an empty list", async () => {
    await seed()
    await env.AQUILLA_PG.prepare("DELETE FROM assignments WHERE assignment_id = 'as-tr1'").run()
    expect(await get("/api/v2/orgs/1/assignments/mine", "tr1")).toMatchObject({ status: 200, ids: [] })
  })

  it("403s a project-only member once their project grant is revoked", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "DELETE FROM project_members WHERE project_id = 'pa' AND user_id = 2",
    ).run()
    // The assignment row survives the revoke; their access to it must not.
    expect((await get("/api/v2/orgs/1/assignments/mine", "tr1")).status).toBe(403)
  })

  // A guest on project B must not be handed their own rows from project A in
  // the same org after losing A — the list is filtered per project, not
  // all-or-nothing on "reaches something here".
  it("lists only the projects a project-only member still reaches", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pb', 'PMR Beta', 1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pb', 2, 400, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO assignments (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, cells_total, created_by, created_at)
       VALUES ('as-tr1-b', 'pb', 2, 'books', 'Exodus', 1, 1, 1200)`,
    ).run()
    expect((await get("/api/v2/orgs/1/assignments/mine", "tr1")).ids.sort()).toEqual(["as-tr1", "as-tr1-b"])
    // Lose project A only; project B's row stays.
    await env.AQUILLA_PG.prepare(
      "DELETE FROM project_members WHERE project_id = 'pa' AND user_id = 2",
    ).run()
    expect((await get("/api/v2/orgs/1/assignments/mine", "tr1")).ids).toEqual(["as-tr1-b"])
  })
})
