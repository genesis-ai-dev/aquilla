// AQU-1278: the plan inspector's "Assigned to" read — every live assignment
// covering ONE planning unit, with each assignee's own progress inside it.
//
// The unit is (project, file, sectionKey, lane): sectionKey '' is the whole
// file, a book code is the Bible book inside it. Membership is decided by the
// SAME SQL the progress projection builds its book rows from
// (db/shared/plan-keys.ts), because this panel's numbers sit directly under
// bars drawn from those rows.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { getUnitAssignments } from "../services/assignments"
import type { Env } from "../types"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const testEnv = env as unknown as Env

// Org 1: wendi (owner 700), anna + bob (contributors 400), outsider (nobody).
// Project 'pa', one file 'f1' holding two books.
//
// Source cells:  GEN 1:1 (g1), GEN 1:2 (g2), GEN 2:1 (g3) | EXO 1:1 (x1), EXO 1:2 (x2)
// Assignments:
//   as-anna      anna, LIVE,        g1 g2 g3  (all of GEN)
//   as-bob       bob,  LIVE,        x1 x2     (all of EXO)
//   as-anna-old  anna, UNASSIGNED,  g1        (must never appear)
//   as-cara-done cara, COMPLETED,   g2        (must never appear)
//
// Default-lane ('') targets: g1 translated + endorsed once, g2 translated but
// unendorsed, g3 has no target row at all, x1 translated.
// Spanish-lane ('es') targets: g1 AND g2 translated and endorsed — the lane
// that used to double-count.
//
// Audio (lane-independent by construction — cell_audio has no target_lang):
//   g1: TWO live takes, one of them selected + approved  → recorded, validated
//   g2: one live selected take, not approved             → recorded only
//   g3: one DELETED take                                 → neither
async function seedUnit(): Promise<void> {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(3, "bob")
  await seedUser(4, "cara")
  await seedUser(9, "outsider")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1), (1, 3, 400, 1), (1, 4, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 1, 700, 1), ('pa', 2, 400, 1), ('pa', 3, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e-pa', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, event_id) VALUES ('f1', 'pa', 'bible.usfm', 'e-pa')",
  ).run()

  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, canonical_ref) VALUES
      ('pa','f1','g1','source','s','e-pa',1,'GEN 1:1'),
      ('pa','f1','g2','source','s','e-pa',1,'GEN 1:2'),
      ('pa','f1','g3','source','s','e-pa',1,'GEN 2:1'),
      ('pa','f1','x1','source','s','e-pa',1,'EXO 1:1'),
      ('pa','f1','x2','source','s','e-pa',1,'EXO 1:2')`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at, endorsement_count, validated) VALUES
      ('pa','f1','g1','target','',  'draft','e-pa',1,1,1),
      ('pa','f1','g2','target','',  'draft','e-pa',1,0,0),
      ('pa','f1','x1','target','',  'draft','e-pa',1,0,0),
      ('pa','f1','g1','target','es','borrador','e-pa',1,1,1),
      ('pa','f1','g2','target','es','borrador','e-pa',1,1,1)`,
  ).run()

  await env.AQUILLA_PG.prepare(
    `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, selected, approved, deleted, event_id, created_ts) VALUES
      ('pa','f1','g1','take-1','main','r2://1',1,1,0,'e-pa',1),
      ('pa','f1','g1','take-2','main','r2://2',0,0,0,'e-pa',2),
      ('pa','f1','g2','take-3','main','r2://3',1,0,0,'e-pa',3),
      ('pa','f1','g3','take-4','main','r2://4',1,1,1,'e-pa',4)`,
  ).run()

  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignments (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, target_lang, cells_total, deadline, created_by, created_at, unassigned_at, completed_at) VALUES
      ('as-anna',      'pa', 2, 'books', 'Genesis', '', 3, '2026-10-01', 1, 1000, NULL, NULL),
      ('as-bob',       'pa', 3, 'books', 'Exodus',  '', 2, NULL,         1, 1100, NULL, NULL),
      ('as-anna-old',  'pa', 2, 'books', 'Genesis', '', 1, NULL,         1,  900, 1500, NULL),
      ('as-cara-done', 'pa', 4, 'books', 'Genesis', '', 1, NULL,         1,  950, NULL, 1600)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES
      ('as-anna','f1','g1'), ('as-anna','f1','g2'), ('as-anna','f1','g3'),
      ('as-bob','f1','x1'), ('as-bob','f1','x2'),
      ('as-anna-old','f1','g1'),
      ('as-cara-done','f1','g2')`,
  ).run()
}

describe("getUnitAssignments (AQU-1278 plan inspector)", () => {
  it("scopes a book unit to that book's assignments only", async () => {
    await seedUnit()
    const rows = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "")
    // as-bob's cells are all EXO, so it is not work on this unit at all.
    expect(rows.map((r) => r.assignmentId)).toEqual(["as-anna"])
    expect(rows[0]).toMatchObject({
      assigneeUserId: 2,
      username: "anna",
      scopeLabel: "Genesis",
      targetLang: "",
      deadline: "2026-10-01",
    })
  })

  it("takes the whole file for a file-grain unit ('')", async () => {
    await seedUnit()
    const rows = await getUnitAssignments(testEnv, "pa", "f1", "", "")
    // A file-grain unit IS the file, so both books' assignments belong to it.
    // Newest first, as with every other assignment read.
    expect(rows.map((r) => r.assignmentId)).toEqual(["as-bob", "as-anna"])
  })

  it("excludes unassigned and completed assignments", async () => {
    await seedUnit()
    const rows = await getUnitAssignments(testEnv, "pa", "f1", "", "")
    const ids = rows.map((r) => r.assignmentId)
    // as-anna-old was unassigned, as-cara-done was marked complete. Both still
    // have assignment_cells rows covering this unit; neither is live work.
    expect(ids).not.toContain("as-anna-old")
    expect(ids).not.toContain("as-cara-done")
  })

  it("limits all four counts to that assignment's own cells inside the unit", async () => {
    await seedUnit()
    const [anna] = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "")
    expect(anna).toMatchObject({
      // g1 g2 g3 — anna's three, not the file's five.
      cellsTotal: 3,
      // g1 + g2 have default-lane target text; g3 has no target row.
      translated: 2,
      // Only g1 is endorsed to the project's threshold (default 1).
      validated: 1,
      // g1 (two live takes) + g2 (one). Two takes on one cell is ONE recorded
      // cell — cell_audio keys on four columns where cells keys on five, so a
      // take-level join would fan every count out by the number of takes.
      recorded: 2,
      // Only g1's SELECTED take is approved; g2's selected take is not, and
      // g3's only take is deleted.
      audioValidated: 1,
    })
    // The fan-out guard, stated as its own assertion: two takes on g1 must not
    // inflate the denominator either.
    expect(anna.cellsTotal).toBe(3)
  })

  it("counts a cell validated in two lanes ONCE, in the lane being shown", async () => {
    await seedUnit()
    // g1 is endorsed in BOTH '' and 'es'; g2 only in 'es'. Without a
    // target_lang predicate on the target join, the default lane would see g1
    // twice and count g2 as validated — 3 validated out of 3 cells, a unit
    // reading finished while two thirds of its default-lane work is untouched.
    const [defaultLane] = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "")
    expect(defaultLane).toMatchObject({ cellsTotal: 3, translated: 2, validated: 1 })

    // The Spanish lane is its own answer over the same cells: both g1 and g2
    // are translated and endorsed there.
    const [spanish] = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "es")
    expect(spanish).toMatchObject({ cellsTotal: 3, translated: 2, validated: 2 })

    // Audio has no lane to pick, so it reads the same from either.
    expect(spanish.recorded).toBe(defaultLane.recorded)
    expect(spanish.audioValidated).toBe(defaultLane.audioValidated)
  })

  it("honours the project's CURRENT validation threshold, not the stamped flag", async () => {
    await seedUnit()
    // The bars compute validated live against validationCount; raising it must
    // move this panel too, or the two numbers on one screen disagree. g1 is
    // endorsed once and its cells.validated flag says 1 — at a threshold of 2
    // it is no longer validated.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings) VALUES ('pa', '{\"validationCount\":2}')",
    ).run()
    const [anna] = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "")
    expect(anna.validated).toBe(0)
    expect(anna.translated).toBe(2)
  })

  it("follows the project's headings policy, so its total matches the bar above it", async () => {
    // AQU-1083 lets a team decide whether chapter headings and section titles
    // count as translatable content, and the plan bar this panel sits under has
    // them subtracted whenever they do not. A heading counted here and not
    // there would read as "anna: 3 of 4" beneath a bar drawn over 3 — one
    // screen, two denominators, nothing saying why.
    await seedUnit()
    // A heading inside GEN, inside anna's assignment.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, type, event_id, last_edit_at, canonical_ref)
       VALUES ('pa','f1','gh','source','Chapter 1','heading','e-pa',1,'GEN 1:0')`,
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES ('as-anna','f1','gh')",
    ).run()

    // Unset: headings count, exactly as they did before the setting existed.
    const counting = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "")
    expect(counting[0].cellsTotal).toBe(4)

    // The project opts out; its own answer wins over the org's.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings) VALUES ('pa', '{"countStructuralCells":false}')
       ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
    ).run()
    const excluding = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "")
    expect(excluding[0].cellsTotal).toBe(3)
  })

  it("inherits the ORG's headings policy when the project has no answer", async () => {
    await seedUnit()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, type, event_id, last_edit_at, canonical_ref)
       VALUES ('pa','f1','gh','source','Chapter 1','heading','e-pa',1,'GEN 1:0')`,
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES ('as-anna','f1','gh')",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO org_settings (org_id, settings) VALUES (1, '{"countStructuralCells":false}')
       ON CONFLICT (org_id) DO UPDATE SET settings = EXCLUDED.settings`,
    ).run()
    const rows = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "")
    expect(rows[0].cellsTotal).toBe(3)
  })

  it("counts nothing for an assignment whose cells were removed from the file", async () => {
    await seedUnit()
    // There is no DELETE FROM assignment_cells anywhere, so the rows outlive
    // the cells (AQU-1068). Deriving from `cells` makes them invisible.
    await env.AQUILLA_PG.prepare(
      "DELETE FROM cells WHERE project_id = 'pa' AND file_id = 'f1' AND cell_id IN ('g1','g2','g3')",
    ).run()
    const rows = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "")
    expect(rows).toHaveLength(0)
  })
})

// AQU-1278. The panel used to be able to say how much of a unit a person still
// owed, but never WHERE — and the unit could not say which of its chapters
// nobody held at all, because the read had already aggregated the answer away.
describe("per-chapter coverage on a unit's assignments", () => {
  it("names the chapters each assignment covers, in canonical order", async () => {
    await seedUnit()
    const [anna] = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "")
    expect(anna.chapters.map((c) => c.key)).toEqual(["GEN 1", "GEN 2"])
    expect(anna.chapters).toEqual([
      // g1 and g2: both translated, g1 endorsed, both recorded, g1 signed off.
      { key: "GEN 1", total: 2, translated: 2, validated: 1, recorded: 2, audioValidated: 1 },
      // g3: a source cell with no target row and only a DELETED take.
      { key: "GEN 2", total: 1, translated: 0, validated: 0, recorded: 0, audioValidated: 0 },
    ])
  })

  it("keeps every aggregate equal to the sum of its chapters", async () => {
    await seedUnit()
    // The fold's own invariant. A GROUP BY that gained a column without the
    // sum-back would leave the panel's headline numbers reading one chapter's
    // worth of work instead of the assignment's.
    for (const a of await getUnitAssignments(testEnv, "pa", "f1", "", "")) {
      const sum = (pick: (c: (typeof a.chapters)[number]) => number) =>
        a.chapters.reduce((n, c) => n + pick(c), 0)
      expect(a.cellsTotal).toBe(sum((c) => c.total))
      expect(a.translated).toBe(sum((c) => c.translated))
      expect(a.validated).toBe(sum((c) => c.validated))
      expect(a.recorded).toBe(sum((c) => c.recorded))
      expect(a.audioValidated).toBe(sum((c) => c.audioValidated))
    }
  })

  it("orders chapters numerically, so GEN 10 follows GEN 2", async () => {
    await seedUnit()
    // Lexically "GEN 10" sorts between "GEN 1" and "GEN 2", and the caller
    // takes chapters[0] as THE chapter to name on the row — so a lexical sort
    // would point a reader at the wrong one.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, canonical_ref)
       VALUES ('pa','f1','g10','source','s','e-pa',1,'GEN 10:1')`,
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES ('as-anna','f1','g10')",
    ).run()
    const [anna] = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "")
    expect(anna.chapters.map((c) => c.key)).toEqual(["GEN 1", "GEN 2", "GEN 10"])
  })

  it("measures each chapter in the lane being shown", async () => {
    await seedUnit()
    // Same cells, two answers. g1 and g2 are both endorsed in Spanish; only g1
    // is in the default lane. A chapter row that lost its lane predicate would
    // report GEN 1 fully validated on the tab where it is half done.
    const [def] = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "")
    const [es] = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "es")
    expect(def.chapters[0]).toMatchObject({ key: "GEN 1", translated: 2, validated: 1 })
    expect(es.chapters[0]).toMatchObject({ key: "GEN 1", translated: 2, validated: 2 })
    // Audio has no lane to pick, so it reads the same from either tab.
    expect(def.chapters[0].recorded).toBe(es.chapters[0].recorded)
  })

  it("drops a chapter the headings policy empties and keeps one that is merely untyped", async () => {
    await seedUnit()
    // GEN 3 is nothing but a heading; GEN 4 is a spreadsheet import the
    // classifier could not label. Excluding structure must empty the first and
    // leave the second — `NULL IN ('heading','paratext')` is NULL, and a
    // NOT over it drops the row exactly as a false would, so without the
    // COALESCE in the predicate GEN 4 disappears with GEN 3.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, type, event_id, last_edit_at, canonical_ref) VALUES
        ('pa','f1','g3h','source','Chapter 3','heading','e-pa',1,'GEN 3:0'),
        ('pa','f1','g4u','source','untyped',NULL,'e-pa',1,'GEN 4:1')`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES
        ('as-anna','f1','g3h'), ('as-anna','f1','g4u')`,
    ).run()

    const counting = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "")
    expect(counting[0].chapters.map((c) => c.key)).toEqual(["GEN 1", "GEN 2", "GEN 3", "GEN 4"])

    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings) VALUES ('pa', '{"countStructuralCells":false}')
       ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
    ).run()
    const excluding = await getUnitAssignments(testEnv, "pa", "f1", "GEN", "")
    expect(excluding[0].chapters.map((c) => c.key)).toEqual(["GEN 1", "GEN 2", "GEN 4"])
    expect(excluding[0].cellsTotal).toBe(4)
  })

  it("keeps each assignment's chapters to its own, across books", async () => {
    await seedUnit()
    // A file-grain unit holds both books. The GROUP BY carries the assignment,
    // so bob's Exodus chapters must not land in anna's list or the panel would
    // credit her with work she does not hold.
    const rows = await getUnitAssignments(testEnv, "pa", "f1", "", "")
    const byId = new Map(rows.map((r) => [r.assignmentId, r]))
    expect(byId.get("as-anna")!.chapters.map((c) => c.key)).toEqual(["GEN 1", "GEN 2"])
    expect(byId.get("as-bob")!.chapters.map((c) => c.key)).toEqual(["EXO 1"])
  })
})

describe("GET /api/v2/projects/:projectId/assignments/unit", () => {
  it("returns the unit's assignments to a maintainer+ caller", async () => {
    await seedUnit()
    const res = await app.request(
      "/api/v2/projects/pa/assignments/unit?fileId=f1&section=GEN&lane=",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      assignments: Array<{
        assignmentId: string; username: string; cellsTotal: number; validated: number
        chapters: Array<{ key: string }>
      }>
    }
    expect(body.assignments).toHaveLength(1)
    expect(body.assignments[0]).toMatchObject({
      assignmentId: "as-anna",
      username: "anna",
      cellsTotal: 3,
      validated: 1,
    })
    // AQU-1278: the per-chapter breakdown survives JSON serialisation — the
    // inspector reads WHERE the outstanding work is from exactly this.
    expect(body.assignments[0].chapters.map((c) => c.key)).toEqual(["GEN 1", "GEN 2"])
  })

  it("gates on the org's memberProgressViewMinRole, not a hard maintainer floor", async () => {
    await seedUnit()
    // anna is a contributor (400). The org default floor is 600, so she is out.
    const denied = await app.request(
      "/api/v2/projects/pa/assignments/unit?fileId=f1&section=GEN",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(denied.status).toBe(403)

    // The client's Team card renders per-member progress off this same setting.
    // Lower it and the server must follow, or the section renders and 403s.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_settings (org_id, settings) VALUES (1, '{\"memberProgressViewMinRole\":400}')",
    ).run()
    // Still 403: the rows name people, and the ROSTER floor decides who may
    // learn who is on a project. Independent key, same default (AQU-485).
    const progressOnly = await app.request(
      "/api/v2/projects/pa/assignments/unit?fileId=f1&section=GEN",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(progressOnly.status).toBe(403)

    await env.AQUILLA_PG.prepare(
      "UPDATE org_settings SET settings = '{\"memberProgressViewMinRole\":400,\"rosterViewMinRole\":400}' WHERE org_id = 1",
    ).run()
    const allowed = await app.request(
      "/api/v2/projects/pa/assignments/unit?fileId=f1&section=GEN",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(allowed.status).toBe(200)
  })

  it("403s a non-member and 400s a request with no fileId", async () => {
    await seedUnit()
    const outsider = await app.request(
      "/api/v2/projects/pa/assignments/unit?fileId=f1",
      { headers: authHeader(await jwtFor("outsider")) },
      env,
    )
    expect(outsider.status).toBe(403)

    const noFile = await app.request(
      "/api/v2/projects/pa/assignments/unit",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(noFile.status).toBe(400)
  })
})

describe("assignment progress is lane-scoped (AQU-1278 fix to CELLS_DONE_SUBQUERY)", () => {
  it("stops counting a cell validated in two lanes twice in the Team card roster", async () => {
    await seedUnit()
    // as-anna is pinned to the default lane. g1 is validated in '' AND 'es',
    // and g2 in 'es' only — so the un-laned subquery found three validated
    // target rows for a three-cell assignment and drew a full bar. Only g1 is
    // done in the lane anna was actually assigned.
    const res = await app.request(
      "/api/v2/projects/pa/assignments/all",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      roster: Array<{ userId: number; cellsTotal: number; cellsDone: number }>
    }
    const anna = body.roster.find((r) => r.userId === 2)
    expect(anna).toMatchObject({ cellsTotal: 3, cellsDone: 1 })
  })
})
