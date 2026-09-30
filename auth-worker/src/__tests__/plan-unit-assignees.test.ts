// AQU-1278, round 6: who is on EVERY planning unit of a project, in one read —
// what the plan board draws its avatar chips from. Until this existed a row
// could only learn its people from the per-unit read the inspector fires, so
// the chips appeared once a unit had been opened and never before.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { getProjectUnitAssignees } from "../services/assignments"
import type { Env } from "../types"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const testEnv = env as unknown as Env

// Org 1: wendi (owner 700), anna + bob + cara (contributors 400), outsider.
// Project 'pa' holds TWO files:
//   f1  a Scripture file with book rows GEN and EXO in file_section_progress,
//       so its units are the books;
//   f2  a memo with no section rows at all, so its unit is the file ('').
// Assignments:
//   as-anna   anna, LIVE,       g1 g2      (GEN)
//   as-bob    bob,  LIVE,       g3 x1      (GEN and EXO — one person, two units)
//   as-cara   cara, LIVE,       m1         (the memo)
//   as-old    anna, UNASSIGNED, x2         (must never appear)
//   as-done   cara, COMPLETED,  x2         (must never appear)
//   as-anna-2 anna, LIVE,       g3         (a second assignment on GEN: one face)
async function seed(): Promise<void> {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(3, "bob")
  await seedUser(4, "cara")
  await seedUser(9, "outsider")
  const db = env.AQUILLA_PG
  await db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
  await db.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1), (1, 3, 400, 1), (1, 4, 400, 1)",
  ).run()
  await db.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
  await db.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 1, 700, 1), ('pa', 2, 400, 1), ('pa', 3, 400, 1), ('pa', 4, 400, 1)",
  ).run()
  await db.prepare(
    "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e-pa', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)",
  ).run()
  await db.prepare(
    "INSERT INTO files (id, project_id, name, event_id) VALUES ('f1', 'pa', 'bible.usfm', 'e-pa'), ('f2', 'pa', 'memo.docx', 'e-pa')",
  ).run()
  // The book rows are what make f1's units its books — the same rows the
  // board's own unit list is read from.
  await db.prepare(
    `INSERT INTO file_section_progress (project_id, file_id, scope, section_key, target_lang, updated_at) VALUES
      ('pa','f1','book','GEN','',1), ('pa','f1','book','EXO','',1), ('pa','f1','file','','',1),
      ('pa','f2','file','','',1)`,
  ).run()
  await db.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, canonical_ref) VALUES
      ('pa','f1','g1','source','s','e-pa',1,'GEN 1:1'),
      ('pa','f1','g2','source','s','e-pa',1,'GEN 1:2'),
      ('pa','f1','g3','source','s','e-pa',1,'GEN 2:1'),
      ('pa','f1','x1','source','s','e-pa',1,'EXO 1:1'),
      ('pa','f1','x2','source','s','e-pa',1,'EXO 1:2'),
      ('pa','f2','m1','source','s','e-pa',1,NULL)`,
  ).run()
  await db.prepare(
    `INSERT INTO assignments (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, target_lang, cells_total, deadline, created_by, created_at, unassigned_at, completed_at) VALUES
      ('as-anna',   'pa', 2, 'cells', 'GEN 1',   '', 2, NULL, 1, 1000, NULL, NULL),
      ('as-bob',    'pa', 3, 'cells', 'mixed',   '', 2, NULL, 1, 1100, NULL, NULL),
      ('as-cara',   'pa', 4, 'files', 'memo',    '', 1, NULL, 1, 1200, NULL, NULL),
      ('as-old',    'pa', 2, 'cells', 'EXO 1:2', '', 1, NULL, 1,  900, 1500, NULL),
      ('as-done',   'pa', 4, 'cells', 'EXO 1:2', '', 1, NULL, 1,  950, NULL, 1600),
      ('as-anna-2', 'pa', 2, 'cells', 'GEN 2',   '', 1, NULL, 1, 1300, NULL, NULL)`,
  ).run()
  await db.prepare(
    `INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES
      ('as-anna','f1','g1'), ('as-anna','f1','g2'),
      ('as-bob','f1','g3'), ('as-bob','f1','x1'),
      ('as-cara','f2','m1'),
      ('as-old','f1','x2'),
      ('as-done','f1','x2'),
      ('as-anna-2','f1','g3')`,
  ).run()
}

describe("getProjectUnitAssignees (AQU-1278 board chips)", () => {
  it("names every person on every unit, one row per person, live assignments only", async () => {
    await seed()
    const rows = await getProjectUnitAssignees(testEnv, "pa")
    const byUnit = new Map<string, string[]>()
    for (const r of rows) {
      const key = `${r.fileId}:${r.sectionKey}`
      byUnit.set(key, [...(byUnit.get(key) ?? []), r.username ?? "?"])
    }
    // anna holds two assignments on GEN and is one face; bob spans two units.
    expect(byUnit.get("f1:GEN")).toEqual(["anna", "bob"])
    expect(byUnit.get("f1:EXO")).toEqual(["bob"])
    // A file with no book rows is one unit, keyed ''.
    expect(byUnit.get("f2:")).toEqual(["cara"])
    // as-old (unassigned) and as-done (completed) sat on x2 and are gone.
    expect(rows.some((r) => r.sectionKey === "EXO" && r.username !== "bob")).toBe(false)
    expect(rows).toHaveLength(4)
  })

  it("drops a person whose whole assignment is structural, under the exclude policy", async () => {
    // dana holds only GEN's chapter heading. With the org excluding
    // structural cells, that heading counts for nothing — so dana must not
    // appear as a face on GEN. erin holds an UNTYPED cell: a null type means
    // content, and the COALESCE in the policy predicate is what keeps
    // NOT (NULL IN (...)) from silently dropping her row too.
    await seed()
    const db = testEnv.AQUILLA_PG
    await db.prepare(
      `INSERT INTO org_settings (org_id, settings) VALUES (1, '{"countStructuralCells":false}')`,
    ).run()
    await seedUser(5, "dana")
    await seedUser(6, "erin")
    await db.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, canonical_ref, type) VALUES
        ('pa','f1','gh','source','Genesis 1','e-pa',1,'GEN 1:0','heading'),
        ('pa','f1','gu','source','words','e-pa',1,'GEN 1:3',NULL)`,
    ).run()
    await db.prepare(
      `INSERT INTO assignments (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, target_lang, cells_total, deadline, created_by, created_at) VALUES
        ('as-dana', 'pa', 5, 'cells', 'GEN heading', '', 1, NULL, 1, 1400),
        ('as-erin', 'pa', 6, 'cells', 'GEN 1:3',     '', 1, NULL, 1, 1450)`,
    ).run()
    await db.prepare(
      `INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES
        ('as-dana','f1','gh'), ('as-erin','f1','gu')`,
    ).run()

    const gen = (await getProjectUnitAssignees(testEnv, "pa")).filter((r) => r.sectionKey === "GEN")
    const names = gen.map((r) => r.username)
    expect(names).not.toContain("dana")
    expect(names).toContain("erin")

    // With the policy counting structural cells, dana is real work again.
    await db.prepare(
      `UPDATE org_settings SET settings = '{"countStructuralCells":true}' WHERE org_id = 1`,
    ).run()
    const counted = (await getProjectUnitAssignees(testEnv, "pa")).filter((r) => r.sectionKey === "GEN")
    expect(counted.map((r) => r.username)).toContain("dana")
  })

  it("lists the newest assignment's person first within a unit", async () => {
    await seed()
    const gen = (await getProjectUnitAssignees(testEnv, "pa")).filter((r) => r.sectionKey === "GEN")
    // anna's newest assignment (as-anna-2, 1300) outranks bob's (1100).
    expect(gen.map((r) => r.username)).toEqual(["anna", "bob"])
  })
})

describe("GET /api/v2/projects/:id/assignments/units", () => {
  it("answers a maintainer+ caller with every unit's people", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/projects/pa/assignments/units",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assignees: Array<{ fileId: string; sectionKey: string; username: string }> }
    expect(body.assignees.map((a) => `${a.fileId}:${a.sectionKey}=${a.username}`).sort()).toEqual([
      "f1:EXO=bob", "f1:GEN=anna", "f1:GEN=bob", "f2:=cara",
    ])
  })

  it("sits behind the org's member-progress floor, the same as the per-unit read", async () => {
    await seed()
    // anna is a contributor (400) and the default floor is 600.
    const denied = await app.request(
      "/api/v2/projects/pa/assignments/units",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(denied.status).toBe(403)

    // Lowering the PROGRESS floor alone is not enough: this response carries
    // usernames, and who may learn who is on a project is the ROSTER floor's
    // question (AQU-485). Both default to maintainer, so a default org is
    // unaffected; an org that lowers only one was handing out names the
    // members route refuses.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_settings (org_id, settings) VALUES (1, '{\"memberProgressViewMinRole\":400}')",
    ).run()
    const progressOnly = await app.request(
      "/api/v2/projects/pa/assignments/units",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(progressOnly.status).toBe(403)

    await env.AQUILLA_PG.prepare(
      "UPDATE org_settings SET settings = '{\"memberProgressViewMinRole\":400,\"rosterViewMinRole\":400}' WHERE org_id = 1",
    ).run()
    const allowed = await app.request(
      "/api/v2/projects/pa/assignments/units",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(allowed.status).toBe(200)
  })

  it("403s a non-member", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/projects/pa/assignments/units",
      { headers: authHeader(await jwtFor("outsider")) },
      env,
    )
    expect(res.status).toBe(403)
  })
})
