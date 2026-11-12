// AQU-1999: GET /api/v2/projects/:projectId/members/:userId/lane-assignments —
// the open work a removal from one lane is about to close.
//
// The Staff popover names the count before it saves anything and then closes
// exactly those assignments, so what this route reports is what gets closed.
// Two things therefore matter as much as the happy path:
//
//   * the lane is resolved by IDENTITY. The seed is the shape that catches a
//     tag-keyed reader: two target lanes of the SAME language, each holding an
//     assignment. A removal from one must never report — and so never close —
//     the other's work.
//   * the floor is project_lead (500+), the same one that governs reading and
//     writing someone else's scopes. Below it the removal itself is refused.
//
// Pins: lane-id and legacy-tag lookup, an ambiguous tag refused rather than
// guessed, closed/completed assignments left out, a file-less scope left out,
// and the floors.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

/**
 * Org 1, project 'pl', file 'f1', source cells c1 + c2.
 *
 * Lanes: ln-src (source), and two Spanish target lanes —
 *   ln-es1  legacy_tag 'Spanish'
 *   ln-es2  legacy_tag 'ln-es2', name 'Spanish — Mexico'
 *
 * People: wendi owner/lead (700), anna + bob contributors (400), lead (500).
 *
 * Assignments (anna unless said otherwise):
 *   as-anna-es1   ln-es1, open                 — the one a removal closes
 *   as-anna-es2   ln-es2, open                 — the sibling lane's, untouched
 *   as-anna-done  ln-es1, completed            — not open
 *   as-anna-gone  ln-es1, unassigned           — not open
 *   as-anna-nofile ln-es1, open, no cells      — nothing to close, no file
 *   as-bob-es1    ln-es1, open, bob's          — someone else's
 */
async function seedProject(): Promise<void> {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(3, "bob")
  await seedUser(4, "lead")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pl', 'Acts', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES
      ('pl', 1, 700, 1), ('pl', 2, 400, 1), ('pl', 3, 400, 1), ('pl', 4, 500, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e-pl', 1, 'pl', 'file.create', 'wendi', '{}', 1000, 1000, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, event_id) VALUES ('f1', 'pl', 'acts.usfm', 'e-pl')",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position) VALUES
      ('ln-src', 'pl', 'source', 'Greek', 'el', NULL, 0),
      ('ln-es1', 'pl', 'target', 'Spanish', 'es', 'Spanish', 1),
      ('ln-es2', 'pl', 'target', 'Spanish — Mexico', 'es', 'ln-es2', 2)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, event_id, last_edit_at, canonical_ref) VALUES
      ('pl', 'f1', 'c1', 'source', 'ln-src', 's1', 'e-pl', 1, 'ACT 1:1'),
      ('pl', 'f1', 'c2', 'source', 'ln-src', 's2', 'e-pl', 1, 'ACT 1:2')`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignments
       (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, lane_id, cells_total, created_by, created_at, unassigned_at, completed_at) VALUES
      ('as-anna-es1',    'pl', 2, 'chapters', 'Acts 1', 'ln-es1', 2, 1, 1000, NULL, NULL),
      ('as-anna-es2',    'pl', 2, 'chapters', 'Acts 2', 'ln-es2', 2, 1, 1100, NULL, NULL),
      ('as-anna-done',   'pl', 2, 'chapters', 'Acts 3', 'ln-es1', 2, 1, 1200, NULL, 1300),
      ('as-anna-gone',   'pl', 2, 'chapters', 'Acts 4', 'ln-es1', 2, 1, 1400, 1500, NULL),
      ('as-anna-nofile', 'pl', 2, 'cells',    '0 lines', 'ln-es1', 0, 1, 1600, NULL, NULL),
      ('as-bob-es1',     'pl', 3, 'chapters', 'Acts 5', 'ln-es1', 2, 1, 1700, NULL, NULL)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES
      ('as-anna-es1','f1','c1'), ('as-anna-es1','f1','c2'),
      ('as-anna-es2','f1','c1'),
      ('as-anna-done','f1','c1'),
      ('as-anna-gone','f1','c1'),
      ('as-bob-es1','f1','c2')`,
  ).run()
}

interface LaneAssignment {
  assignmentId: string
  fileId: string
  scopeLabel: string
}

async function laneAssignments(
  username: string,
  userId: number,
  lane: string,
): Promise<{ status: number; ids: string[]; rows: LaneAssignment[] }> {
  const jwt = await jwtFor(username)
  const res = await app.request(
    `/api/v2/projects/pl/members/${userId}/lane-assignments?lane=${encodeURIComponent(lane)}`,
    { method: "GET", headers: authHeader(jwt) },
    env,
  )
  if (res.status !== 200) return { status: res.status, ids: [], rows: [] }
  const body = (await res.json()) as { assignments: LaneAssignment[] }
  return {
    status: res.status,
    ids: body.assignments.map((a) => a.assignmentId),
    rows: body.assignments,
  }
}

beforeEach(async () => {
  await seedProject()
})

describe("AQU-1999 lane-assignments — what a lane removal will close", () => {
  it("reports the member's open assignments in the lane named by its id", async () => {
    const { status, ids, rows } = await laneAssignments("wendi", 2, "ln-es1")
    expect(status).toBe(200)
    // The sibling Spanish lane's assignment, the closed and completed ones,
    // bob's, and the scope that resolved to no cells are all absent.
    expect(ids).toEqual(["as-anna-es1"])
    expect(rows[0]).toEqual({
      assignmentId: "as-anna-es1",
      fileId: "f1",
      scopeLabel: "Acts 1",
    })
  })

  it("never reports the sibling lane's work for the lane being removed", async () => {
    expect((await laneAssignments("wendi", 2, "ln-es2")).ids).toEqual(["as-anna-es2"])
  })

  it("accepts a legacy tag that names exactly one lane", async () => {
    expect((await laneAssignments("wendi", 2, "Spanish")).ids).toEqual(["as-anna-es1"])
  })

  it("refuses a value that names two lanes rather than guessing one", async () => {
    // Both lanes now answer to "Spanish" — one by tag, one by name.
    await env.AQUILLA_PG.prepare("UPDATE lanes SET name = 'Spanish' WHERE id = 'ln-es2'").run()
    const jwt = await jwtFor("wendi")
    const res = await app.request(
      "/api/v2/projects/pl/members/2/lane-assignments?lane=Spanish",
      { method: "GET", headers: authHeader(jwt) },
      env,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "ambiguous" })
  })

  it("refuses a value that names no lane of this project", async () => {
    expect((await laneAssignments("wendi", 2, "Swahili")).status).toBe(400)
  })

  it("requires the lane", async () => {
    const jwt = await jwtFor("wendi")
    const res = await app.request(
      "/api/v2/projects/pl/members/2/lane-assignments",
      { method: "GET", headers: authHeader(jwt) },
      env,
    )
    expect(res.status).toBe(400)
  })

  it("answers an empty list for a member with nothing open in the lane", async () => {
    await env.AQUILLA_PG.prepare(
      "UPDATE assignments SET unassigned_at = 2000 WHERE assignment_id = 'as-anna-es1'",
    ).run()
    expect(await laneAssignments("wendi", 2, "ln-es1")).toMatchObject({ status: 200, ids: [] })
  })

  it("lets a project lead ask, and refuses anyone below that floor", async () => {
    expect((await laneAssignments("lead", 2, "ln-es1")).ids).toEqual(["as-anna-es1"])
    // A contributor cannot read it — not even about themselves: the removal is
    // lead-only, so there is nothing for them to preview.
    expect((await laneAssignments("anna", 2, "ln-es1")).status).toBe(403)
    expect((await laneAssignments("bob", 2, "ln-es1")).status).toBe(403)
  })
})
