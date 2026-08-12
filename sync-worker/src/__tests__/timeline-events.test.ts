// Projection SQL/bindings for the timeline editor's two new event kinds:
// cell.retime (move/stretch -> start_ms/end_ms on both sides) and
// file.video.set (core video URL merged into files.meta).

import { describe, it, expect } from "vitest"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { EventKind } from "../events/types"

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

function makeEvent<K extends EventKind>(
  kind: K,
  payload: unknown,
  over: Partial<PersistedEvent> = {},
): PersistedEvent {
  return {
    id: "evt-1",
    schemaVersion: 1,
    projectId: "p1",
    fileId: "f1",
    cellId: "c1",
    parentId: null,
    kind,
    author: "alice",
    payload,
    clientTs: 10,
    serverTs: 100,
    serverSeq: 5,
    ...over,
  } as PersistedEvent
}

describe("cell.retime projection", () => {
  it("updates start_ms/end_ms for the cell across both sides (no side filter)", () => {
    const { db, recorded } = makeRecordingDb()
    const touches = buildEventProjectionStmts(
      db,
      makeEvent("cell.retime", { startMs: 400, endMs: 6000 }),
      [],
    )
    expect(touches).toEqual(["cells"])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain("UPDATE cells SET start_ms = ?, end_ms = ?")
    // Critically: no `side =` clause — timing applies to source AND target rows.
    expect(recorded[0].sql).not.toContain("side =")
    expect(recorded[0].args).toEqual([400, 6000, "p1", "f1", "c1"])
  })
})

describe("file.video.set projection", () => {
  it("merges coreMediaUrl into files.meta and advances event_id", () => {
    const { db, recorded } = makeRecordingDb()
    const touches = buildEventProjectionStmts(
      db,
      makeEvent("file.video.set", { coreMediaUrl: "https://cdn/v.mp4" }, { cellId: null }),
      [],
    )
    expect(touches).toEqual(["files"])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain("UPDATE files")
    expect(recorded[0].sql).toContain("jsonb_build_object('coreMediaUrl'")
    expect(recorded[0].args).toEqual(["https://cdn/v.mp4", "evt-1", "f1", "p1"])
  })

  it("removes the coreMediaUrl key when null", () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent("file.video.set", { coreMediaUrl: null }, { cellId: null }),
      [],
    )
    expect(recorded[0].sql).toContain("- 'coreMediaUrl'")
    expect(recorded[0].args).toEqual(["evt-1", "f1", "p1"])
  })
})

describe("file.timing.set projection (pre-merge round: file-level timing mode)", () => {
  it("is maintainer-gated and non-chain-mutating", async () => {
    const { REQUIRED_ROLE } = await import("../events/role-policy")
    const { isChainMutatingKind } = await import("../events/event-projection")
    expect(REQUIRED_ROLE["file.timing.set"]).toBe(600)
    expect(isChainMutatingKind("file.timing.set")).toBe(false)
  })

  it("merges timingMode into files.meta and advances event_id", () => {
    const { db, recorded } = makeRecordingDb()
    const touches = buildEventProjectionStmts(
      db,
      makeEvent("file.timing.set", { timingMode: "audioFirst" }, { cellId: null }),
      [],
    )
    expect(touches).toEqual(["files"])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain("UPDATE files")
    expect(recorded[0].sql).toContain("jsonb_build_object('timingMode'")
    expect(recorded[0].args).toEqual(["audioFirst", "evt-1", "f1", "p1"])
  })

  it("removes the timingMode key when null — the file falls back to the project default", () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent("file.timing.set", { timingMode: null }, { cellId: null }),
      [],
    )
    expect(recorded[0].sql).toContain("- 'timingMode'")
    expect(recorded[0].args).toEqual(["evt-1", "f1", "p1"])
  })
})
