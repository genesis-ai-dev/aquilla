// Round 7 (AQU-646): optimistic TIMING/metadata application — chip moves and
// subtitle retimes must be visible in cell views instantly, survive a stale
// concurrent fetch (freshness floor), and yield to the confirming refetch.

import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(cellId: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId,
    side: "source",
    value: "x",
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `source-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: 1,
    endorsementCount: 0,
    ...over,
  } as CellRow
}

function makeStore(rows: CellRow[]): CellStore {
  const store = new CellStore()
  store.reset("p", "f")
  store.setRuntime({
    projectId: "p",
    fileId: "f",
    username: "alice",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(rows, { full: true })
  return store
}

const media = () => [
  row("m1", { medium: "media", startMs: 10_000, endMs: 20_000 }),
  row("m1", { side: "target", value: "hola", eventId: "t-m1", startMs: 10_000, endMs: 20_000 }),
]

describe("CellStore.applyOptimisticCellTiming", () => {
  it("metadata keys apply instantly to the cell view (chip move)", () => {
    const store = makeStore(media())
    store.applyOptimisticCellTiming("m1", { metadata: { target_start_ms: 14_000 } })
    const view = store.getAllCellViews().find((c) => c.id === "m1")!
    expect(view.metadata?.target_start_ms).toBe(14_000)
  })

  it("subtitle span keys merge without clobbering other metadata", () => {
    const store = makeStore([row("m1", { medium: "media", startMs: 0, endMs: 5_000, metadata: { cast_name: "Speaker 1" } })])
    store.applyOptimisticCellTiming("m1", { metadata: { subtitle_start_ms: 1_000, subtitle_end_ms: 4_000 } })
    const view = store.getAllCellViews().find((c) => c.id === "m1")!
    expect(view.metadata?.subtitle_start_ms).toBe(1_000)
    expect(view.metadata?.cast_name).toBe("Speaker 1")
  })

  it("null deletes a metadata key (reset-to-default)", () => {
    const store = makeStore([row("m1", { medium: "media", startMs: 0, endMs: 5_000, metadata: { target_start_ms: 2_000 } })])
    store.applyOptimisticCellTiming("m1", { metadata: { target_start_ms: null } })
    const view = store.getAllCellViews().find((c) => c.id === "m1")!
    expect(view.metadata?.target_start_ms).toBeUndefined()
  })

  it("startMs/endMs apply to BOTH side rows (text-cell retime)", () => {
    const store = makeStore(media())
    store.applyOptimisticCellTiming("m1", { startMs: 11_000, endMs: 21_000 })
    const view = store.getAllCellViews().find((c) => c.id === "m1")!
    expect(view.startTime).toBe(11)
    expect(view.endTime).toBe(21)
  })

  it("stamps the freshness floor so a stale concurrent fetch can't wipe it", () => {
    const store = makeStore(media())
    const preSeq = store.getWriteSeq()
    store.applyOptimisticCellTiming("m1", { metadata: { target_start_ms: 14_000 } })
    expect(store.getFreshnessFloor("m1")).toBeGreaterThan(preSeq)
  })

  it("unknown cellId is a no-op", () => {
    const store = makeStore(media())
    expect(() => store.applyOptimisticCellTiming("nope", { startMs: 1 })).not.toThrow()
  })
})
