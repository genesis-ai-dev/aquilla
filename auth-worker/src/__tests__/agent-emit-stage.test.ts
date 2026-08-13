// emit-stage.ts — staging is the agent's ONLY write surface, and it must be
// no more dangerous than the requesting user: role floors re-validated
// server-side (the prompt filter is for token economy, this is for safety),
// parents resolved against the LIVE chain head (a stale parent means the
// model drafted against superseded text), and provenance (ai_suggestion +
// agent_run_id) injected so every applied draft is attributable to its run.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import { stageEvents, type EmitStageContext } from "../lib/agent/emit-stage"
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

beforeEach(async () => {
  await seedCellPair()
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
