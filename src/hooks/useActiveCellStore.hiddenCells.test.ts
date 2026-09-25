// AQU-1422: the cell store is the ONE place a parked cell leaves the display.
//
// `getCellIdsForLens` feeds the text table, the media lens and (as
// `displayCellIds`) the chapter navigation counts, so filtering there is what
// makes the three drop and restore a row together — the AC's "Surfaces" check.
// Filtering in the table instead would have left the row in the timeline and in
// the sidebar's totals, which is the shape of the Codex bug this replaces.
//
// The other half is the LIST VERSION. `useCellIds` only re-reads on
// `listVersion`, and a hide changes no order and no membership — the cell is
// still in the file — so nothing in the ordinary ingestion paths would bump it.
// Every test below that hides something also asserts the bump, because without
// it the row keeps rendering until the next unrelated reorder and the feature
// silently does nothing live.

import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(cellId: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId,
    side: "source",
    value: `src ${cellId}`,
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

function target(cellId: string, over: Partial<CellRow> = {}): CellRow {
  return row(cellId, {
    side: "target",
    value: `tgt ${cellId}`,
    eventId: `target-${cellId}`,
    ...over,
  })
}

function makeStore(rows: CellRow[], showHidden = false): CellStore {
  const store = new CellStore()
  store.reset("p", "f")
  store.setRuntime({
    projectId: "p",
    fileId: "f",
    username: "alice",
    requiredValidations: 1,
    auditStats: new Map(),
    showHidden,
  })
  store.replaceRows(rows, { full: true })
  return store
}

const CHAIN = [
  row("a"),
  row("b", { anchorCellId: "a" }),
  row("c", { anchorCellId: "b" }),
]

describe("hidden cells leave the display list", () => {
  it("drops a parked cell from the text lens", () => {
    const store = makeStore([row("a"), row("b", { anchorCellId: "a", hidden: true }), row("c", { anchorCellId: "b" })])
    expect(store.getCellIdsForLens()).toEqual(["a", "c"])
  })

  it("drops it from the media lens and the time-ordered lens too", () => {
    const store = makeStore([
      row("m1", { medium: "media", startMs: 0, endMs: 1_000 }),
      row("m2", { medium: "media", startMs: 1_000, endMs: 2_000, hidden: true }),
      row("m3", { medium: "media", startMs: 2_000, endMs: 3_000 }),
    ])
    expect(store.getCellIdsForLens("time", true)).toEqual(["m1", "m3"])
    expect(store.getCellIdsForLens("time", false)).toEqual(["m1", "m3"])
  })

  it("keeps the row in the file — `order` and the source row are untouched", () => {
    const store = makeStore([row("a"), row("b", { hidden: true })])
    // Hidden is a DISPLAY decision. Nothing is removed, which is what makes
    // showing it again free and keeps `toRows()` (and so the IDB cache) complete.
    expect(store.getCellIds()).toEqual(["a", "b"])
    expect(store.getCellCount()).toBe(2)
    expect(store.getCellView("b")?.hidden).toBe(true)
  })

  it("reveals parked cells when showHidden is on, in their original position", () => {
    const store = makeStore([row("a"), row("b", { anchorCellId: "a", hidden: true }), row("c", { anchorCellId: "b" })], true)
    expect(store.getCellIdsForLens()).toEqual(["a", "b", "c"])
  })

  it("counts what is parked, whether or not it is being revealed", () => {
    const rows = [row("a"), row("b", { hidden: true }), row("c", { hidden: true })]
    expect(makeStore(rows).getHiddenCount()).toBe(2)
    expect(makeStore(rows, true).getHiddenCount()).toBe(2)
  })

  it("reports per-cell state", () => {
    const store = makeStore([row("a"), row("b", { hidden: true })])
    expect(store.isCellHidden("b")).toBe(true)
    expect(store.isCellHidden("a")).toBe(false)
  })

  it("reads the flag off the SOURCE row and ignores a target row carrying one", () => {
    // Hiding is per cell, not per lane, so the source row answers for every
    // language. A target row must never be able to park a cell on its own — and
    // one created after a hide has no flag at all, which is why the source row
    // is the only place the answer can live.
    const store = makeStore([row("a"), target("a", { hidden: true })])
    expect(store.isCellHidden("a")).toBe(false)
    expect(store.getCellIdsForLens()).toEqual(["a"])
  })

  it("returns `order` ITSELF when nothing is parked", () => {
    // Identity is load-bearing: useCellIds hands this to the editor as
    // displayCellIds, and getNavigationIndex only reuses the store's own index
    // when the array IS `order` (AQU-1104). A fresh array here would make every
    // navigation lookup miss, on every file.
    const store = makeStore([...CHAIN])
    expect(store.getCellIdsForLens()).toBe(store.getCellIds())
  })

  it("drops parked cells from the navigation index built for the display list", () => {
    const store = makeStore([
      row("a", { canonicalRef: "GEN 1:1" }),
      row("b", { anchorCellId: "a", canonicalRef: "GEN 1:2", hidden: true }),
      row("c", { anchorCellId: "b", canonicalRef: "GEN 1:3" }),
    ])
    const entries = store.getNavigationIndex(store.getCellIdsForLens())
    const listed = entries.flatMap((e) => [...e.cellIds])
    expect(listed).toContain("a")
    expect(listed).toContain("c")
    expect(listed).not.toContain("b")
  })
})

describe("a hide/show bumps the list version", () => {
  it("bumps when a delta flips `hidden` without changing order or membership", () => {
    const store = makeStore([row("a"), row("b", { anchorCellId: "a" })])
    const before = store.getListVersion()

    store.replaceRows([row("a"), row("b", { anchorCellId: "a", hidden: true })], {
      changedCellIds: ["b"],
    })

    expect(store.getListVersion()).toBeGreaterThan(before)
    expect(store.getCellIdsForLens()).toEqual(["a"])
  })

  it("bumps when a targeted read or a live frame lands the flip for one cell", () => {
    const store = makeStore([row("a"), row("b", { anchorCellId: "a" })])
    const before = store.getListVersion()

    // The shape of an `event.applied` frame's rows for one cell.
    store.replaceRowsForCell("b", [row("b", { anchorCellId: "a", hidden: true })])

    expect(store.getListVersion()).toBeGreaterThan(before)
    expect(store.getCellIdsForLens()).toEqual(["a"])
  })

  it("bumps again when the cell comes back, restoring its position", () => {
    const store = makeStore([row("a"), row("b", { anchorCellId: "a", hidden: true }), row("c", { anchorCellId: "b" })])
    expect(store.getCellIdsForLens()).toEqual(["a", "c"])
    const before = store.getListVersion()

    store.replaceRowsForCell("b", [row("b", { anchorCellId: "a" })])

    expect(store.getListVersion()).toBeGreaterThan(before)
    expect(store.getCellIdsForLens()).toEqual(["a", "b", "c"])
  })

  it("bumps when the reveal preference flips, without touching any cell version", () => {
    const store = makeStore([row("a"), row("b", { hidden: true })])
    const beforeList = store.getListVersion()
    const beforeCell = store.getCellVersion("b")

    store.setRuntime({
      projectId: "p",
      fileId: "f",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
      showHidden: true,
    })

    expect(store.getListVersion()).toBeGreaterThan(beforeList)
    // No row's DATA moved, so re-rendering 30k rows would be waste — and a
    // version bumped without a paired emit is the exact hazard the store's own
    // invariant note warns about.
    expect(store.getCellVersion("b")).toBe(beforeCell)
    expect(store.getCellIdsForLens()).toEqual(["a", "b"])
  })
})

describe("optimistic park / un-park", () => {
  it("takes the row off the list immediately and reports the previous flag", () => {
    const store = makeStore([row("a"), row("b", { anchorCellId: "a" })])

    expect(store.applyOptimisticCellHidden("b", true)).toBe(false)

    expect(store.getCellIdsForLens()).toEqual(["a"])
    expect(store.getHiddenCount()).toBe(1)
  })

  it("rolls back to exactly what was there when the server refuses", () => {
    const store = makeStore([row("a"), row("b", { anchorCellId: "a" })])
    const previous = store.applyOptimisticCellHidden("b", true)

    store.applyOptimisticCellHidden("b", previous as boolean)

    expect(store.getCellIdsForLens()).toEqual(["a", "b"])
    expect(store.getHiddenCount()).toBe(0)
  })

  it("un-parks optimistically too, and reports that it WAS parked", () => {
    const store = makeStore([row("a", { hidden: true })])
    expect(store.applyOptimisticCellHidden("a", false)).toBe(true)
    expect(store.getCellIdsForLens()).toEqual(["a"])
  })

  it("returns null and does nothing when there is no source row to park", () => {
    const store = makeStore([target("a")])
    expect(store.applyOptimisticCellHidden("a", true)).toBeNull()
    expect(store.getHiddenCount()).toBe(0)
  })

  it("sets a freshness floor so a read already in flight cannot flash the row back", () => {
    const store = makeStore([row("a")])
    store.applyOptimisticCellHidden("a", true)
    expect(store.getFreshnessFloor("a")).toBeGreaterThan(0)
  })
})

describe("structural edits keep the parked set honest", () => {
  it("stops counting a parked cell that was removed", () => {
    const store = makeStore([row("a"), row("b", { hidden: true })], true)
    expect(store.getHiddenCount()).toBe(1)

    store.applyOptimisticSourceRemove("b")

    // A stale entry would keep claiming "1 hidden" for a cell that is gone.
    expect(store.getHiddenCount()).toBe(0)
  })

  it("restores a parked cell PARKED when the removal is rolled back", () => {
    const store = makeStore([row("a"), row("b", { hidden: true })], true)
    const removed = store.applyOptimisticSourceRemove("b")

    store.rollbackOptimisticSourceChange("b", removed)

    expect(store.getHiddenCount()).toBe(1)
    expect(store.isCellHidden("b")).toBe(true)
  })

  it("does not park a NEW cell that re-uses a parked id", () => {
    const store = makeStore([row("a"), row("b", { hidden: true })], true)
    store.applyOptimisticSourceRemove("b")

    store.applyOptimisticSourceInsert({ cellId: "b", anchorCellId: "a", value: "" })

    expect(store.isCellHidden("b")).toBe(false)
    expect(store.getCellIdsForLens()).toContain("b")
  })
})

describe("file switch", () => {
  it("forgets the parked set — another file's ids say nothing about this one", () => {
    const store = makeStore([row("a"), row("b", { hidden: true })])
    expect(store.getHiddenCount()).toBe(1)

    store.reset("p", "g")
    // Same ids, nothing hidden in the new file. A retained set would have
    // filtered "b" out here by pure coincidence of id.
    store.replaceRows([row("a"), row("b")], { full: true })

    expect(store.getHiddenCount()).toBe(0)
    expect(store.getCellIdsForLens()).toEqual(["a", "b"])
  })
})
