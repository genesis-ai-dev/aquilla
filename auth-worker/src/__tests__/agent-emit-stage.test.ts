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
