// AQU-1609: an assignment's lane is `assignments.lane_id`, and every read keys
// on it rather than on the legacy `target_lang` tag both tables also carry.
//
// The tag indirection happened to agree with the id, because
// `planNewTargetLane` hands a second lane of the same language its own lane id
// as its tag. "Happened to" is the problem: the agreement is a property of one
// writer, it is what AQU-1611 is about to delete, and it is already false for
// an assignment whose lane was retagged after the work was handed out. These
// tests pin the id as the identity so a reader cannot drift back onto the tag.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import {
  getMyAssignments,
  getOrgAssignmentWorkload,
  getUnitAssignments,
} from "../services/assignments"
import type { Env } from "../types"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import app from "../index"

const testEnv = env as unknown as Env

/**
 * Org 1, project 'pb', file 'f1', source cells c1 + c2.
 *
 * Two target lanes of the SAME language (Spanish), which is the shape the
 * acceptance criterion names:
 *   ln-es1  legacy_tag 'Spanish'  — the first lane of the language keeps it
 *   ln-es2  legacy_tag 'ln-es2'   — a second lane gets its own id as its tag
 *
 * Validated target rows, per lane:
 *   ln-es1: c1 only            -> one cell done
 *   ln-es2: c1 and c2          -> two cells done
 *
 * Both lanes hold a row for every assigned cell, so a read that loses the lane
 * predicate over-counts rather than under-counts — the AQU-1278 failure.
 *
 * Assignments, both over c1 + c2:
 *   as-one  anna, lane ln-es1
 *   as-two  bob,  lane ln-es2
 *   as-drift anna, lane ln-es1 but target_lang 'es-MX' — a STALE tag, naming
 *            no lane in this project. Every id-keyed read still resolves it.
 *
 * `lane_id` is supplied explicitly throughout: the harness's lane-fill trigger
 * only mints one when the column is blank, so these rows are the real thing.
 */
async function seedTwoSameLanguageLanes(): Promise<void> {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(3, "bob")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1), (1, 3, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pb', 'Acts', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pb', 1, 700, 1), ('pb', 2, 400, 1), ('pb', 3, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e-pb', 1, 'pb', 'file.create', 'wendi', '{}', 1000, 1000, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, event_id) VALUES ('f1', 'pb', 'acts.usfm', 'e-pb')",
  ).run()

  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position) VALUES
      ('ln-src', 'pb', 'source', 'Greek',   'el', NULL,      0),
      ('ln-es1', 'pb', 'target', 'Spanish', 'es', 'Spanish', 1),
      ('ln-es2', 'pb', 'target', 'Spanish — Mexico', 'es', 'ln-es2', 2)`,
  ).run()

  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, event_id, last_edit_at, canonical_ref) VALUES ('pb', 'f1', 'c1', 'source', 'ln-src', 's', 'e-pb', 1, 'ACT 1:1'), ('pb', 'f1', 'c2', 'source', 'ln-src', 's', 'e-pb', 1, 'ACT 1:2')`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, event_id, last_edit_at, endorsement_count, validated) VALUES ('pb', 'f1', 'c1', 'target', 'ln-es1', 'uno', 'e-pb', 1, 1, 1), ('pb', 'f1', 'c2', 'target', 'ln-es1', 'dos', 'e-pb', 1, 0, 0), ('pb', 'f1', 'c1', 'target', 'ln-es2', 'uno mx', 'e-pb', 1, 1, 1), ('pb', 'f1', 'c2', 'target', 'ln-es2', 'dos mx', 'e-pb', 1, 1, 1)`,
  ).run()

  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignments (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, lane_id, cells_total, created_by, created_at) VALUES ('as-one', 'pb', 2, 'books', 'Acts', 'ln-es1', 2, 1, 1000), ('as-two', 'pb', 3, 'books', 'Acts', 'ln-es2', 2, 1, 1100), ('as-drift', 'pb', 2, 'books', 'Acts', 'ln-es1', 2, 1, 1200)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES
      ('as-one','f1','c1'), ('as-one','f1','c2'),
      ('as-two','f1','c1'), ('as-two','f1','c2'),
      ('as-drift','f1','c1'), ('as-drift','f1','c2')`,
  ).run()
}

describe("AQU-1609: assignment progress counts by lane id", () => {
  // The ticket's acceptance criterion, pinned. This one passes on the tag-keyed
  // reads too — `planNewTargetLane` gave ln-es2 its own id as its tag, so the
  // tags happen to differ. That is the guarantee this ticket removes the
  // dependence on; the four cases below are the ones that were broken.
  it("gives each of two same-language lanes its own cellsDone", async () => {
    await seedTwoSameLanguageLanes()
    const rows = await getOrgAssignmentWorkload(testEnv, 1)
    const byId = Object.fromEntries(rows.map((r) => [r.assignmentId, r]))

    // Both assignments cover the same two cells, and both lanes hold a target
    // row for each — so cellsTotal is 2 either way and only the lane predicate
    // separates the numerators.
    expect(byId["as-one"]).toMatchObject({ cellsTotal: 2, cellsDone: 1, laneId: "ln-es1" })
    expect(byId["as-two"]).toMatchObject({ cellsTotal: 2, cellsDone: 2, laneId: "ln-es2" })
  })

  it("counts an assignment whose target_lang tag is stale, by its lane id", async () => {
    await seedTwoSameLanguageLanes()
    const rows = await getOrgAssignmentWorkload(testEnv, 1)
    const drift = rows.find((r) => r.assignmentId === "as-drift")

    // 'es-MX' names no lane in this project, so a tag-keyed count reads zero
    // and the assignee's finished work vanishes off the manager's screen. The
    // lane id still says ln-es1, where exactly one of the two cells is done.
    expect(drift).toMatchObject({ laneId: "ln-es1", cellsTotal: 2, cellsDone: 1 })
  })

  it("resolves the lane's display name through lane_id, not the tag", async () => {
    await seedTwoSameLanguageLanes()
    const rows = await getOrgAssignmentWorkload(testEnv, 1)
    const byId = Object.fromEntries(rows.map((r) => [r.assignmentId, r]))

    expect(byId["as-one"]!.laneName).toBe("Spanish")
    expect(byId["as-two"]!.laneName).toBe("Spanish — Mexico")
    // The stale-tag row used to join no lane at all and label as unnamed.
    expect(byId["as-drift"]!.laneName).toBe("Spanish")
  })

  it("keeps laneId on the inbox row when the tag names no lane", async () => {
    await seedTwoSameLanguageLanes()
    const mine = await getMyAssignments(testEnv, "pb", 2)
    const byId = Object.fromEntries(mine.map((r) => [r.assignmentId, r]))

    // laneId feeds a deep link. Taken off the lanes join it was null here, so
    // the link dropped the lane and opened whichever one the client defaulted
    // to — someone else's work, under this person's name.
    expect(byId["as-drift"]).toMatchObject({ laneId: "ln-es1", laneName: "Spanish", cellsDone: 1 })
    expect(byId["as-one"]).toMatchObject({ laneId: "ln-es1", cellsDone: 1 })
  })

  it("scopes the per-unit read's four counts to the lane id it was given", async () => {
    await seedTwoSameLanguageLanes()

    const es1 = await getUnitAssignments(testEnv, "pb", "f1", "ACT", "ln-es1")
    const es2 = await getUnitAssignments(testEnv, "pb", "f1", "ACT", "ln-es2")

    // Every assignment on the unit appears in both tabs (AQU-1278: the cells
    // are spoken for whichever lane you are looking at) — what changes is the
    // lane the counts are measured in.
    const es1One = es1.find((r) => r.assignmentId === "as-one")
    expect(es1One).toMatchObject({ cellsTotal: 2, translated: 2, validated: 1, laneId: "ln-es1" })

    const es2One = es2.find((r) => r.assignmentId === "as-one")
    expect(es2One).toMatchObject({ cellsTotal: 2, translated: 2, validated: 2, laneId: "ln-es1" })

    // And a lane id matching no cells reads zero rather than borrowing a lane.
    const none = await getUnitAssignments(testEnv, "pb", "f1", "ACT", "")
    expect(none.find((r) => r.assignmentId === "as-one")).toMatchObject({
      cellsTotal: 2,
      translated: 0,
      validated: 0,
    })
  })
})

describe("AQU-1609: GET /assignments/unit identifies the lane by id", () => {
  it("measures the counts in the lane `laneId` names", async () => {
    await seedTwoSameLanguageLanes()
    const res = await app.request(
      "/api/v2/projects/pb/assignments/unit?fileId=f1&section=ACT&laneId=ln-es2",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assignments: Array<{ assignmentId: string; validated: number }> }
    // ln-es2 has both cells validated, so as-one — pinned to ln-es1 — still
    // reports 2 validated here: the tab's lane decides the counts, the
    // assignment's own lane decides nothing but its label (AQU-1278).
    expect(body.assignments.find((a) => a.assignmentId === "as-one")?.validated).toBe(2)
  })

  it("still accepts a legacy `lane` tag, resolving it to that lane", async () => {
    await seedTwoSameLanguageLanes()
    const res = await app.request(
      "/api/v2/projects/pb/assignments/unit?fileId=f1&section=ACT&lane=Spanish",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assignments: Array<{ assignmentId: string; validated: number }> }
    // 'Spanish' is ln-es1's legacy tag, where only c1 is validated. A client
    // built before `laneId` keeps reading the same numbers it always did.
    expect(body.assignments.find((a) => a.assignmentId === "as-one")?.validated).toBe(1)
  })

  it("treats an empty laneId as absent and falls back to the lane tag", async () => {
    await seedTwoSameLanguageLanes()
    const res = await app.request(
      "/api/v2/projects/pb/assignments/unit?fileId=f1&section=ACT&laneId=&lane=Spanish",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assignments: Array<{ assignmentId: string; validated: number }> }
    // No lane has the id '', so honouring an empty laneId literally would read
    // every count as zero and look like nobody had done any work.
    expect(body.assignments.find((a) => a.assignmentId === "as-one")?.validated).toBe(1)
  })

  it("prefers laneId over a lane tag naming a different lane", async () => {
    await seedTwoSameLanguageLanes()
    const res = await app.request(
      "/api/v2/projects/pb/assignments/unit?fileId=f1&section=ACT&laneId=ln-es2&lane=Spanish",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assignments: Array<{ assignmentId: string; validated: number }> }
    // The id wins, so this reads ln-es2's two. A reader that took the tag would
    // report ln-es1's one and look merely stale rather than wrong.
    expect(body.assignments.find((a) => a.assignmentId === "as-one")?.validated).toBe(2)
  })
})

// AQU-1493 x AQU-1609: CELLS_DONE_SUBQUERY has two copies — one for a project
// that counts headings and one for a project that leaves them out — and the
// rebase onto AQU-1609 had to move the second one onto lane ids by hand. The
// test above only ever takes the first copy (no setting means "count them"),
// so nothing else notices if the headings-off copy drifts back onto the tag.
//
// Two same-language lanes on their own cannot tell the copies apart: ln-es2's
// tag is its own id, so its tag and its id pick out the same rows. What does is
// an assignment whose tag no longer names its lane — as-drift, pinned to ln-es1
// but still tagged 'es-MX'. A tag-matched count finds none of its lines.
describe("AQU-1493: an assignee's progress without headings matches lines by lane id", () => {
  it("counts only the assignment's own lane's validated lines when headings are left out", async () => {
    await seedTwoSameLanguageLanes()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings) VALUES ('pb', '{"countStructuralCells":false}')`,
    ).run()
    // A heading in the book, assigned with it and validated in BOTH lanes. With
    // headings left out it counts on neither side — which is how the test knows
    // the read took the headings-excluded copy.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, type, event_id, last_edit_at, canonical_ref) VALUES ('pb', 'f1', 'h1', 'source', 'ln-src', 'Acts', 'heading', 'e-pb', 1, 'ACT 1:0')`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, event_id, last_edit_at, endorsement_count, validated) VALUES ('pb', 'f1', 'h1', 'target', 'ln-es1', 'Hechos', 'e-pb', 1, 1, 1), ('pb', 'f1', 'h1', 'target', 'ln-es2', 'Hechos', 'e-pb', 1, 1, 1)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES
        ('as-one','f1','h1'), ('as-two','f1','h1'), ('as-drift','f1','h1')`,
    ).run()

    const rows = await getOrgAssignmentWorkload(testEnv, 1)
    const byId = Object.fromEntries(rows.map((r) => [r.assignmentId, r]))

    // ln-es1 has c1 validated, ln-es2 has c1 and c2; the heading counts nowhere.
    expect(byId["as-one"]).toMatchObject({ cellsTotal: 2, cellsDone: 1 })
    expect(byId["as-two"]).toMatchObject({ cellsTotal: 2, cellsDone: 2 })
    // The case that tells the copies apart: by its lane, as-drift has c1 done;
    // by its stale tag it has nothing, and a finished line drops off the
    // manager's screen only while the team leaves headings out.
    expect(byId["as-drift"]).toMatchObject({ laneId: "ln-es1", cellsTotal: 2, cellsDone: 1 })
  })
})
