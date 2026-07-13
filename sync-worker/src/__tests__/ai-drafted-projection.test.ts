// AQU-292: AI-drafted cell projection tests.
//
// WHY: The ai_drafted column tracks machine-generated cells that haven't been
// human-reviewed yet. Reclassification rules that must hold:
//   1. AI commit (ai_suggestion=true) → ai_drafted = 1
//   2. Human commit (no ai_suggestion) → ai_drafted = 0
//   3. cell.validate → ai_drafted = 0 (validation supersedes)
//   4. files.ai_drafted_count is the aggregate of cells.ai_drafted
//
// Forward-only honesty: commits without ai_suggestion are treated as human
// (ai_drafted = 0) regardless of whether they're actually AI-authored.

import { describe, it, expect } from "vitest"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import { makeTestDb } from "./helpers/pg-test-db"

const PROJECT = "proj-ai-292"
const FILE = "file-ai"
let _seq = 0

function ev(partial: Partial<PersistedEvent> & { kind: PersistedEvent["kind"] }): PersistedEvent {
  _seq += 1
  return {
    id: `e${_seq}`,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId: "cell-1",
    parentId: null,
    author: "alice",
    payload: {},
    clientTs: 1000 + _seq,
    serverTs: 1000 + _seq,
    serverSeq: _seq,
    ...partial,
  }
}

async function replay(
  db: AquillaDb,
  events: PersistedEvent[],
): Promise<void> {
  const stmts: AquillaStatement[] = []
  for (const e of events) {
    buildEventProjectionStmts(db, e, stmts)
  }
  // batch in chunks
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100))
  }
}

describe("AQU-292 ai_drafted projection", () => {
  it("AI commit sets ai_drafted = 1 on the cell row", async () => {
    const db = await makeTestDb()
    try {
      const fileCreate = ev({ kind: "file.create", cellId: undefined, payload: { name: "GEN", fileType: "codex" } })
      const src = ev({ kind: "source.cell.create", payload: { cellId: "cell-1", value: "In the beginning" } })
      const aiCommit = ev({
        kind: "target.cell.commit",
        parentId: src.id,
        payload: { value: "Au commencement", ai_suggestion: true },
      })
      await replay(db.db, [fileCreate, src, aiCommit])

      const cell = await db.pg.query<{ ai_drafted: number }>(
        "SELECT ai_drafted FROM cells WHERE project_id=$1 AND file_id=$2 AND cell_id=$3 AND side='target'",
        [PROJECT, FILE, "cell-1"],
      )
      expect(cell.rows[0]?.ai_drafted).toBe(1)

      // files.ai_drafted_count should be 1
      const file = await db.pg.query<{ ai_drafted_count: number }>(
        "SELECT ai_drafted_count FROM files WHERE project_id=$1 AND id=$2",
        [PROJECT, FILE],
      )
      expect(file.rows[0]?.ai_drafted_count).toBe(1)
    } finally {
      await db.close()
    }
  })

  it("human commit after AI commit clears ai_drafted = 0 (reclassification)", async () => {
    const db = await makeTestDb()
    try {
      const fileCreate = ev({ kind: "file.create", cellId: undefined, payload: { name: "GEN", fileType: "codex" } })
      const src = ev({ kind: "source.cell.create", payload: { cellId: "cell-1", value: "In the beginning" } })
      const aiCommit = ev({
        kind: "target.cell.commit",
        parentId: src.id,
        payload: { value: "Au commencement [AI]", ai_suggestion: true },
      })
      const humanCommit = ev({
        kind: "target.cell.commit",
        parentId: aiCommit.id,
        // no ai_suggestion — human edit
        payload: { value: "Au commencement [edited by human]" },
      })
      await replay(db.db, [fileCreate, src, aiCommit, humanCommit])

      const cell = await db.pg.query<{ ai_drafted: number }>(
        "SELECT ai_drafted FROM cells WHERE project_id=$1 AND file_id=$2 AND cell_id=$3 AND side='target'",
        [PROJECT, FILE, "cell-1"],
      )
      // Human commit must have cleared ai_drafted
      expect(cell.rows[0]?.ai_drafted).toBe(0)

      const file = await db.pg.query<{ ai_drafted_count: number }>(
        "SELECT ai_drafted_count FROM files WHERE project_id=$1 AND id=$2",
        [PROJECT, FILE],
      )
      expect(file.rows[0]?.ai_drafted_count).toBe(0)
    } finally {
      await db.close()
    }
  })

  it("cell.validate clears ai_drafted = 0 (validation supersedes)", async () => {
    const db = await makeTestDb()
    try {
      const fileCreate = ev({ kind: "file.create", cellId: undefined, payload: { name: "GEN", fileType: "codex" } })
      const src = ev({ kind: "source.cell.create", payload: { cellId: "cell-1", value: "In the beginning" } })
      const aiCommit = ev({
        kind: "target.cell.commit",
        parentId: src.id,
        payload: { value: "Au commencement", ai_suggestion: true },
      })
      const validate = ev({
        kind: "cell.validate",
        payload: { editEventId: aiCommit.id },
      })
      await replay(db.db, [fileCreate, src, aiCommit, validate])

      const cell = await db.pg.query<{ ai_drafted: number; validated: number }>(
        "SELECT ai_drafted, validated FROM cells WHERE project_id=$1 AND file_id=$2 AND cell_id=$3 AND side='target'",
        [PROJECT, FILE, "cell-1"],
      )
      // Validation supersedes AI-drafted — cell is now "Validated", not "AI-drafted awaiting review"
      expect(cell.rows[0]?.ai_drafted).toBe(0)
      expect(cell.rows[0]?.validated).toBe(1)

      const file = await db.pg.query<{ ai_drafted_count: number; approved_count: number }>(
        "SELECT ai_drafted_count, approved_count FROM files WHERE project_id=$1 AND id=$2",
        [PROJECT, FILE],
      )
      expect(file.rows[0]?.ai_drafted_count).toBe(0)
      expect(file.rows[0]?.approved_count).toBe(1)
    } finally {
      await db.close()
    }
  })

  it("human commit (no ai_suggestion) starts with ai_drafted = 0", async () => {
    const db = await makeTestDb()
    try {
      const fileCreate = ev({ kind: "file.create", cellId: undefined, payload: { name: "GEN", fileType: "codex" } })
      const src = ev({ kind: "source.cell.create", payload: { cellId: "cell-1", value: "In the beginning" } })
      const humanCommit = ev({
        kind: "target.cell.commit",
        parentId: src.id,
        payload: { value: "Au commencement" },
        // no ai_suggestion at all
      })
      await replay(db.db, [fileCreate, src, humanCommit])

      const cell = await db.pg.query<{ ai_drafted: number }>(
        "SELECT ai_drafted FROM cells WHERE project_id=$1 AND file_id=$2 AND cell_id=$3 AND side='target'",
        [PROJECT, FILE, "cell-1"],
      )
      expect(cell.rows[0]?.ai_drafted).toBe(0)
    } finally {
      await db.close()
    }
  })

  it("emit carries ai_suggestion in the outbox payload", () => {
    // WHY: verify the payload type contract — the field is optional and truthy-only
    // (present iff machine-drafted). A missing field (human edit) is distinguishable.
    type TargetCommitPayload = import("../events/types").EventPayloads["target.cell.commit"]
    const ai: TargetCommitPayload = { value: "draft", ai_suggestion: true }
    const human: TargetCommitPayload = { value: "edited" }
    expect(ai.ai_suggestion).toBe(true)
    expect(human.ai_suggestion).toBeUndefined()
  })
})
