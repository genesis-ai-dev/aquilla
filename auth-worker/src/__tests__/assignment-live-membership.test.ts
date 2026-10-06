import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// AQU-1629: an assignment's lines were fixed when it was created.
//
// `assignment.create` resolved a book/chapter scope into `assignment_cells`
// once, and both halves of progress are derived by joining that snapshot to
// live `cells` (AQU-1068) — a join that can only ever DROP rows. So a cell
// removed from the file self-healed, but a line ADDED to an assigned chapter or
// file never joined the assignment: the assignee's progress read done while the
// chapter still had open work, and the manager's denominator described a unit
// that no longer existed.
//
// The fix records the RANGE in `assignment_scopes` and re-resolves it against
// live `cells` on every read (view `assignment_member_cells`). An explicit line
// selection ('cells' scope, AQU-1628) has no scope row and keeps its frozen
// list — that one must NOT grow.
//
// Org 1 / project 'pa' / file 'f1', three open assignments over the same file:
//   as-anna : books    "Genesis"   — whole file          (scope row, chapter '')
//   as-bob  : chapters "Genesis 1" — GEN 1 only          (scope row, chapter 'GEN 1')
//   as-cleo : cells    "3 lines"   — an explicit pick    (NO scope row)
async function seedAssignedFile() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(3, "bob")
  await seedUser(4, "cleo")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 600, 1), (1, 2, 400, 1), (1, 3, 400, 1), (1, 4, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 2, 400, 1), ('pa', 3, 400, 1), ('pa', 4, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e-pa', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, event_id) VALUES ('f1', 'pa', '01-GEN.usfm', 'e-pa')",
  ).run()

  // GEN 1 has two lines, GEN 2 has one.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at) VALUES
      ('pa', 'f1', 'c1', 'source', 's', 'GEN 1:1', 'e-pa', 1),
      ('pa', 'f1', 'c2', 'source', 's', 'GEN 1:2', 'e-pa', 1),
      ('pa', 'f1', 'c3', 'source', 's', 'GEN 2:1', 'e-pa', 1)`,
  ).run()

  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignments (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, cells_total, created_by, created_at) VALUES
      ('as-anna', 'pa', 2, 'books', 'Genesis', 3, 1, 1000),
      ('as-bob', 'pa', 3, 'chapters', 'Genesis 1', 2, 1, 1100),
      ('as-cleo', 'pa', 4, 'cells', '2 lines', 2, 1, 1200)`,
  ).run()
  // The resolved snapshot assignment.create still writes for every scope.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES
      ('as-anna', 'f1', 'c1'), ('as-anna', 'f1', 'c2'), ('as-anna', 'f1', 'c3'),
      ('as-bob', 'f1', 'c1'), ('as-bob', 'f1', 'c2'),
      ('as-cleo', 'f1', 'c1'), ('as-cleo', 'f1', 'c2')`,
  ).run()
  // The range, for the two assignments that were given one.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignment_scopes (assignment_id, file_id, chapter) VALUES
      ('as-anna', 'f1', ''),
      ('as-bob', 'f1', 'GEN 1')`,
  ).run()
}

/** A line added to the file after the assignments were handed out. */
async function addSourceLine(cellId: string, canonicalRef: string | null) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
     VALUES ('pa', 'f1', ?, 'source', 's', ?, 'e-pa', 2)`,
  )
    .bind(cellId, canonicalRef)
    .run()
}

async function workloadTotals(): Promise<Record<string, { cellsTotal: number; cellsDone: number }>> {
  const res = await app.request(
    "/api/v2/orgs/1/assignments/workload",
    { headers: authHeader(await jwtFor("wendi")) },
    env,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    assignments: Array<{ assignmentId: string; cellsTotal: number; cellsDone: number }>
  }
  return Object.fromEntries(
    body.assignments.map((a) => [a.assignmentId, { cellsTotal: a.cellsTotal, cellsDone: a.cellsDone }]),
  )
}

describe("AQU-1629 — a line added later joins its assignment", () => {
  it("baseline: each scope counts the lines it covers today", async () => {
    await seedAssignedFile()
    expect(await workloadTotals()).toMatchObject({
      "as-anna": { cellsTotal: 3, cellsDone: 0 },
      "as-bob": { cellsTotal: 2, cellsDone: 0 },
      "as-cleo": { cellsTotal: 2, cellsDone: 0 },
    })
  })

  it("grows a whole-file assignment when a line is added to the file", async () => {
    await seedAssignedFile()
    await addSourceLine("c4", "GEN 2:2")
    expect((await workloadTotals())["as-anna"]).toEqual({ cellsTotal: 4, cellsDone: 0 })
  })

  it("grows a chapter assignment only for a line added to THAT chapter", async () => {
    await seedAssignedFile()
    await addSourceLine("c4", "GEN 1:3")
    await addSourceLine("c5", "GEN 2:2")
    const totals = await workloadTotals()
    // GEN 1:3 joins Genesis 1; GEN 2:2 does not. The whole-file assignment
    // takes both.
    expect(totals["as-bob"]).toEqual({ cellsTotal: 3, cellsDone: 0 })
    expect(totals["as-anna"]).toEqual({ cellsTotal: 5, cellsDone: 0 })
  })

  it("does not let a chapter scope swallow a higher-numbered chapter", async () => {
    await seedAssignedFile()
    // The chapter key is compared for equality — "GEN 11" is not "GEN 1" —
    // the same rule assignment.create resolves with (AQU-1493).
    await addSourceLine("c4", "GEN 11:1")
    expect((await workloadTotals())["as-bob"]).toEqual({ cellsTotal: 2, cellsDone: 0 })
  })

  it("leaves an explicit line selection alone", async () => {
    await seedAssignedFile()
    await addSourceLine("c4", "GEN 1:3")
    // as-cleo was given two specific lines. A new line in the file is not one
    // of them, so the selection must not acquire it (AQU-1628).
    expect((await workloadTotals())["as-cleo"]).toEqual({ cellsTotal: 2, cellsDone: 0 })
  })

  it("keeps the assignee's inbox off 100% while the new line is untranslated", async () => {
    await seedAssignedFile()
    await addSourceLine("c4", "GEN 1:3")
    // Everything that existed when anna was assigned is validated.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, validated) VALUES
        ('pa', 'f1', 'c1', 'target', 'x', 'e-pa', 1, 1),
        ('pa', 'f1', 'c2', 'target', 'x', 'e-pa', 1, 1),
        ('pa', 'f1', 'c3', 'target', 'x', 'e-pa', 1, 1)`,
    ).run()
    const res = await app.request(
      "/api/v2/projects/pa/assignments/mine",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      assignments: Array<{ assignmentId: string; cellsTotal: number; cellsDone: number }>
    }
    // This is the reported bug: before AQU-1629 this read 3 of 3.
    expect(body.assignments).toMatchObject([{ assignmentId: "as-anna", cellsTotal: 4, cellsDone: 3 }])
  })

  it("still drops a line removed from the file (AQU-1068 stays fixed)", async () => {
    await seedAssignedFile()
    await env.AQUILLA_PG.prepare(
      "DELETE FROM cells WHERE project_id = 'pa' AND file_id = 'f1' AND cell_id = 'c3'",
    ).run()
    expect((await workloadTotals())["as-anna"]).toEqual({ cellsTotal: 2, cellsDone: 0 })
  })

  it("does not rewrite the resolved snapshot — assignment_cells stays the audit record", async () => {
    await seedAssignedFile()
    await addSourceLine("c4", "GEN 1:3")
    await workloadTotals()
    const row = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM assignment_cells WHERE assignment_id = 'as-anna'",
    ).first<{ n: number }>()
    expect(row?.n).toBe(3)
  })

  it("counts a line once when a whole-file scope and a chapter scope overlap", async () => {
    await seedAssignedFile()
    // The write path never mixes a whole-file entry with a chapter entry for
    // one file, but the view must not double-count if anything ever does — a
    // doubled denominator would read as "0 of 6" on a 3-line book.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO assignment_scopes (assignment_id, file_id, chapter) VALUES ('as-anna', 'f1', 'GEN 1')",
    ).run()
    expect((await workloadTotals())["as-anna"]).toEqual({ cellsTotal: 3, cellsDone: 0 })
  })

  it("keeps a line with no canonical ref in a whole-file scope", async () => {
    await seedAssignedFile()
    // Media and unversified lines carry no canonical_ref. With no stored
    // placement either (cell_plan_keys), such a line has no chapter key, so a
    // chapter scope correctly excludes it — but a whole-file scope must still
    // count it, or a timeline file assigned whole would read as empty.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
       VALUES ('pa', 'f1', 'c9', 'source', 's', NULL, 'e-pa', 2)`,
    ).run()
    const totals = await workloadTotals()
    expect(totals["as-anna"]).toEqual({ cellsTotal: 4, cellsDone: 0 })
    expect(totals["as-bob"]).toEqual({ cellsTotal: 2, cellsDone: 0 })
  })

  it("counts a line with no reference in the chapter the plan board places it in (AQU-1493)", async () => {
    await seedAssignedFile()
    // A heading added above GEN 1:1, or a line added in the editor under GEN
    // 1:2, carries no reference. The full progress recompute places it in a
    // chapter (cell_plan_keys, 0145), and assignment.create resolves a chapter
    // scope by that same key — so the live read does too, instead of leaving
    // the line out as a `LIKE 'GEN 1:%'` would have.
    await addSourceLine("c4", null)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO cell_plan_keys (project_id, file_id, cell_id, section_key, place_ref, depth) VALUES ('pa', 'f1', 'c4', 'GEN 1', 'GEN 1:2', 1)",
    ).run()
    const totals = await workloadTotals()
    expect(totals["as-bob"]).toEqual({ cellsTotal: 3, cellsDone: 0 })
    expect(totals["as-anna"]).toEqual({ cellsTotal: 4, cellsDone: 0 })
  })

  it("falls back to the snapshot for an assignment with no scope row", async () => {
    await seedAssignedFile()
    // Pre-0147 assignments the backfill could not reach (no assignment.create
    // event to read a scope from) keep exactly what they resolved to.
    await env.AQUILLA_PG.prepare("DELETE FROM assignment_scopes WHERE assignment_id = 'as-anna'").run()
    await addSourceLine("c4", "GEN 1:3")
    expect((await workloadTotals())["as-anna"]).toEqual({ cellsTotal: 3, cellsDone: 0 })
  })
})
