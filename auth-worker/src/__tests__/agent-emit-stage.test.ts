// emit-stage.ts — staging is the agent's ONLY write surface, and it must be
// no more dangerous than the requesting user: role floors re-validated
// server-side (the prompt filter is for token economy, this is for safety),
// parents resolved against the LIVE chain head (a stale parent means the
// model drafted against superseded text), and provenance (ai_suggestion +
// agent_run_id) injected so every applied draft is attributable to its run.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import { stageEvents, type EmitStageContext, type StageOutcome } from "../lib/agent/emit-stage"
import { AliasMap } from "../lib/agent/compress"

const PROJECT = "11111111-1111-4111-8111-111111111111"
const FILE = "22222222-2222-4222-8222-222222222222"
const CELL = "33333333-3333-4333-8333-333333333333"
const SOURCE_HEAD = "44444444-4444-4444-8444-444444444444"
const TARGET_HEAD = "55555555-5555-4555-8555-555555555555"
const RUN_ID = "66666666-6666-4666-8666-666666666666"

function ctx(overrides: Partial<EmitStageContext> = {}): EmitStageContext {
  return {
    runId: RUN_ID,
    projectId: PROJECT,
    roleLevel: 400,
    lane: "",
    aliases: new AliasMap(),
    ...overrides,
  }
}

async function seedCellPair() {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
     VALUES (?, ?, ?, 'source', 'In the beginning', 'GEN 1:1', ?, 0),
            (?, ?, ?, 'target', 'old draft', 'GEN 1:1', ?, 0)`,
  )
    .bind(PROJECT, FILE, CELL, SOURCE_HEAD, PROJECT, FILE, CELL, TARGET_HEAD)
    .run()
}

/** AQU-1068: the project's cell-editing tier. Most tests here are about role
 *  floors, parents and provenance, so they opt the project in and let the new
 *  gate stay out of the way; the dedicated describe below drives it directly. */
async function seedCellEditingFloor(tier: string | null) {
  await env.AQUILLA_PG.prepare(`DELETE FROM project_settings WHERE project_id = ?`).bind(PROJECT).run()
  await env.AQUILLA_PG
    .prepare(`INSERT INTO project_settings (project_id, settings) VALUES (?, ?)`)
    .bind(PROJECT, JSON.stringify(tier ? { cellEditingFloor: tier } : {}))
    .run()
}

beforeEach(async () => {
  await seedCellPair()
  await seedCellEditingFloor("contributor")
})

describe("stageEvents — role floors (server-side re-validation)", () => {
  it("rejects target.cell.commit from a REVIEWER (300) — floor is CONTRIBUTOR (400)", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: FILE, cellId: CELL, payload: { value: "x" } }],
      ctx({ roleLevel: 300 }),
    )
    expect(result.proposal).toBeNull()
    expect(result.modelVerdictBlock).toContain("rejected: role too low")
    expect(result.modelVerdictBlock).toContain("requires contributor (400)")
  })

  it("allows cell.validate from a REVIEWER (300) but rejects it from a COMMENTER (200)", async () => {
    const ok = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "cell.validate", fileId: FILE, cellId: CELL, payload: {} }],
      ctx({ roleLevel: 300 }),
    )
    expect(ok.proposal).not.toBeNull()
    expect(ok.proposal!.events[0].payload.editEventId).toBe(TARGET_HEAD)

    const low = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "cell.validate", fileId: FILE, cellId: CELL, payload: {} }],
      ctx({ roleLevel: 200 }),
    )
    expect(low.proposal).toBeNull()
    expect(low.modelVerdictBlock).toContain("rejected: role too low")
  })

  it("rejects unknown event kinds", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "cells.update", payload: {} }],
      ctx({ roleLevel: 700 }),
    )
    expect(result.proposal).toBeNull()
    expect(result.modelVerdictBlock).toContain('unknown event kind "cells.update"')
  })
})

describe("stageEvents — chain resolution + staleness", () => {
  it("stages a commit with resolved parentId/sourceEventId and injected provenance", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: FILE, cellId: CELL, payload: { value: "new draft" } }],
      ctx(),
    )
    expect(result.proposal).not.toBeNull()
    const event = result.proposal!.events[0]
    expect(event.kind).toBe("target.cell.commit")
    expect(event.parentId).toBe(TARGET_HEAD) // current cells.event_id
    expect(event.payload.sourceEventId).toBe(SOURCE_HEAD) // AD-9 staleness pin
    expect(event.payload.ai_suggestion).toBe(true) // AQU-292 provenance
    expect(event.payload.agent_run_id).toBe(RUN_ID) // attribution → agent_runs
    expect(event.display).toEqual({
      canonicalRef: "GEN 1:1",
      before: "old draft",
      after: "new draft",
    })
    expect(result.proposal!.runId).toBe(RUN_ID)
    expect(result.proposal!.summary).toContain("target.cell.commit")
    expect(result.modelVerdictBlock).toContain("staged")
  })

  it("reports stale (not staged) when the model pins a superseded parent", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [
        {
          kind: "target.cell.commit",
          fileId: FILE,
          cellId: CELL,
          parentId: "99999999-9999-4999-8999-999999999999", // not the head anymore
          payload: { value: "drafted against old text" },
        },
      ],
      ctx(),
    )
    expect(result.proposal).toBeNull()
    expect(result.modelVerdictBlock).toContain("stale: parent superseded")
    expect(result.modelVerdictBlock).toContain("re-read the cell")
  })

  it("stages a GENESIS commit (null parent) for a source cell with no target row — the editor's first-translation shape", async () => {
    const SOURCE_ONLY = "88888888-8888-4888-8888-888888888888"
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', 'untranslated source', 'GEN 1:2', ?, 0)`,
    )
      .bind(PROJECT, FILE, SOURCE_ONLY, "99999999-0000-4000-8000-000000000001")
      .run()

    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: FILE, cellId: SOURCE_ONLY, payload: { value: "first draft" } }],
      ctx(),
    )
    expect(result.proposal).not.toBeNull()
    const staged = result.proposal!.events[0]
    expect(staged.parentId).toBeUndefined() // genesis — no target head to chain from
    expect(staged.payload.sourceEventId).toBe("99999999-0000-4000-8000-000000000001")
    expect(staged.display).toMatchObject({ canonicalRef: "GEN 1:2", before: "", after: "first draft" })
  })

  it("surfaces deterministic lint (NEEDS REVIEW) in the verdict block so the model can redraft", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings) VALUES (?, ?)
       ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
    )
      .bind(
        PROJECT,
        JSON.stringify({
          rules: [
            {
              id: "r1",
              name: "No 'beginning' transliteration",
              enabled: true,
              check: { type: "target-forbids", targetPattern: "beginnito*" },
            },
          ],
        }),
      )
      .run()

    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: FILE, cellId: CELL, payload: { value: "En el beginnito" } }],
      ctx(),
    )
    // Lint does not block staging — the user still sees the proposal — but the
    // model is told exactly what to fix and to re-emit.
    expect(result.proposal).not.toBeNull()
    expect(result.modelVerdictBlock).toContain("NEEDS REVIEW")
    expect(result.modelVerdictBlock).toContain("No 'beginning' transliteration")
    expect(result.modelVerdictBlock).toContain("re-emit")
  })

  it("rejects a commit to a cell id that exists on neither side", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [
        {
          kind: "target.cell.commit",
          fileId: FILE,
          cellId: "77777777-7777-4777-8777-777777777777",
          payload: { value: "x" },
        },
      ],
      ctx(),
    )
    expect(result.proposal).toBeNull()
    expect(result.modelVerdictBlock).toContain("no cell exists at that id")
  })
})

describe("stageEvents — alias and :var resolution", () => {
  it("resolves #aliases and :file/:cell to real ids before staging", async () => {
    const aliases = new AliasMap()
    aliases.alias(CELL, "c")
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: ":file", cellId: "#c1", payload: { value: "via alias" } }],
      ctx({ aliases, fileId: FILE }),
    )
    expect(result.proposal).not.toBeNull()
    const event = result.proposal!.events[0]
    expect(event.fileId).toBe(FILE)
    expect(event.cellId).toBe(CELL)
  })

  it("rejects unknown aliases instead of staging garbage ids", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: FILE, cellId: "#c5", payload: { value: "x" } }],
      ctx(),
    )
    expect(result.proposal).toBeNull()
    expect(result.modelVerdictBlock).toContain("unknown alias #c5")
  })
})

describe("stageEvents — comment.create defaults", () => {
  it("fills commentId, null parentCommentId, and cell scope from the envelope", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "comment.create", fileId: FILE, cellId: CELL, payload: { body: "Check this rendering" } }],
      ctx({ roleLevel: 200 }), // COMMENTER may comment
    )
    expect(result.proposal).not.toBeNull()
    const payload = result.proposal!.events[0].payload
    expect(typeof payload.commentId).toBe("string")
    expect(payload.parentCommentId).toBeNull()
    expect(payload.scope).toEqual({ kind: "cell", fileId: FILE, cellId: CELL })
    expect(result.proposal!.events[0].display.canonicalRef).toBe("GEN 1:1")
  })

  it("stages the valid events of a mixed batch and reports each verdict", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [
        { kind: "comment.create", fileId: FILE, cellId: CELL, payload: { body: "ok" } },
        { kind: "target.cell.commit", fileId: FILE, cellId: CELL, payload: { value: "x" } }, // role too low
      ],
      ctx({ roleLevel: 200 }),
    )
    expect(result.proposal).not.toBeNull()
    expect(result.proposal!.events).toHaveLength(1)
    expect(result.modelVerdictBlock).toContain("1|comment.create|GEN 1:1|staged")
    expect(result.modelVerdictBlock).toContain("2|target.cell.commit|∅|rejected")
    expect(result.modelVerdictBlock).toContain("1 of 2 staged")
  })
})

describe("stageEvents — cell creates (AQU-890)", () => {
  it("stages a source.cell.create at PROJECT_LEAD, minting a cellId and injecting provenance", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [
        {
          kind: "source.cell.create",
          fileId: FILE,
          payload: { value: "Section heading", type: "heading", anchorCellId: CELL },
        },
      ],
      ctx({ roleLevel: 500 }),
    )
    expect(result.proposal).not.toBeNull()
    const ev = result.proposal!.events[0]
    expect(ev.kind).toBe("source.cell.create")
    expect(ev.fileId).toBe(FILE)
    // The model needn't know a free id — the server mints one and repeats it
    // into the payload, where the projection reads it.
    expect(typeof ev.cellId).toBe("string")
    expect(ev.payload.cellId).toBe(ev.cellId)
    expect(ev.payload.anchorCellId).toBe(CELL)
    expect(ev.payload.ai_suggestion).toBe(true)
    expect(ev.payload.agent_run_id).toBe(RUN_ID)
    // Genesis: no parent is resolved, and there is no prior text to diff.
    expect(ev.parentId).toBeUndefined()
    expect(ev.display.before).toBeUndefined()
    expect(ev.display.after).toBe("Section heading")
  })

  it("rejects source.cell.create below PROJECT_LEAD but allows target.cell.create at CONTRIBUTOR", async () => {
    const low = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "source.cell.create", fileId: FILE, payload: { value: "x" } }],
      ctx({ roleLevel: 400 }),
    )
    expect(low.proposal).toBeNull()
    expect(low.modelVerdictBlock).toContain("requires project_lead (500)")

    const ok = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.create", fileId: FILE, payload: { value: "Título" } }],
      ctx({ roleLevel: 400 }),
    )
    expect(ok.proposal).not.toBeNull()
    expect(ok.proposal!.events[0].payload.anchorCellId).toBeNull()
  })

  it("rejects a create whose cellId is already occupied on that side", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "source.cell.create", fileId: FILE, cellId: CELL, payload: { value: "x" } }],
      ctx({ roleLevel: 500 }),
    )
    expect(result.proposal).toBeNull()
    expect(result.modelVerdictBlock).toContain("a source cell already exists at that id")
    expect(result.modelVerdictBlock).toContain("source.cell.commit")
  })

  it("rejects a create anchored to a cell that does not exist in the file", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [
        {
          kind: "source.cell.create",
          fileId: FILE,
          payload: { value: "x", anchorCellId: "77777777-7777-4777-8777-777777777777" },
        },
      ],
      ctx({ roleLevel: 500 }),
    )
    expect(result.proposal).toBeNull()
    expect(result.modelVerdictBlock).toContain("does not exist in that file")
  })

  it("rejects a create with no fileId or no string value", async () => {
    const noFile = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "source.cell.create", payload: { value: "x" } }],
      ctx({ roleLevel: 500 }),
    )
    expect(noFile.proposal).toBeNull()
    expect(noFile.modelVerdictBlock).toContain("needs fileId")

    const noValue = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "source.cell.create", fileId: FILE, payload: {} }],
      ctx({ roleLevel: 500 }),
    )
    expect(noValue.proposal).toBeNull()
    expect(noValue.modelVerdictBlock).toContain("needs a string `value`")
  })
})

// AQU-846 — the user approved five drafts believing they landed in the file
// they had open; they landed in another one. The proposal has to SAY where it
// is going, so every staged event carries its file's display name.
describe("stageEvents — destination file naming (AQU-846)", () => {
  const OTHER_FILE = "77777777-7777-4777-8777-777777777777"
  const OTHER_CELL = "88888888-8888-4888-8888-888888888888"

  async function seedFileRow(id: string, name: string, bookCode: string) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, book_code, event_id) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(id, PROJECT, name, bookCode, crypto.randomUUID())
      .run()
  }

  it("stamps every staged event with its file's display name", async () => {
    await seedFileRow(FILE, "Genesis.usfm", "GEN")
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: FILE, cellId: CELL, payload: { value: "En el principio" } }],
      ctx(),
    )
    expect(result.proposal).not.toBeNull()
    expect(result.proposal!.events[0].display.fileName).toBe("Genesis.usfm")
  })

  it("names the destination file in the summary the user reads before approving", async () => {
    await seedFileRow(FILE, "Genesis.usfm", "GEN")
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: FILE, cellId: CELL, payload: { value: "x" } }],
      ctx(),
    )
    expect(result.proposal!.summary).toContain("Genesis.usfm")
  })

  it("names EACH file when a batch spans more than one", async () => {
    await seedFileRow(FILE, "Genesis.usfm", "GEN")
    await seedFileRow(OTHER_FILE, "Mark.usfm", "MRK")
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', 'And he began', 'MRK 4:1', ?, 0)`,
    )
      .bind(PROJECT, OTHER_FILE, OTHER_CELL, crypto.randomUUID())
      .run()

    const result = await stageEvents(
      env.AQUILLA_PG,
      [
        { kind: "target.cell.commit", fileId: FILE, cellId: CELL, payload: { value: "a" } },
        { kind: "target.cell.commit", fileId: OTHER_FILE, cellId: OTHER_CELL, payload: { value: "b" } },
      ],
      ctx(),
    )
    expect(result.proposal!.events.map((e) => e.display.fileName)).toEqual([
      "Genesis.usfm",
      "Mark.usfm",
    ])
    expect(result.proposal!.summary).toContain("Genesis.usfm")
    expect(result.proposal!.summary).toContain("Mark.usfm")
  })

  it("still stages when the file row is missing — naming is cosmetic", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: FILE, cellId: CELL, payload: { value: "x" } }],
      ctx(),
    )
    expect(result.proposal).not.toBeNull()
    expect(result.proposal!.events[0].display.fileName).toBeUndefined()
  })
})

describe("stageEvents — the project's cell-editing tier (AQU-1068)", () => {
  // STAGING IS THE ONLY PLACE THIS IS CAUGHT, as of 2026-09-09.
  //
  // It used to be the polite place: the /events perimeter checked the tier too,
  // and refusing here merely spared the user a 403 in the middle of a changeset
  // they had already approved. The perimeter stopped checking it — enforcing it
  // there silently refused audio-cue re-import, DCS upstream import and
  // diarization, which all emit these kinds through the user's own outbox — so
  // a proposal staged past these tests would now be ACCEPTED by the server.
  //
  // We refuse anyway, and that is the decision: the tier decides which buttons
  // exist, and an Apply button is a button. These tests are what keep the agent
  // from offering what the person could not do by hand.

  it("refuses source.cell.create when the project has not opted in", async () => {
    await seedCellEditingFloor(null)
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "source.cell.create", fileId: FILE, payload: { value: "x" } }],
      ctx({ roleLevel: 700 }),
    )
    expect(result.proposal).toBeNull()
    expect(result.modelVerdictBlock).toContain("not enabled for this project")
  })

  it("refuses an OWNER too — the default is nobody, not a floor", async () => {
    await seedCellEditingFloor(null)
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "source.cell.delete", fileId: FILE, cellId: CELL, payload: {} }],
      ctx({ roleLevel: 700 }),
    )
    expect(result.proposal).toBeNull()
  })

  it("refuses a lead below the configured tier", async () => {
    await seedCellEditingFloor("maintainer")
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "source.cell.create", fileId: FILE, payload: { value: "x" } }],
      ctx({ roleLevel: 500 }),
    )
    expect(result.proposal).toBeNull()
    expect(result.modelVerdictBlock).toContain("role too low to add or remove cells")
  })

  it("stages once the tier admits the caller", async () => {
    await seedCellEditingFloor("maintainer")
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "source.cell.create", fileId: FILE, payload: { value: "x" } }],
      ctx({ roleLevel: 600 }),
    )
    expect(result.proposal).not.toBeNull()
  })

  it("leaves ordinary drafting alone — a commit never asks about the tier", async () => {
    await seedCellEditingFloor(null)
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: FILE, cellId: CELL, payload: { value: "x" } }],
      ctx({ roleLevel: 400 }),
    )
    expect(result.proposal).not.toBeNull()
  })
})

describe("stageEvents — lanes (AQU-1447)", () => {
  const LANE_B = "ab12cd34"

  it("stages a lane-B commit as a genesis commit tagged with the lane, ignoring lane A's head", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: FILE, cellId: CELL, payload: { value: "Am Anfang" } }],
      ctx({ lane: LANE_B }),
    )
    const event = result.proposal!.events[0]
    expect(event.payload.targetLang).toBe(LANE_B)
    expect(event.parentId).toBeUndefined()
    expect(event.display.before).toBe("")
  })

  it("chains on lane B's own head once lane B has a commit", async () => {
    const LANE_B_HEAD = "77777777-7777-4777-8777-777777777777"
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, canonical_ref, event_id, last_edit_at)
       VALUES (?, ?, ?, 'target', ?, 'Am Anfang', 'GEN 1:1', ?, 0)`,
    )
      .bind(PROJECT, FILE, CELL, LANE_B, LANE_B_HEAD)
      .run()
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: FILE, cellId: CELL, payload: { value: "Im Anfang" } }],
      ctx({ lane: LANE_B }),
    )
    const event = result.proposal!.events[0]
    expect(event.parentId).toBe(LANE_B_HEAD)
    expect(event.payload.targetLang).toBe(LANE_B)
  })

  it("stages a commit from a lane id with that id and the lane's legacy tag", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
       VALUES ('a3f09c1e', ?, 'target', 'French', 'fr', 'fr', 2)`,
    )
      .bind(PROJECT)
      .run()
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: FILE, cellId: CELL, payload: { value: "Au commencement", targetLang: "a3f09c1e" } }],
      ctx({ lane: "a3f09c1e" }),
    )
    const event = result.proposal!.events[0]
    expect(event.payload.laneId).toBe("a3f09c1e")
    expect(event.payload.targetLang).toBe("fr")
  })

  it("leaves the default lane unchanged: chains on its head, no targetLang, model-written targetLang stripped", async () => {
    const result = await stageEvents(
      env.AQUILLA_PG,
      [{ kind: "target.cell.commit", fileId: FILE, cellId: CELL, payload: { value: "x", targetLang: LANE_B } }],
      ctx({ lane: "" }),
    )
    const event = result.proposal!.events[0]
    expect(event.parentId).toBe(TARGET_HEAD)
    expect(event.payload).not.toHaveProperty("targetLang")
  })
})

// AQU-1670: staging a whole-file proposal used to cost one Hyperdrive→Neon
// round-trip PER PROPOSED CELL, so a 28-cell proposal (the partner repro) ran
// past Cloudflare's origin timeout and returned 522 — discarding every cell
// the model had just paid to draft, identically on every retry. These tests
// pin the shape that fixed it: the number of cell reads must not depend on the
// number of cells.
describe("stageEvents — batched cell reads (AQU-1670)", () => {
  /** Count the statements that read the `cells` projection. */
  function countingDb(db: AquillaDb, opts: { failFirstBatch?: boolean } = {}) {
    const stats = { cellReads: 0, batchReads: 0, failures: 0 }
    const proxy = {
      prepare(sql: string) {
        const readsCells = /FROM cells/.test(sql)
        const isBatch = readsCells && /\(file_id, cell_id\) IN/.test(sql)
        if (readsCells) stats.cellReads++
        if (isBatch) stats.batchReads++
        if (isBatch && opts.failFirstBatch && stats.failures === 0) {
          stats.failures++
          return {
            bind: () => ({
              async all() {
                throw new Error("connection reset")
              },
            }),
          }
        }
        return db.prepare(sql)
      },
    } as unknown as AquillaDb
    return { db: proxy, stats }
  }

  /** N distinct source/target cell pairs in one file, GEN 1:1…1:N. */
  async function seedCells(count: number): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const n = String(i + 1).padStart(4, "0")
      const cellId = `9${n}9999-9999-4999-8999-999999999999`
      const sourceEvent = `a${n}aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
      const targetEvent = `b${n}bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
      await env.AQUILLA_PG.prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
         VALUES (?, ?, ?, 'source', 'src', ?, ?, 0),
                (?, ?, ?, 'target', 'old', ?, ?, 0)`,
      )
        .bind(
          PROJECT, FILE, cellId, `GEN 1:${i + 1}`, sourceEvent,
          PROJECT, FILE, cellId, `GEN 1:${i + 1}`, targetEvent,
        )
        .run()
      ids.push(cellId)
    }
    return ids
  }

  function commits(cellIds: string[]) {
    return cellIds.map((cellId, i) => ({
      kind: "target.cell.commit",
      fileId: FILE,
      cellId,
      payload: { value: `draft ${i + 1}` },
    }))
  }

  it("reads 28 cells in ONE query — the same count as a single-cell batch", async () => {
    const cellIds = await seedCells(28)

    const one = countingDb(env.AQUILLA_PG)
    const small = await stageEvents(one.db, commits(cellIds.slice(0, 1)), ctx())
    expect(small.proposal!.events).toHaveLength(1)

    const many = countingDb(env.AQUILLA_PG)
    const big = await stageEvents(many.db, commits(cellIds), ctx())
    expect(big.proposal!.events).toHaveLength(28)

    // The point of the issue: 28× the cells, the SAME number of cell reads.
    expect(many.stats.cellReads).toBe(one.stats.cellReads)
    expect(many.stats.batchReads).toBe(1)
    expect(many.stats.cellReads).toBe(1)
  })

  it("reads a 100-cell proposal in ONE query too (acceptance criterion)", async () => {
    const cellIds = await seedCells(100)
    const counted = countingDb(env.AQUILLA_PG)
    const result = await stageEvents(counted.db, commits(cellIds), ctx())

    expect(result.proposal!.events).toHaveLength(100)
    expect(counted.stats.cellReads).toBe(1)
  })

  it("resolves each cell's own chain and source pin through the batch", async () => {
    const cellIds = await seedCells(3)
    const result = await stageEvents(env.AQUILLA_PG, commits(cellIds), ctx())

    const events = result.proposal!.events
    expect(events.map((e) => e.cellId)).toEqual(cellIds)
    // Each event must carry ITS OWN cell's head and source pin, not a
    // neighbour's — the failure mode a batched read would introduce.
    events.forEach((event, i) => {
      const n = String(i + 1).padStart(4, "0")
      expect(event.parentId).toBe(`b${n}bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`)
      expect(event.payload.sourceEventId).toBe(`a${n}aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`)
      expect(event.display.canonicalRef).toBe(`GEN 1:${i + 1}`)
    })
  })

  it("keeps the batch lane-scoped: another lane's head is never borrowed", async () => {
    const cellIds = await seedCells(2)
    const result = await stageEvents(env.AQUILLA_PG, commits(cellIds), ctx({ lane: "zz99zz99" }))

    // No target row exists in that lane, so every commit is a genesis commit
    // tagged with the lane — exactly as the single-cell path behaves.
    for (const event of result.proposal!.events) {
      expect(event.parentId).toBeUndefined()
      expect(event.payload.targetLang).toBe("zz99zz99")
    }
  })

  it("retries a transient prefetch failure instead of discarding the batch", async () => {
    const cellIds = await seedCells(5)
    const counted = countingDb(env.AQUILLA_PG, { failFirstBatch: true })
    const result = await stageEvents(counted.db, commits(cellIds), ctx())

    // The whole batch rides on the one read, so a single hiccup must not cost
    // the model's work — it is retried, and nothing falls back to per-cell.
    expect(result.proposal!.events).toHaveLength(5)
    expect(counted.stats.batchReads).toBe(2)
  })

  it("reports a stage outcome carrying the cell count and the duration", async () => {
    const cellIds = await seedCells(4)
    const outcomes: StageOutcome[] = []
    const result = await stageEvents(
      env.AQUILLA_PG,
      [
        ...commits(cellIds),
        // One rejected (unknown kind) and one stale (superseded parent).
        { kind: "cells.update", fileId: FILE, payload: {} },
        {
          kind: "target.cell.commit",
          fileId: FILE,
          cellId: CELL,
          parentId: SOURCE_HEAD,
          payload: { value: "x" },
        },
      ],
      ctx({ onStageOutcome: (o) => outcomes.push(o) }),
    )

    expect(result.proposal!.events).toHaveLength(4)
    expect(outcomes).toHaveLength(1)
    const outcome = outcomes[0]
    expect(outcome).toMatchObject({
      runId: RUN_ID,
      projectId: PROJECT,
      requested: 6,
      staged: 4,
      rejected: 1,
      stale: 1,
      status: "staged",
      // Zero is the regression guard: a non-zero value means some cell escaped
      // the batch and paid for its own round-trip again.
      fallbackQueries: 0,
    })
    expect(outcome.cellsPrefetched).toBe(5)
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("never lets a throwing telemetry sink cost a staged batch", async () => {
    const cellIds = await seedCells(2)
    const result = await stageEvents(
      env.AQUILLA_PG,
      commits(cellIds),
      ctx({
        onStageOutcome: () => {
          throw new Error("posthog exploded")
        },
      }),
    )
    expect(result.proposal!.events).toHaveLength(2)
  })
})
