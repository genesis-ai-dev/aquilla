// AQU-1569 — the live write path for a hand-placed sidebar order, and the one
// guarantee that makes the order durable: the live handler and the rebuild
// projection emit the SAME files UPDATE. If they ever diverge, a projection
// rebuild silently reshuffles every reordered project's sidebar, and nothing
// else in the suite would notice.

import { describe, expect, it } from "vitest"
import { handleFileReorder } from "../events/handlers/file-reorder"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import { usableSortIndex } from "../events/sort-index"
import type { AuthorizedEvent } from "../events/authorize"

interface RecordedStmt {
  sql: string
  args: unknown[]
}

function makeRecordingDb() {
  const recorded: RecordedStmt[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          recorded.push({ sql: sql.replace(/\s+/g, " ").trim(), args })
          return this
        },
      } as unknown as AquillaStatement
    },
  } as unknown as AquillaDb
  return { db, recorded }
}

function authorized(sortIndex: unknown, over: Record<string, unknown> = {}) {
  return {
    event: {
      id: "evt-1",
      schemaVersion: 1,
      projectId: "p1",
      fileId: "f1",
      cellId: null,
      parentId: null,
      kind: "file.reorder",
      payload: { sortIndex },
      clientTs: 10,
      ...over,
    },
    claims: { username: "alice" },
  } as unknown as AuthorizedEvent<"file.reorder">
}

function persisted(sortIndex: unknown): PersistedEvent {
  return {
    id: "evt-1",
    schemaVersion: 1,
    projectId: "p1",
    fileId: "f1",
    cellId: null,
    parentId: null,
    kind: "file.reorder",
    author: "alice",
    payload: { sortIndex },
    clientTs: 10,
    serverTs: 100,
    serverSeq: 5,
  } as PersistedEvent
}

describe("handleFileReorder", () => {
  it("writes the event row plus a files UPDATE and marks both tables dirty", () => {
    const { db, recorded } = makeRecordingDb()
    const result = handleFileReorder(db, authorized(1024), 100, 5)
    expect(result.stmts).toHaveLength(2)
    expect(result.dirtyTables).toEqual(["events", "files"])
    expect(recorded[1].sql).toContain("jsonb_build_object('sortIndex'")
    expect(recorded[1].args).toEqual([1024, "evt-1", "f1", "p1"])
  })

  it("broadcasts a file-scoped event frame with no cellId", () => {
    const { db } = makeRecordingDb()
    const result = handleFileReorder(db, authorized(0), 100, 5)
    expect(result.eventFrame).toMatchObject({
      t: "event",
      kind: "file.reorder",
      project: "p1",
      file: "f1",
    })
    expect(result.eventFrame).not.toHaveProperty("cell")
  })

  it("clears the key for null — a reset back to the automatic order", () => {
    const { db, recorded } = makeRecordingDb()
    handleFileReorder(db, authorized(null), 100, 5)
    expect(recorded[1].sql).toContain("- 'sortIndex'")
  })

  // Refused here, not quietly cleared: this is the only path a NEW write
  // takes, so a client that computed a NaN has a bug worth surfacing, and
  // persisting "no position" would look to the user like the drag worked.
  it("refuses an unusable index rather than silently unplacing the file", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "1024", {}, []]) {
      const { db } = makeRecordingDb()
      expect(() => handleFileReorder(db, authorized(bad), 100, 5), String(bad))
        .toThrow(/unusable sortIndex/)
    }
  })

  it("refuses an event with no fileId", () => {
    const { db } = makeRecordingDb()
    expect(() => handleFileReorder(db, authorized(0, { fileId: null }), 100, 5))
      .toThrow(/missing fileId/)
  })
})

describe("the live handler and the rebuild projection agree", () => {
  // The AQU-1569 acceptance criterion "rebuilding projections from the event
  // log reproduces the order" reduces to exactly this.
  for (const sortIndex of [0, 1024, -512, 512.5, null]) {
    it(`emits identical files SQL for sortIndex=${String(sortIndex)}`, () => {
      const live = makeRecordingDb()
      handleFileReorder(live.db, authorized(sortIndex), 100, 5)

      const rebuild = makeRecordingDb()
      buildEventProjectionStmts(rebuild.db, persisted(sortIndex), [])

      // The handler also writes the events row first; the projection writes
      // only the files UPDATE.
      expect(live.recorded).toHaveLength(2)
      expect(rebuild.recorded).toHaveLength(1)
      expect(live.recorded[1]).toEqual(rebuild.recorded[0])
    })
  }
})

describe("usableSortIndex", () => {
  it("accepts any finite number, including 0, negatives and fractions", () => {
    expect(usableSortIndex(0)).toBe(0)
    expect(usableSortIndex(-1024)).toBe(-1024)
    expect(usableSortIndex(512.5)).toBe(512.5)
  })

  it("rejects everything that cannot be ordered", () => {
    expect(usableSortIndex(Number.NaN)).toBeUndefined()
    expect(usableSortIndex(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(usableSortIndex("1024")).toBeUndefined()
    expect(usableSortIndex(null)).toBeUndefined()
    expect(usableSortIndex(undefined)).toBeUndefined()
  })
})
