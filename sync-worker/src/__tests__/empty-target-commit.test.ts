// AQU-646: the server-side contract the "a recording counts as target content"
// feature is built on.
//
// A take lives in `cell_audio` and creates no `cells` target row. That absence
// — not the UI gate — is why a recording-only line could never be validated:
// validation attaches to a target row's event id, and assignment progress
// counts target rows with validated = 1. So the client now emits an EMPTY
// `target.cell.commit` when a take lands on a text-less cell.
//
// These tests pin what that empty commit does on the server, because the whole
// client feature is worthless if any of it is untrue:
//   1. it creates a real target row (value '', validated 0)
//   2. a cell.validate against its event id flips validated to 1
//   3. a later real edit still supersedes it, resetting validation as usual
//   4. it does NOT wipe existing text if one is ever emitted by mistake in a
//      chain — the guard lives client-side, so this documents the blast radius

import { describe, it, expect } from "vitest"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import { makeTestDb } from "./helpers/pg-test-db"

const PROJECT = "proj-aqu646"
const FILE = "file-1"
const CELL = "cell-1"
let _seq = 0

function ev(partial: Partial<PersistedEvent> & { kind: PersistedEvent["kind"] }): PersistedEvent {
  _seq += 1
  return {
    id: `e${_seq}`,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    author: "alice",
    payload: {},
    clientTs: 1000 + _seq,
    serverTs: 1000 + _seq,
    serverSeq: _seq,
    ...partial,
  }
}

async function replay(db: AquillaDb, events: PersistedEvent[]): Promise<void> {
  const stmts: AquillaStatement[] = []
  for (const e of events) buildEventProjectionStmts(db, e, stmts)
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100))
}

interface TargetRow { value: string; validated: number }
const targetRow = (db: Awaited<ReturnType<typeof makeTestDb>>) =>
  db.pg
    .query<TargetRow>(
      `SELECT value, validated FROM cells WHERE project_id=$1 AND file_id=$2 AND cell_id=$3 AND side='target'`,
      [PROJECT, FILE, CELL],
    )
    .then((r) => r.rows)

describe("AQU-646 empty target commit (a take counts as work)", () => {
  it("creates a real target row with an empty value, not validated", async () => {
    const db = await makeTestDb()
    try {
      const fileCreate = ev({ kind: "file.create", cellId: undefined, payload: { name: "EP", fileType: "codex" } })
      const src = ev({ kind: "source.cell.create", payload: { cellId: CELL, value: "" } })
      // The line has no text on EITHER side — it exists because someone added
      // it into a silence and recorded into it.
      const empty = ev({ kind: "target.cell.commit", parentId: src.id, payload: { value: "", sourceEventId: src.id } })
      await replay(db.db, [fileCreate, src, empty])

      const rows = await targetRow(db)
      expect(rows).toHaveLength(1)
      expect(rows[0].value).toBe("")
      expect(Number(rows[0].validated)).toBe(0)
    } finally {
      await db.close()
    }
  })

  it("is validatable — which is the entire point of creating it", async () => {
    const db = await makeTestDb()
    try {
      const fileCreate = ev({ kind: "file.create", cellId: undefined, payload: { name: "EP", fileType: "codex" } })
      const src = ev({ kind: "source.cell.create", payload: { cellId: CELL, value: "" } })
      const empty = ev({ kind: "target.cell.commit", parentId: src.id, payload: { value: "", sourceEventId: src.id } })
      // No empty-text guard exists server-side; the row is all that was missing.
      const validate = ev({ kind: "cell.validate", payload: { editEventId: empty.id } })
      await replay(db.db, [fileCreate, src, empty, validate])

      const rows = await targetRow(db)
      expect(Number(rows[0].validated)).toBe(1)
      expect(rows[0].value).toBe("")
    } finally {
      await db.close()
    }
  })

  it("a later real edit supersedes it and resets validation, as any edit would", async () => {
    const db = await makeTestDb()
    try {
      const fileCreate = ev({ kind: "file.create", cellId: undefined, payload: { name: "EP", fileType: "codex" } })
      const src = ev({ kind: "source.cell.create", payload: { cellId: CELL, value: "" } })
      const empty = ev({ kind: "target.cell.commit", parentId: src.id, payload: { value: "", sourceEventId: src.id } })
      const validate = ev({ kind: "cell.validate", payload: { editEventId: empty.id } })
      // Someone finally writes the line.
      const typed = ev({ kind: "target.cell.commit", parentId: empty.id, payload: { value: "Hola", sourceEventId: src.id } })
      await replay(db.db, [fileCreate, src, empty, validate, typed])

      const rows = await targetRow(db)
      expect(rows[0].value).toBe("Hola")
      expect(Number(rows[0].validated)).toBe(0)
    } finally {
      await db.close()
    }
  })

  it("WOULD erase existing text — which is why the client guards it", async () => {
    // Documenting the blast radius rather than asserting a safety net: the
    // server has no idea an empty commit is special, so `ensureTargetRowForTake`
    // only fires when the cell has neither a target row nor one in flight.
    const db = await makeTestDb()
    try {
      const fileCreate = ev({ kind: "file.create", cellId: undefined, payload: { name: "EP", fileType: "codex" } })
      const src = ev({ kind: "source.cell.create", payload: { cellId: CELL, value: "source" } })
      const typed = ev({ kind: "target.cell.commit", parentId: src.id, payload: { value: "Real text", sourceEventId: src.id } })
      const empty = ev({ kind: "target.cell.commit", parentId: typed.id, payload: { value: "", sourceEventId: src.id } })
      await replay(db.db, [fileCreate, src, typed, empty])

      expect((await targetRow(db))[0].value).toBe("")
    } finally {
      await db.close()
    }
  })
})
