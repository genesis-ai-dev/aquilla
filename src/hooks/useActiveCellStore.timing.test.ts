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

// AQU-646 round 8: the chain head is what a head-insert has to re-point, or the
// file ends up with two rows claiming a null anchor and the new line sorts to
// the tail of store order while display order puts it first.
describe("CellStore.getChainHeadCellId", () => {
  const chained = () => [
    row("a"),
    row("b", { anchorCellId: "a", eventId: "source-b" }),
    row("c", { anchorCellId: "b", eventId: "source-c" }),
  ]

  it("finds the row with no cell before it", () => {
    expect(makeStore(chained()).getChainHeadCellId()).toEqual({
      cellId: "a",
      eventId: "source-a",
    })
  })

  it("returns null for an empty file", () => {
    expect(makeStore([]).getChainHeadCellId()).toBeNull()
  })

  it("ignores target rows — the chain is a source-side structure", () => {
    const store = makeStore([
      ...chained(),
      row("c", { side: "target", value: "hola", eventId: "t-c" }),
    ])
    expect(store.getChainHeadCellId()?.cellId).toBe("a")
  })
})

// AQU-646: a line whose only target content is a recording.
//
// The store is the single choke point for this. `deriveStatus` is deliberately
// NOT changed — it takes (text, validated) and is called from contexts that
// genuinely mean "has text" (few-shot corpora, terminology checks, batch
// synthesis). Flipping the assembled VIEW instead carries the change to exactly
// the things that ask "is this line done".
describe("CellStore.setOwnTakeCellIds", () => {
  const blank = () => [
    row("t1", { value: "" }),
    row("t1", { side: "target", value: "", eventId: "tgt-t1" }),
  ]

  it("a text-empty line with a take reads as unvalidated, not empty", () => {
    const store = makeStore(blank())
    expect(store.getCellView("t1")?.status).toBe("empty")
    store.setOwnTakeCellIds(new Set(["t1"]))
    const view = store.getCellView("t1")
    expect(view?.status).toBe("unvalidated")
    expect(view?.hasOwnTake).toBe(true)
  })

  it("...and as VALIDATED once somebody validates it", () => {
    // The row deriveStatus can't read: empty text wins over validated=true, so
    // the flip has to consult the target row itself.
    const store = makeStore([
      row("t1", { value: "" }),
      row("t1", { side: "target", value: "", eventId: "tgt-t1", validated: true }),
    ])
    store.setOwnTakeCellIds(new Set(["t1"]))
    expect(store.getCellView("t1")?.status).toBe("validated")
  })

  it("leaves a line with text alone", () => {
    const store = makeStore([
      row("t1", { value: "src" }),
      row("t1", { side: "target", value: "written", eventId: "tgt-t1" }),
    ])
    store.setOwnTakeCellIds(new Set(["t1"]))
    const view = store.getCellView("t1")
    expect(view?.status).toBe("unvalidated")
    expect(view?.hasOwnTake).toBe(true)
  })

  it("carries hasOwnTake onto the summary, which is what the counters read", () => {
    const store = makeStore(blank())
    store.setOwnTakeCellIds(new Set(["t1"]))
    const summary = store.getAllSummaries().find((s) => s.id === "t1")
    expect(summary?.hasOwnTake).toBe(true)
    expect(summary?.status).toBe("unvalidated")
  })

  it("reverts the moment the take goes away", () => {
    const store = makeStore(blank())
    store.setOwnTakeCellIds(new Set(["t1"]))
    expect(store.getCellView("t1")?.status).toBe("unvalidated")
    store.setOwnTakeCellIds(new Set())
    const view = store.getCellView("t1")
    expect(view?.status).toBe("empty")
    expect(view?.hasOwnTake).toBeUndefined()
  })

  it("survives a runtime update — audio comes from a different source", () => {
    // setRuntime replaces the whole context; blanking the take set there would
    // make every dubbed line flicker back to empty on an unrelated lane or
    // audit-stats change.
    const store = makeStore(blank())
    store.setOwnTakeCellIds(new Set(["t1"]))
    store.setRuntime({
      projectId: "p", fileId: "f", username: "alice",
      requiredValidations: 1, auditStats: new Map(),
    })
    expect(store.getCellView("t1")?.status).toBe("unvalidated")
  })
})
