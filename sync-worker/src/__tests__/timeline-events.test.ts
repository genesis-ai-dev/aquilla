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

// Stage 1 (first-class timeline tracks). These drive buildEventProjectionStmts
// directly, which IS the rebuild path — rebuild.ts replays history through the
// same function — so a separate rebuild test would assert the same call twice.
// The handler-side validation is covered in file-track-set.test.ts.
describe("file.track.set projection (stage 1: per-track overrides)", () => {
  it("is maintainer-gated and non-chain-mutating", async () => {
    const { REQUIRED_ROLE } = await import("../events/role-policy")
    const { isChainMutatingKind } = await import("../events/event-projection")
    expect(REQUIRED_ROLE["file.track.set"]).toBe(600)
    expect(isChainMutatingKind("file.track.set")).toBe(false)
  })

  it("merges the patch per-field into files.meta.trackOverrides and advances event_id", () => {
    const { db, recorded } = makeRecordingDb()
    const touches = buildEventProjectionStmts(
      db,
      makeEvent(
        "file.track.set",
        { trackId: "subtitles", patch: { name: "Captions", order: 2 } },
        { cellId: null },
      ),
      [],
    )
    expect(touches).toEqual(["files"])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain("UPDATE files")
    expect(recorded[0].sql).toContain("jsonb_build_object('trackOverrides'")
    // The per-field merge: strip_nulls over (existing entry || patch), so a
    // concurrent rename and reorder of the same track both survive.
    expect(recorded[0].sql).toContain("jsonb_strip_nulls")
    // trackId binds twice — once as the key written, once to read the entry
    // being merged onto — then the patch JSON, then the chain/row keys.
    expect(recorded[0].args).toEqual([
      "subtitles",
      "subtitles",
      '{"name":"Captions","order":2}',
      "evt-1",
      "f1",
      "p1",
    ])
  })

  it("rides the same upsert when a single field is cleared with null", () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent(
        "file.track.set",
        { trackId: "source-audio", patch: { name: null } },
        { cellId: null },
      ),
      [],
    )
    // Clearing one override is NOT the delete path: the null reaches Postgres
    // inside the patch and jsonb_strip_nulls drops that key alone.
    expect(recorded[0].sql).toContain("jsonb_strip_nulls")
    expect(recorded[0].args).toEqual([
      "source-audio",
      "source-audio",
      '{"name":null}',
      "evt-1",
      "f1",
      "p1",
    ])
  })

  it("removes the whole entry when the patch is null", () => {
    const { db, recorded } = makeRecordingDb()
    const touches = buildEventProjectionStmts(
      db,
      makeEvent("file.track.set", { trackId: "target-audio", patch: null }, { cellId: null }),
      [],
    )
    expect(touches).toEqual(["files"])
    expect(recorded[0].sql).toContain("#- ARRAY['trackOverrides'")
    expect(recorded[0].sql).not.toContain("jsonb_strip_nulls")
    expect(recorded[0].args).toEqual(["target-audio", "evt-1", "f1", "p1"])
  })

  it("throws when fileId is absent", () => {
    const { db } = makeRecordingDb()
    expect(() =>
      buildEventProjectionStmts(
        db,
        makeEvent(
          "file.track.set",
          { trackId: "subtitles", patch: { name: "Captions" } },
          { cellId: null, fileId: null },
        ),
        [],
      ),
    ).toThrow(/missing fileId/)
  })
})
