// AQU-1104: whole-file reads (summaries, ribbon inputs, chapter map, text
// direction) ran on every cell-store version bump and rebuilt every cell's
// view from rows each time. The store now caches the built view and summary
// per cell version, so a commit re-derives only the cells it touched. These
// tests pin the identity contract those consumers rely on.
import { describe, expect, it, vi } from "vitest"
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
  it.each([false, true])("updates saved validation counts like a full rebuild (audit override: %s)", (withAudit) => {
    const store = new CellStore()
    const audit = withAudit ? new Map([["a", stats("a", [])]]) : new Map<string, CellAuditStats>()
    runtime(store, audit, { requiredValidations: 2 })
    const source = row("a", "source", "hello", { canonicalRef: "GEN 1:1", type: "verse" })
    const initial = row("a", "target", "bonjour")
    store.replaceRows([source, initial])
    const oldProgress = store.getFileProgressSnapshot()!
    const oldNavigation = store.getNavigationIndex()
    const rebuild = vi.spyOn(store as unknown as { computeDerivedIndexes(): void }, "computeDerivedIndexes")
    for (const endorsements of [1, 2, 0]) {
      const saved = { ...initial, eventId: `saved-${endorsements}`, endorsementCount: endorsements, validated: endorsements >= 2 }
      store.replaceRowsForCell("a", [source, saved])
      const fresh = new CellStore()
      runtime(fresh, audit, { requiredValidations: 2 })
      fresh.replaceRows([source, saved])
      expect(store.getFileProgressSnapshot()).toEqual(fresh.getFileProgressSnapshot())
      expect(store.getNavigationIndex()).toEqual(fresh.getNavigationIndex())
      expect(store.getFootnoteOffsets("a")).toEqual(fresh.getFootnoteOffsets("a"))
    }
    expect(rebuild).not.toHaveBeenCalled()
    expect(oldProgress.file.validationLevels).toEqual([0, 0])
    expect(oldNavigation[0].validated).toBe(0)
  })

  it("keeps indexes when the first saved target drops redundant inherited source fields", () => {
    const store = new CellStore()
    runtime(store)
    const source = row("a", "source", "hello", {
      canonicalRef: "GEN 1:1", type: "verse", startMs: 0,
      metadata: { paragraphStart: true },
    })
    store.replaceRows([source])
    store.getFileProgressSnapshot()
    store.applyOptimisticTargetEdit("a", { value: "bonjour" })
    const progress = store.getFileProgressSnapshot()
    const navigation = store.getNavigationIndex()
    const rebuild = vi.spyOn(store as unknown as { computeDerivedIndexes(): void }, "computeDerivedIndexes")
    const saved = row("a", "target", "bonjour", { metadata: null, startMs: null })
    store.replaceRowsForCell("a", [{ ...source, metadata: { paragraphStart: true } }, saved])
    expect(store.getNavigationIndex()).toBe(navigation)
    expect(store.getFileProgressSnapshot()).toBe(progress)
    expect(rebuild).not.toHaveBeenCalled()
    const fresh = new CellStore()
    runtime(fresh)
    fresh.replaceRows([source, saved])
    expect(store.getNavigationIndex()).toEqual(fresh.getNavigationIndex())
    expect(store.getFileProgressSnapshot()).toEqual(fresh.getFileProgressSnapshot())
    // Target canonical refs override the source; do not ignore a real change.
    store.replaceRowsForCell("a", [source, { ...saved, canonicalRef: "EXO 2:1" }])
    store.getNavigationIndex()
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  it("reuses indexes for identical deltas while advancing the watermark and rebuilding real changes", () => {
    const store = new CellStore()
    runtime(store)
    const source = row("a", "source", "hello", { canonicalRef: "GEN 1:1" })
    const target = row("a", "target", "bonjour")
    store.replaceRows([source, target], { maxServerSeq: 1 })
    const first = store.getFileProgressSnapshot()!
    const navigation = store.getNavigationIndex()
    const rebuild = vi.spyOn(store as unknown as { computeDerivedIndexes(): void }, "computeDerivedIndexes")
    store.replaceRows([{ ...source }, { ...target }], { changedCellIds: ["a"], maxServerSeq: 2 })
    expect(store.getFileProgressSnapshot()).toEqual({ ...first, revision: 2 })
    expect(store.getNavigationIndex()).toBe(navigation)
    expect(rebuild).not.toHaveBeenCalled()
    store.replaceRows([source, { ...target, value: "" }], { changedCellIds: ["a"], maxServerSeq: 3 })
    expect(store.getFileProgressSnapshot()?.file.filledCount).toBe(0)
    expect(rebuild).toHaveBeenCalledTimes(1)
    // Removing the source while retaining its target leaves union order
    // unchanged, but it must still remove the source from progress counts.
    store.replaceRows([target], { changedCellIds: ["a"], maxServerSeq: 4 })
    expect(store.getFileProgressSnapshot()).toBeNull()
    expect(rebuild).toHaveBeenCalledTimes(2)
  })

  it.each<Partial<CellRow>>([
    { canonicalRef: "EXO 2:1" },
    { type: "heading", value: "A new heading" },
    { startMs: 600_000 },
    { metadata: { biblica: { bookCode: "GEN", chapterLabel: "Preface" } } },
  ])("invalidates cached milestone inputs after a structural source change: %j", (patch) => {
    const store = new CellStore()
    runtime(store)
    const source = row("a", "source", "hello")
    store.replaceRows([source])
    store.getNavigationIndex()
    const updated = { ...source, ...patch }
    store.replaceRowsForCell("a", [updated])
    const fresh = new CellStore()
    runtime(fresh)
    fresh.replaceRows([updated])
    expect(store.getNavigationIndex()).toEqual(fresh.getNavigationIndex())
  })
  it("reuses milestone assignments for text edits while refreshing progress and structural changes", () => {
    const store = new CellStore()
    runtime(store)
    const a = row("a", "source", "hello", { canonicalRef: "GEN 1:1" })
    const b = row("b", "source", "world", { canonicalRef: "GEN 2:1", anchorCellId: "a" })
    store.replaceRows([a, b])
    const first = store.getNavigationIndex()
    store.applyOptimisticTargetEdit("a", { value: "bonjour" })
    const edited = store.getNavigationIndex()
    expect(edited[0].cellIds).toBe(first[0].cellIds)
    expect(edited[0].translated).toBe(1)
    expect(edited[1].translated).toBe(0)
    store.replaceRowsForCell("b", [{ ...b, canonicalRef: "GEN 1:2" }])
    const moved = store.getNavigationIndex()
    expect(moved).toHaveLength(1)
    expect(moved[0].cellIds).toEqual(["a", "b"])
    expect(moved[0].cellIds).not.toBe(first[0].cellIds)
    expect(moved[0].translated).toBe(1)
  })
  it("resolves a shared full-file view once per mutation without sharing mutable result arrays", () => {
    const store = seeded()
    const reads = vi.spyOn(store, "getCellView")
    const first = store.getAllCellViews()
    expect(reads).toHaveBeenCalledTimes(3)
    first.reverse().pop()
    expect(store.getAllCellViews().map(cell => cell.id)).toEqual(["a", "b", "c"])
    expect(reads).toHaveBeenCalledTimes(3)

    store.applyOptimisticTargetEdit("a", { value: "bonjour" })
    expect(store.getAllCellViews()[0].translated).toBe("bonjour")
    expect(reads).toHaveBeenCalledTimes(6)
    store.reset("p1", "f2")
    expect(store.getAllCellViews()).toEqual([])
  })
  it("invalidates full-file views when switching lanes or changing validation requirements", () => {
    const store = seeded()
    store.replaceRowsForCell("a", [
      row("a", "source", "hello"),
      row("a", "target", "bonjour", { targetLang: "fr" }),
      row("a", "target", "hola", { targetLang: "es" }),
    ])
    const auditStats = new Map([["a", stats("a", ["victor"])]])
    const context = { projectId: "p1", fileId: "f1", username: "alice", requiredValidations: 1, auditStats }
    store.setRuntime({ ...context, lane: "fr" })
    expect(store.getAllCellViews()[0].translated).toBe("bonjour")
    expect(store.getFileProgressSnapshot()?.file.validatedCount).toBe(1)
    store.setRuntime({ ...context, lane: "es" })
    expect(store.getAllCellViews()[0].translated).toBe("hola")
    store.setRuntime({ ...context, lane: "es", requiredValidations: 2 })
    expect(store.getFileProgressSnapshot()?.file.validatedCount).toBe(0)
    expect(store.getAllCellViews()[0].activeValidators).toEqual(["victor"])
  })
  it("does not invalidate or notify for equal audit responses, but applies removal and validation changes", () => {
    const store = seeded()
    runtime(store, new Map([["a", stats("a", ["victor"])]]))
    const view = store.getCellView("a")
    const navigation = store.getNavigationIndex()
    const progress = store.getFileProgressSnapshot()
    const summaries = store.getAllSummaries()
    const version = store.getAllVersion()
    const listener = vi.fn()
    store.subscribeAll(listener)

    runtime(store, new Map([["a", stats("a", ["victor"])]]))
    expect(listener).not.toHaveBeenCalled()
    expect(store.getAllVersion()).toBe(version)
    expect(store.getCellView("a")).toBe(view)
    expect(store.getNavigationIndex()).toBe(navigation)
    expect(store.getFileProgressSnapshot()).toBe(progress)
    expect(store.getAllSummaries()).toBe(summaries)

    runtime(store, new Map([["a", stats("a", ["victor", "alice"])]]))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getCellView("a")?.activeValidators).toEqual(["victor", "alice"])
    runtime(store, new Map())
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.getCellView("a")?.activeValidators).toEqual([])
  })
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

  it("retains navigation order through targeted saves, but updates actual anchor changes", () => {
    const store = new CellStore()
    runtime(store)
    const a = row("a", "source", "hello")
    const b = row("b", "source", "world", { anchorCellId: "a" })
    const c = row("c", "source", "again", { anchorCellId: "b" })
    store.replaceRows([a, b, c])
    const order = store.getCellIds()
    store.replaceRowsForCell("b", [b, row("b", "target", "bonjour")])
    expect(store.getCellIds()).toBe(order)
    expect(store.getNavigationIndex(order)).toBe(store.getNavigationIndex())
    expect(store.getNavigationIndex(order)[0]?.translated).toBe(1)

    // A remote insertion plus the displaced sibling must still move the list.
    store.replaceRowsForCell("new", [row("new", "source", "inserted", { anchorCellId: "a" })])
    store.replaceRowsForCell("b", [{ ...b, anchorCellId: "new" }, row("b", "target", "bonjour")])
    expect(store.getCellIds()).not.toBe(order)
    expect(store.getCellIds()).toEqual(["a", "new", "b", "c"])
    expect(store.getNavigationIndex(store.getCellIds())).toBe(store.getNavigationIndex())
    expect(store.getNavigationIndex()[0]?.total).toBe(4)
  })

  it("updates targeted source/target membership while retaining unchanged paired order", () => {
    const store = new CellStore()
    runtime(store)
    const a = row("a", "source", "First")
    const b = row("b", "source", "Second", { anchorCellId: "a" })
    const target = row("a", "target", "Translation")
    store.replaceRows([a, b, target])
    const pairedOrder = store.getCellIds()
    store.replaceRowsForCell("a", [a, { ...target, validated: true, value: "Updated" }])
    expect(store.getCellIds()).toBe(pairedOrder)
    expect(store.getCellView("a")?.translated).toBe("Updated")
    store.replaceRowsForCell("a", [target])
    expect(store.getCellIds()).toEqual(["b", "a"])
    store.replaceRowsForCell("a", [a, target])
    expect(store.getCellIds()).toEqual(["a", "b"])
    store.replaceRowsForCell("a", [a, { ...target, targetLang: "es" }])
    expect(store.getCellIds()).toEqual(["a", "b"])
    expect(store.getCellView("a")?.translated).toBe("")
    expect(store.toRows()).toContainEqual({ ...target, targetLang: "es" })
    store.replaceRowsForCell("a", [])
    expect(store.getCellIds()).toEqual(["b"])
    expect(store.getCellView("a")).toBeNull()
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
