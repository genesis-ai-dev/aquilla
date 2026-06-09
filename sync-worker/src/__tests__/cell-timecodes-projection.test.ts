import { describe, it, expect } from "vitest"
import { buildEventProjectionStmts } from "../events/event-projection"
import type { PersistedEvent } from "../events/event-projection"

interface RecordedStmt { sql: string; args: unknown[] }

function makeRecordingDb() {
  const recorded: RecordedStmt[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          recorded.push({ sql: sql.replace(/\s+/g, " ").trim(), args })
          return this
        },
      }
    },
  } as unknown as AquillaDb
  return { db, recorded }
}

function sourceCreate(): PersistedEvent {
  return {
    id: "e1", schemaVersion: 1, projectId: "p1", fileId: "f1", cellId: "c1",
    parentId: null, kind: "source.cell.create", author: "importer",
    payload: { cellId: "c1", anchorCellId: null, value: "Hello", startMs: 1500, endMs: 3250 },
    clientTs: 1, serverTs: 1000,
  } as unknown as PersistedEvent
}

describe("timecode projection", () => {
  it("writes start_ms/end_ms in the cells INSERT for source.cell.create", () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(db, sourceCreate(), stmts)
    const cellsInsert = recorded.find((r) => r.sql.includes("INSERT INTO cells ("))
    expect(cellsInsert).toBeTruthy()
    expect(cellsInsert!.sql).toContain("start_ms")
    expect(cellsInsert!.sql).toContain("end_ms")
    expect(cellsInsert!.args[14]).toBe(1500)
    expect(cellsInsert!.args[15]).toBe(3250)
  })
})
