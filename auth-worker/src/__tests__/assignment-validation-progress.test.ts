// AQU-1969: a Validate assignment's progress is the assignee's OWN approvals in
// their scope — text and recordings — under the four rules Sam settled
// (2026-10-15): count their own approval, not whether the line is validated;
// lines with nothing to approve yet are waiting, not behind; lines they cannot
// approve leave the count; and "changed since" they approved is counted
// separately. Translate assignments read exactly as before.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { getUnitAssignments, resolveTargetLaneId } from "../services/assignments"
import { loadValidationProgress } from "../services/assignment-validation"
import type { Env } from "../types"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const testEnv = env as unknown as Env

// Org 1: wendi (owner), ana (validator), tom (translator), rex (another
// reviewer). Project 'pv', one Bible file 'f1': GEN 1:1–1:7 (c1–c7) and
// EXO 1:1 (c8).
//
// as-val  ana  VALIDATE  c1–c8   created 1000
// as-tr   tom  TRANSLATE c1–c8   created 1100
//
// Default-lane text, line by line, from ana's side:
//   c1  head h1, ana approved h1                     → validated
//   c2  head h2, ana approved an earlier edit        → left, changed since
//   c3  head h3, only rex approved (line IS validated) → left (rule 1)
//   c4  no translation row                           → waiting
//   c5  an empty translation                         → waiting
//   c6  head h6, last edited by ana, nobody approved → left; NOT HERS with self-validation off
//   c7  head h7, nobody approved                     → left
//   c8  no translation row                           → waiting
//
// Default-lane recordings:
//   c1  take a1 (sounding), ana approved it          → validated
//   c2  ana approved a2-old; a2-new now sounds       → left, changed since
//   c3  take a3 recorded by ana, rex approved it     → left; NOT HERS with audio self-validation off
//   c4–c8 no recording                               → waiting on a recording
async function seed(opts: { selfValidation?: boolean; selfValidationAudio?: boolean } = {}): Promise<void> {
  await seedUser(1, "wendi")
  await seedUser(2, "ana")
  await seedUser(3, "tom")
  await seedUser(4, "rex")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1), (1, 3, 400, 1), (1, 4, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pv', 'Torah', 1, 1)").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pv', 1, 700, 1), ('pv', 2, 400, 1), ('pv', 3, 400, 1), ('pv', 4, 400, 1)",
  ).run()
  if (opts.selfValidation !== undefined || opts.selfValidationAudio !== undefined) {
    await env.AQUILLA_PG.prepare("INSERT INTO project_settings (project_id, settings) VALUES ('pv', ?)")
      .bind(JSON.stringify({
        ...(opts.selfValidation !== undefined ? { allowSelfValidation: opts.selfValidation } : {}),
        ...(opts.selfValidationAudio !== undefined ? { allowSelfValidationAudio: opts.selfValidationAudio } : {}),
      }))
      .run()
  }
  await env.AQUILLA_PG.prepare(
    "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e-pv', 1, 'pv', 'file.create', 'wendi', '{}', 1000, 1000, 1)",
  ).run()
  await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id) VALUES ('f1', 'pv', 'torah.usfm', 'e-pv')").run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, canonical_ref) VALUES
      ('pv','f1','c1','source','s','e-pv',1,'GEN 1:1'),
      ('pv','f1','c2','source','s','e-pv',1,'GEN 1:2'),
      ('pv','f1','c3','source','s','e-pv',1,'GEN 1:3'),
      ('pv','f1','c4','source','s','e-pv',1,'GEN 1:4'),
      ('pv','f1','c5','source','s','e-pv',1,'GEN 1:5'),
      ('pv','f1','c6','source','s','e-pv',1,'GEN 1:6'),
      ('pv','f1','c7','source','s','e-pv',1,'GEN 1:7'),
      ('pv','f1','c8','source','s','e-pv',1,'EXO 1:1')`,
  ).run()
  const lane = "(SELECT aquilla_test_resolve_target_lane('pv', ''))"
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_editor, last_edit_at, endorsement_count, validated, lane_id) VALUES
      ('pv','f1','c1','target','one','h1','tom',1,1,1,${lane}),
      ('pv','f1','c2','target','two','h2','tom',1,0,0,${lane}),
      ('pv','f1','c3','target','three','h3','tom',1,1,1,${lane}),
      ('pv','f1','c5','target','  ','h5','tom',1,0,0,${lane}),
      ('pv','f1','c6','target','six','h6','ana',1,0,0,${lane}),
      ('pv','f1','c7','target','seven','h7','tom',1,0,0,${lane})`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cell_validators (project_id, file_id, cell_id, lane_id, event_id, username, decided_ts) VALUES
      ('pv','f1','c1',${lane},'h1','ana',10),
      ('pv','f1','c2',${lane},'h2-old','ana',10),
      ('pv','f1','c3',${lane},'h3','rex',10)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, selected, validator_count, deleted, event_id, created_ts, created_by) VALUES
      ('pv','f1','c1','a1','recording','r2://a1',1,1,0,'e-pv',1,'tom'),
      ('pv','f1','c2','a2-old','recording','r2://a2o',0,1,0,'e-pv',2,'tom'),
      ('pv','f1','c2','a2-new','recording','r2://a2n',1,0,0,'e-pv',3,'tom'),
      ('pv','f1','c3','a3','recording','r2://a3',1,1,0,'e-pv',4,'ana')`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cell_audio_validators (project_id, file_id, cell_id, audio_id, username, decided_ts) VALUES
      ('pv','f1','c1','a1','ana',10),
      ('pv','f1','c2','a2-old','ana',10),
      ('pv','f1','c3','a3','rex',10)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignments (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, cells_total, created_by, created_at, kind) VALUES
      ('as-val', 'pv', 2, 'books', 'Torah', 8, 1, 1000, 'validate'),
      ('as-tr', 'pv', 3, 'books', 'Torah', 8, 1, 1100, 'translate')`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignment_cells (assignment_id, file_id, cell_id)
     SELECT a, 'f1', c FROM unnest(ARRAY['as-val','as-tr']) a, unnest(ARRAY['c1','c2','c3','c4','c5','c6','c7','c8']) c`,
  ).run()
}

describe("loadValidationProgress (AQU-1969)", () => {
  it("counts the assignee's own approvals under all four rules, text and recordings", async () => {
    await seed()
    const progress = (await loadValidationProgress(testEnv, ["as-val"])).get("as-val")
    // Rule 1: c3 is a validated line (rex approved it), and it is not hers.
    // Rule 2: c4, c5 (blank) and c8 have nothing to approve yet.
    // Rule 4: c2 she approved before it was edited.
    expect(progress?.text).toEqual({ total: 8, validated: 1, waiting: 3, changed: 1 })
    // Audio: c1 approved; c2 approved a take that no longer sounds; c3 not
    // hers to approve only when the project says so; c4–c8 unrecorded.
    expect(progress?.audio).toEqual({ total: 8, validated: 1, waiting: 5, changed: 1 })
  })

  it("rule 3: with self-validation off, lines she last edited or recorded leave the count", async () => {
    await seed({ selfValidation: false, selfValidationAudio: false })
    const progress = (await loadValidationProgress(testEnv, ["as-val"])).get("as-val")
    // c6 (her edit) leaves the text count; c3 (her take) leaves the audio count.
    expect(progress?.text).toEqual({ total: 7, validated: 1, waiting: 3, changed: 1 })
    expect(progress?.audio).toEqual({ total: 7, validated: 1, waiting: 5, changed: 1 })
  })

  it("a vote in another language is not an approval in this one", async () => {
    await seed()
    // ana approves c7 — in Spanish. The assignment is the default language's.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, lane_id)
       VALUES ('pv','f1','c7','target','siete','h7-es',1,(SELECT aquilla_test_resolve_target_lane('pv', 'es')))`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cell_validators (project_id, file_id, cell_id, lane_id, event_id, username, decided_ts)
       VALUES ('pv','f1','c7',(SELECT aquilla_test_resolve_target_lane('pv', 'es')),'h7-es','ana',11)`,
    ).run()
    const progress = (await loadValidationProgress(testEnv, ["as-val"])).get("as-val")
    expect(progress?.text.validated).toBe(1)
  })

  it("leaves a translate assignment at zero rather than measuring it", async () => {
    await seed()
    const progress = await loadValidationProgress(testEnv, ["as-tr"])
    expect(progress.get("as-tr")?.text).toEqual({ total: 0, validated: 0, waiting: 0, changed: 0 })
  })
})

describe("the plan inspector's per-unit read (AQU-1969)", () => {
  it("measures a validate assignment inside the unit only", async () => {
    await seed()
    const laneId = await resolveTargetLaneId(testEnv, "pv", "")
    const rows = await getUnitAssignments(testEnv, "pv", "f1", "GEN", laneId)
    const val = rows.find((r) => r.assignmentId === "as-val")
    expect(val?.kind).toBe("validate")
    // c8 is Exodus: out of this unit, so one fewer line waiting.
    expect(val?.validation?.text).toEqual({ total: 7, validated: 1, waiting: 2, changed: 1 })
    // The translate assignment reads exactly as it always has.
    const tr = rows.find((r) => r.assignmentId === "as-tr")
    expect(tr?.kind).toBe("translate")
    expect(tr?.validation).toBeUndefined()
    expect(tr).toMatchObject({ cellsTotal: 7, translated: 5, validated: 2 })
  })
})

describe("the Team card, the org's Team workload and the inbox (AQU-1969)", () => {
  it("lists validate assignments apart from the translate roster, furthest behind first", async () => {
    await seed()
    // rex validates c1 only — one line left, so ana (four left) comes first
    // even though rex's assignment is newer.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO assignments (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, cells_total, created_by, created_at, kind)
       VALUES ('as-rex', 'pv', 4, 'books', 'Genesis 1:1', 1, 1, 2000, 'validate')`,
    ).run()
    await env.AQUILLA_PG.prepare("INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES ('as-rex', 'f1', 'c1')").run()

    const res = await app.request("/api/v2/projects/pv/assignments/all", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      roster: Array<{ userId: number; cellsTotal: number; cellsDone: number }>
      validations: Array<{ assignmentId: string; username: string; scopeLabel: string; validation: { text: { total: number; validated: number } } }>
    }
    // Translate work only: tom's eight lines, two validated by anyone.
    expect(body.roster).toEqual([expect.objectContaining({ userId: 3, cellsTotal: 8, cellsDone: 2 })])
    expect(body.validations.map((v) => v.assignmentId)).toEqual(["as-val", "as-rex"])
    expect(body.validations[0]).toMatchObject({ username: "ana", scopeLabel: "Torah", validation: { text: { total: 8, validated: 1 } } })
  })

  it("keeps the Team card behind the same floors as the rest of member progress", async () => {
    await seed()
    const res = await app.request("/api/v2/projects/pv/assignments/all", { headers: authHeader(await jwtFor("tom")) }, env)
    expect(res.status).toBe(403)
  })

  it("marks each workload row with its kind, and counts a validator's own approvals", async () => {
    await seed()
    const res = await app.request("/api/v2/orgs/1/assignments/workload", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      assignments: Array<{ assignmentId: string; kind: string; cellsTotal: number; cellsDone: number; validation?: unknown }>
    }
    const byId = Object.fromEntries(body.assignments.map((a) => [a.assignmentId, a]))
    expect(byId["as-tr"]).toMatchObject({ kind: "translate", cellsTotal: 8, cellsDone: 2 })
    expect(byId["as-tr"].validation).toBeUndefined()
    expect(byId["as-val"]).toMatchObject({
      kind: "validate",
      cellsTotal: 8,
      cellsDone: 1,
      validation: { text: { total: 8, validated: 1, waiting: 3, changed: 1 } },
    })
  })

  it("shows the validator their own approvals in their inbox, not everyone's", async () => {
    await seed()
    const res = await app.request("/api/v2/projects/pv/assignments/mine", { headers: authHeader(await jwtFor("ana")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assignments: Array<{ kind: string; cellsTotal: number; cellsDone: number }> }
    // Two lines of hers are validated (c1, c3), but only one by her.
    expect(body.assignments).toEqual([expect.objectContaining({ kind: "validate", cellsTotal: 8, cellsDone: 1 })])
  })
})
