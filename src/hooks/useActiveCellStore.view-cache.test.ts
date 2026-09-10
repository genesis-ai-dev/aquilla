// AQU-1104: whole-file reads (summaries, ribbon inputs, chapter map, text
// direction) ran on every cell-store version bump and rebuilt every cell's
// view from rows each time. The store now caches the built view and summary
// per cell version, so a commit re-derives only the cells it touched. These
// tests pin the identity contract those consumers rely on.
import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { CellAuditStats } from "./useCellsAuditStats"
import { CellStore } from "./useActiveCellStore"

function stats(cellId: string, activeValidators: string[]): CellAuditStats {
  return {
    cellId,
    editCount: 0,
    contentHash: "",
    lastEditAt: null,
    lastEditEventId: null,
    activeValidators,
    waivers: [],
  }
}

function row(
  cellId: string,
  side: "source" | "target",
  value: string,
  over: Partial<CellRow> = {},
): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `${side}-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: value ? 1 : 0,
    endorsementCount: 0,
    ...over,
  }
}

function runtime(
  store: CellStore,
  auditStats: ReadonlyMap<string, CellAuditStats> = new Map(),
  over: { username?: string; requiredValidations?: number } = {},
): void {
  store.setRuntime({
    projectId: "p1",
    fileId: "f1",
    username: over.username ?? "alice",
    requiredValidations: over.requiredValidations ?? 1,
    auditStats,
  })
}

function seeded(): CellStore {
  const store = new CellStore()
  runtime(store)
  store.replaceRows([
    row("a", "source", "hello"),
    row("b", "source", "world"),
    row("c", "source", "again"),
  ])
  return store
}

describe("CellStore view cache (AQU-1104)", () => {
  it("returns the same view object while the cell's version is unchanged", () => {
    const store = seeded()
    const first = store.getCellView("a")
    expect(first).not.toBeNull()
    expect(store.getCellView("a")).toBe(first)
    expect(store.getAllCellViews()[0]).toBe(first)
  })

  it("rebuilds only the edited cell's view after an optimistic edit", () => {
    const store = seeded()
    const a1 = store.getCellView("a")
    const b1 = store.getCellView("b")

    store.applyOptimisticTargetEdit("a", { value: "hola" })

    const a2 = store.getCellView("a")
    expect(a2).not.toBe(a1)
    expect(a2?.translated).toBe("hola")
    expect(a2?.status).toBe("unvalidated")
    expect(store.getCellView("b")).toBe(b1)
  })

  it("keeps summaries of untouched cells across a commit", () => {
    const store = seeded()
    const before = store.getAllSummaries()
    expect(store.getAllSummaries()).toBe(before)

    store.applyOptimisticTargetEdit("b", { value: "mundo" })

    const after = store.getAllSummaries()
    expect(after).not.toBe(before)
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
    expect(after[1]).not.toBe(before[1])
    expect(after[1].translated).toBe("mundo")
    expect(store.getTextPairs()[1].targetText).toBe("mundo")
    expect(store.getTextPairs()[0]).toBe(store.getTextPairs()[0])
  })

  it("re-derives a cell when its audit stats change and leaves the others alone", () => {
    const store = seeded()
    const a1 = store.getCellView("a")
    const b1 = store.getCellView("b")

    runtime(store, new Map([["b", stats("b", ["victor"])]]))

    expect(store.getCellView("a")).toBe(a1)
    const b2 = store.getCellView("b")
    expect(b2).not.toBe(b1)
    expect(b2?.activeValidators).toEqual(["victor"])
  })

  it("re-derives every cell when the viewer changes", () => {
    const store = seeded()
    const views = store.getAllCellViews()

    runtime(store, new Map(), { username: "bob" })

    store.getAllCellViews().forEach((view, index) => expect(view).not.toBe(views[index]))
  })

  it("re-derives only the cells whose row objects changed in a delta refresh", () => {
    // mergeCellsDelta keeps the same row object for cells the delta did not
    // touch; the store treats identity as "unchanged".
    const rows = [row("a", "source", "hello"), row("b", "source", "world"), row("c", "source", "again")]
    const store = new CellStore()
    runtime(store)
    store.replaceRows(rows)
    const a1 = store.getCellView("a")
    const c1 = store.getCellView("c")
    const versionB = store.getCellVersion("b")

    store.replaceRows(
      [rows[0], row("a", "target", "bonjour"), rows[1], rows[2]],
      { changedCellIds: ["a"] },
    )

    const a2 = store.getCellView("a")
    expect(a2).not.toBe(a1)
    expect(a2?.translated).toBe("bonjour")
    expect(store.getCellView("c")).toBe(c1)
    expect(store.getCellVersion("b")).toBe(versionB)
  })

  it("still bumps a cell whose row object was rebuilt, even when it is not listed as changed", () => {
    const store = seeded()
    const b1 = store.getCellView("b")

    store.replaceRows(
      [row("a", "source", "hello"), row("b", "source", "world (edited)"), row("c", "source", "again")],
      { changedCellIds: [] },
    )

    const b2 = store.getCellView("b")
    expect(b2).not.toBe(b1)
    expect(b2?.original).toBe("world (edited)")
  })

  it("bumps a cell whose target row disappeared", () => {
    const rows = [row("a", "source", "hello"), row("a", "target", "hola"), row("b", "source", "world")]
    const store = new CellStore()
    runtime(store)
    store.replaceRows(rows)
    expect(store.getCellView("a")?.translated).toBe("hola")

    store.replaceRows([rows[0], rows[2]], { changedCellIds: [] })
    expect(store.getCellView("a")?.translated).toBe("")
  })

  it("keeps the id-list identity across a refresh that does not reorder cells", () => {
    const store = seeded()
    const order = store.getCellIds()
    store.replaceRows([row("a", "source", "hello"), row("b", "source", "world (edited)"), row("c", "source", "again")])
    expect(store.getCellIds()).toBe(order)

    store.replaceRows([row("a", "source", "hello"), row("c", "source", "again")])
    expect(store.getCellIds()).not.toBe(order)
    expect(store.getCellIds()).toEqual(["a", "c"])
  })

  it("rebuilds the navigation index and progress lazily but consistently after mutations", () => {
    const store = seeded()
    expect(store.getNavigationIndex()[0]?.translated).toBe(0)
    expect(store.getFileProgressSnapshot()?.file.filledCount).toBe(0)

    store.applyOptimisticTargetEdit("a", { value: "hola" })
    store.applyOptimisticTargetEdit("b", { value: "mundo" })

    expect(store.getNavigationIndex()[0]?.translated).toBe(2)
    expect(store.getFileProgressSnapshot()?.file.filledCount).toBe(2)
    expect(store.getNavigationIndex()).toBe(store.getNavigationIndex())
  })

  it("reuses the store's navigation index when asked for the store's own order", () => {
    const store = seeded()
    const order = store.getCellIds()
    expect(store.getNavigationIndex(order)).toBe(store.getNavigationIndex())
    // A different id list (a lens re-sort) still gets its own index.
    const reversed = [...order].reverse()
    expect(store.getNavigationIndex(reversed)).not.toBe(store.getNavigationIndex())
  })

  it("drops cached entries on reset and for cells that leave the file", () => {
    const store = seeded()
    const a1 = store.getCellView("a")

    store.replaceRows([row("a", "source", "hello"), row("b", "source", "world")])
    expect(store.getCellView("c")).toBeNull()

    store.reset("p1", "f2")
    runtime(store)
    store.replaceRows([row("a", "source", "fresh")])
    const a2 = store.getCellView("a")
    expect(a2).not.toBe(a1)
    expect(a2?.original).toBe("fresh")
  })
})
