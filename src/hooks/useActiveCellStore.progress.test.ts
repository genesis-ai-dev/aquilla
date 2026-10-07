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
  canonicalRef: string | null,
  endorsementCount = 0,
  metadata?: Record<string, unknown>,
): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef,
    anchorCellId: null,
    eventId: `${side}-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: endorsementCount >= 2,
    wordCount: value ? 1 : 0,
    endorsementCount,
    metadata: metadata ?? null,
  }
}

describe("CellStore progress selectors", () => {
  it("retains indexes for a text acknowledgement while refreshing the displayed row", () => {
    const store = new CellStore()
    store.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations: 2, auditStats: new Map() })
    const source = row("a", "source", "Source", "GEN 1:1")
    const target = row("a", "target", "Draft", "GEN 1:1")
    store.replaceRows([source, target])
    const progress = store.getFileProgressSnapshot()
    const navigation = store.getNavigationIndex()
    store.replaceRowsForCell("a", [{ ...source }, { ...target, value: "Confirmed draft", eventId: "ack", valueHtml: "<p>Confirmed draft</p>" }])
    expect(store.getFileProgressSnapshot()).toBe(progress)
    expect(store.getNavigationIndex()).toBe(navigation)
    expect(store.getCellView("a")?.translated).toBe("Confirmed draft")
    expect(store.getCellSummary("a")?.targetEventId).toBe("ack")
  })

  it("reuses indexes for cloned JSON metadata but refreshes changed nested milestones", () => {
    const store = new CellStore()
    const context = { projectId: "p", fileId: "f", username: "alice", requiredValidations: 2, auditStats: new Map() }
    store.setRuntime(context)
    const metadata = { aquillaImport: { milestone: { key: "custom", kind: "section", label: "First", shortLabel: "1" } }, nested: [1, null, { text: "value" }] }
    const source = row("a", "source", "Source", null, 0, metadata)
    const target = row("a", "target", "Draft", null)
    store.replaceRows([source, target])
    const first = store.getFileProgressSnapshot()
    const navigation = store.getNavigationIndex()
    const cloned = JSON.parse(JSON.stringify(metadata))
    store.replaceRowsForCell("a", [{ ...source, metadata: { nested: cloned.nested, aquillaImport: cloned.aquillaImport } }, target])
    expect(store.getFileProgressSnapshot()).toBe(first)
    expect(store.getNavigationIndex()).toBe(navigation)
    const changed = JSON.parse(JSON.stringify(cloned))
    changed.aquillaImport.milestone.label = "Changed"
    // New immutable payload; never mutate a metadata object already installed.
    store.replaceRowsForCell("a", [{ ...source, metadata: changed }, target])
    const cold = new CellStore()
    cold.setRuntime(context)
    cold.replaceRows(store.toRows())
    expect(store.getNavigationIndex()).toEqual(cold.getNavigationIndex())
    expect(store.getNavigationIndex()[0].label).toBe("Changed")
  })

  it("conservatively rebuilds for changed arrays and non-JSON metadata", () => {
    const cyclicA: Record<string, unknown> = {}; cyclicA.self = cyclicA
    const cyclicB: Record<string, unknown> = {}; cyclicB.self = cyclicB
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ extra: [1, 2] }, { extra: [2, 1] }],
      [{ extra: new Date(0) }, { extra: new Date(0) }],
      [cyclicA, cyclicB],
      [{ extra: [] }, { extra: new Array(1) }],
      [{ extra: 1 }, { extra: "1" }],
    ]
    for (const [before, after] of cases) {
      const store = new CellStore()
      store.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map() })
      const source = row("a", "source", "Source", "GEN 1:1", 0, before)
      const target = row("a", "target", "Draft", "GEN 1:1")
      store.replaceRows([source, target])
      const snapshot = store.getFileProgressSnapshot()
      store.replaceRowsForCell("a", [{ ...source, metadata: after }, target])
      expect(store.getFileProgressSnapshot()).not.toBe(snapshot)
      expect(store.getFileProgressSnapshot()).toEqual(snapshot)
    }
  })

  it("matches cold indexes for every targeted structural/progress input, even with unchanged event IDs", () => {
    const context = { projectId: "p", fileId: "f", username: "alice", requiredValidations: 2, auditStats: new Map() }
    const changes: Array<{ source?: Partial<CellRow>; target?: Partial<CellRow> }> = [
      { source: { value: "Different source" } },
      { source: { value: "Source \\f + \\ft note\\f*" } },
      { source: { canonicalRef: "EXO 2:1" } },
      { target: { canonicalRef: "EXO 2:1" } },
      { source: { type: "heading" } },
      { target: { type: "heading" } },
      { source: { startMs: 500 } },
      { target: { startMs: 800 } },
      { source: { metadata: { label: "Changed" } } },
      { target: { metadata: { label: "Changed" } } },
      { target: { validated: true } },
      { target: { endorsementCount: 2 } },
      { target: { value: "" } },
      { target: { value: "Draft \\f + \\ft note\\f*" } },
    ]
    for (const change of changes) {
      const store = new CellStore()
      store.setRuntime(context)
      const source = row("a", "source", "Source", "GEN 1:1")
      const target = row("a", "target", "Draft", "GEN 1:1")
      const next = { ...row("b", "source", "Next", "GEN 1:2"), anchorCellId: "a" }
      store.replaceRows([source, target, next])
      store.getFileProgressSnapshot()
      store.replaceRowsForCell("a", [{ ...source, ...change.source }, { ...target, ...change.target }])
      const cold = new CellStore()
      cold.setRuntime(context)
      cold.replaceRows(store.toRows())
      expect(store.getNavigationIndex()).toEqual(cold.getNavigationIndex())
      expect(store.getFileProgressSnapshot()).toEqual(cold.getFileProgressSnapshot())
      expect(store.getFootnoteOffsets("b")).toEqual(cold.getFootnoteOffsets("b"))
      expect(store.getAllSummaries()).toEqual(cold.getAllSummaries())
    }
  })

  it("clears confirmed shadows without rebuilding unchanged progress, including pending-layer precedence", () => {
    const context = { projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map() }
    const store = new CellStore()
    store.setRuntime(context)
    store.replaceRows([row("a", "source", "Source", "GEN 1:1"), row("a", "target", "Draft", "GEN 1:1")])
    store.applyOptimisticTargetEdit("a", { value: "Saved" })
    const snapshot = store.getFileProgressSnapshot()
    const navigation = store.getNavigationIndex()
    const beforeVersion = store.getCellVersion("a")
    store.clearConfirmedShadows([row("a", "target", "Saved", "GEN 1:1")], store.getWriteSeq())
    expect(store.getMemorySnapshot().optimisticEdits).toBe(0)
    expect(store.getFileProgressSnapshot()).toBe(snapshot)
    expect(store.getNavigationIndex()).toBe(navigation)
    expect(store.getCellVersion("a")).not.toBe(beforeVersion)
    expect(store.getCellView("a")?.translated).toBe("Saved")

    store.applyOptimisticTargetEdit("a", { value: "New saved" })
    store.setPendingOverlay(new Map([["a", { value: "", targetLang: "" }]]))
    expect(store.getFileProgressSnapshot()?.file.filledCount).toBe(1)
    store.clearConfirmedShadows([row("a", "target", "New saved", "GEN 1:1")], store.getWriteSeq())
    expect(store.getFileProgressSnapshot()?.file.filledCount).toBe(0)
    expect(store.getNavigationIndex()[0].translated).toBe(0)
    expect(store.getCellView("a")?.translated).toBe("")
    expect(snapshot?.file.filledCount).toBe(1)
  })

  it("keeps newer shadows and previously dirty structural indexes intact on confirmation", () => {
    const store = new CellStore()
    store.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map() })
    const source = row("a", "source", "Source", "GEN 1:1")
    store.replaceRows([source])
    const staleSeq = store.getWriteSeq()
    store.applyOptimisticTargetEdit("a", { value: "Saved" })
    store.getFileProgressSnapshot()
    store.clearConfirmedShadows([row("a", "target", "Saved", "GEN 1:1")], staleSeq)
    expect(store.getMemorySnapshot().optimisticEdits).toBe(1)
    store.replaceRowsForCell("a", [{ ...source, canonicalRef: "EXO 2:1" }, row("a", "target", "Saved", "EXO 2:1")])
    store.clearConfirmedShadows([row("a", "target", "Saved", "EXO 2:1")], store.getWriteSeq())
    expect(store.getNavigationIndex()[0].label).toBe("Exodus 2")
    expect(store.getFileProgressSnapshot()?.sections[0].key).toBe("EXO 2")
  })

  it("reuses navigation across nonempty text edits but refreshes counts and structure", () => {
    const context = { projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map() }
    const store = new CellStore()
    store.setRuntime(context)
    const source = row("a", "source", "Source", "GEN 1:1")
    store.replaceRows([source, row("a", "target", "Draft", "GEN 1:1")])
    const first = store.getNavigationIndex()
    const snapshot = structuredClone(first)
    store.applyOptimisticTargetEdit("a", { value: "Longer draft" })
    expect(store.getNavigationIndex()).toBe(first)
    store.applyOptimisticTargetEdit("a", { value: "   " })
    const empty = store.getNavigationIndex()
    expect(empty).not.toBe(first)
    expect(empty[0]).toMatchObject({ translated: 0, total: 1 })
    expect(empty[0].subsections[0].translated).toBe(0)
    expect(first).toEqual(snapshot)
    store.replaceRowsForCell("a", [{ ...source, canonicalRef: "EXO 2:1" }, row("a", "target", "", "EXO 2:1", 2)])
    expect(store.getNavigationIndex()[0]).toMatchObject({ label: "Exodus 2", validated: 1 })
  })

  it("matches a cold build across lanes, pending edits, audio, display order and reset", () => {
    const store = new CellStore()
    const base = { projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map() }
    const rows = [
      row("a", "source", "one", "GEN 1:1"),
      { ...row("b", "source", "two", "GEN 1:2"), anchorCellId: "a" },
      row("a", "target", "draft", "GEN 1:1", 2),
      { ...row("b", "target", "French", "GEN 1:2"), targetLang: "fr" },
    ]
    store.setRuntime(base)
    store.replaceRows(rows)
    store.getNavigationIndex()
    const display = ["a", "b"]
    for (const lane of ["fr", "", "fr"]) {
      const context = { ...base, lane, ownTakeCellIds: new Set(["a"]) }
      const pending = new Map([["b", { value: lane ? "" : "pending", targetLang: lane }]])
      store.setRuntime(context)
      store.setPendingOverlay(pending)
      const cold = new CellStore()
      cold.setRuntime(context)
      cold.replaceRows(rows)
      cold.setPendingOverlay(pending)
      expect(store.getNavigationIndex()).toEqual(cold.getNavigationIndex())
      expect(store.getNavigationIndex(display)).toEqual(cold.getNavigationIndex(display))
      // In-place lens reordering must invalidate even when the ID array is reused.
      display.reverse()
      expect(store.getNavigationIndex(display)).toEqual(cold.getNavigationIndex([...display]))
    }
    store.reset("p", "new")
    expect(store.getNavigationIndex()).toEqual([])
  })

  it("preserves indexes for progress-neutral edits while publishing fresh cell text", () => {
    const store = new CellStore()
    const context = { projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map() }
    store.setRuntime(context)
    store.replaceRows([
      row("a", "source", "Source", "GEN 1:1"), row("a", "target", "Draft", "GEN 1:1"),
      { ...row("b", "source", "Second", "GEN 1:2"), anchorCellId: "a" },
    ])
    const progress = store.getFileProgressSnapshot()
    const navigation = store.getNavigationIndex()
    const summary = store.getAllSummaries()
    store.applyOptimisticTargetEdit("a", { value: "Revised draft" })
    expect(store.getFileProgressSnapshot()).toBe(progress)
    expect(store.getNavigationIndex()).toBe(navigation)
    expect(store.getAllSummaries()).not.toBe(summary)
    expect(store.getCellSummary("a")?.translated).toBe("Revised draft")
    store.setPendingOverlay(new Map([["a", { value: "Revised draft" }]]))
    expect(store.getFileProgressSnapshot()).toBe(progress)
    // The optimistic value wins over older pending text, including empty text.
    store.setPendingOverlay(new Map([["a", { value: "" }]]))
    expect(store.getFileProgressSnapshot()).toBe(progress)
    store.applyOptimisticTargetEdit("a", { value: "Revised \\f + \\ft note\\f*" })
    expect(store.getFileProgressSnapshot()).not.toBe(progress)
    expect(store.getFootnoteOffsets("b").target).toBe(1)
    store.applyOptimisticTargetEdit("a", { value: "" })
    expect(store.getFileProgressSnapshot()?.file.filledCount).toBe(0)
    expect(store.getNavigationIndex()[0].translated).toBe(0)
    expect(store.getFootnoteOffsets("b").target).toBe(0)
    expect(summary[0].translated).toBe("Draft")
  })

  it("rebuilds pending progress only when effective filled status changes", () => {
    const store = new CellStore()
    store.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map(), lane: "fr" })
    store.replaceRows([row("a", "source", "Source", "GEN 1:1")])
    const empty = store.getFileProgressSnapshot()
    store.setPendingOverlay(new Map([["a", { value: "Other lane", targetLang: "" }]]))
    expect(store.getFileProgressSnapshot()).toBe(empty)
    store.setPendingOverlay(new Map([["a", { value: "French", targetLang: "fr" }]]))
    const filled = store.getFileProgressSnapshot()
    expect(filled?.file.filledCount).toBe(1)
    store.setPendingOverlay(new Map([["a", { value: "Revised French", targetLang: "fr" }]]))
    expect(store.getFileProgressSnapshot()).toBe(filled)
    expect(store.getCellSummary("a")?.translated).toBe("Revised French")
    store.setPendingOverlay(new Map())
    expect(store.getFileProgressSnapshot()?.file.filledCount).toBe(0)
  })

  it("updates filled progress like a cold rebuild through new targets, clears, audio and subsection boundaries", () => {
    const store = new CellStore()
    const context = { projectId: "p", fileId: "f", username: "alice", requiredValidations: 2,
      auditStats: new Map(), ownTakeCellIds: new Set(["c73"]) }
    const sources = Array.from({ length: 117 }, (_, index) => ({
      ...row(`c${index}`, "source", `Source ${index}`, `GEN 1:${index + 1}`),
      anchorCellId: index > 0 ? `c${index - 1}` : null,
    }))
    store.setRuntime(context)
    store.replaceRows([...sources, { ...row("other", "source", "Other chapter", "GEN 2:1"), anchorCellId: "c116" }])
    const untouchedChapter = store.getNavigationIndex()[1]
    const first = store.getFileProgressSnapshot()
    const original = structuredClone(first)
    const untouchedSubsection = store.getNavigationIndex()[0].subsections[2]
    for (const [id, value] of [["c0", "First"], ["c73", "Audio text"], ["c73", ""], ["c51", "Middle"], ["c0", ""], ["c116", "Last"]]) {
      const oldOffsets = store.getFootnoteOffsets("c116")
      store.applyOptimisticTargetEdit(id, { value })
      const cold = new CellStore()
      cold.setRuntime(context)
      cold.replaceRows(store.toRows())
      expect(store.getFileProgressSnapshot()).toEqual(cold.getFileProgressSnapshot())
      expect(store.getNavigationIndex()).toEqual(cold.getNavigationIndex())
      expect(store.getFootnoteOffsets("c116")).toEqual(oldOffsets)
      if (id !== "c116") expect(store.getNavigationIndex()[0].subsections[2]).toBe(untouchedSubsection)
      expect(store.getNavigationIndex()[1]).toBe(untouchedChapter)
      expect(first).toEqual(original)
    }
    expect(store.getFileProgressSnapshot()?.file.filledCount).toBe(2)
    // c73 remains translated for navigation because its recording remains.
    expect(store.getNavigationIndex()[0].translated).toBe(3)
  })

  it("falls back when creating a target also changes inherited validation contribution", () => {
    const store = new CellStore()
    const context = { projectId: "p", fileId: "f", username: "alice", requiredValidations: 2, auditStats: new Map() }
    store.setRuntime(context)
    store.replaceRows([row("a", "source", "Source", "GEN 1:1", 3)])
    store.getFileProgressSnapshot()
    store.applyOptimisticTargetEdit("a", { value: "Draft" })
    const cold = new CellStore()
    cold.setRuntime(context)
    cold.replaceRows(store.toRows())
    expect(store.getFileProgressSnapshot()).toEqual(cold.getFileProgressSnapshot())
    expect(store.getNavigationIndex()).toEqual(cold.getNavigationIndex())
  })

  it.each([1, 2, 15])("updates audit progress incrementally at threshold %i exactly like a full rebuild", (requiredValidations) => {
    const rows = [
      row("a", "source", "one \\f + \\ft note\\f*", "GEN 1:1"),
      row("a", "target", "un", "GEN 1:1", 2),
      { ...row("b", "source", "two", "GEN 2:1"), anchorCellId: "a" },
      row("b", "target", "deux", "GEN 2:1", 3),
      { ...row("c", "source", "three", null), anchorCellId: "b" },
      { ...row("c", "target", "trois", null), endorsementCount: undefined, validated: true },
    ]
    const context = { projectId: "p", fileId: "f", username: "alice", requiredValidations }
    const store = new CellStore()
    store.setRuntime({ ...context, auditStats: new Map() })
    store.replaceRows(rows)
    const nav = store.getNavigationIndex()
    const initial = store.getFileProgressSnapshot()
    const initialCopy = structuredClone(initial)
    const transitions = [
      new Map([["a", stats("a", [])], ["b", stats("b", ["alice"])], ["c", stats("c", [])]]),
      new Map([["a", stats("a", Array.from({ length: 16 }, (_, i) => `u${i}`))], ["c", stats("c", ["bob"])]]),
      new Map<string, CellAuditStats>(),
    ]
    for (const auditStats of transitions) {
      store.setRuntime({ ...context, auditStats })
      const fresh = new CellStore()
      fresh.setRuntime({ ...context, auditStats })
      fresh.replaceRows(rows)
      expect(store.getFileProgressSnapshot()).toEqual(fresh.getFileProgressSnapshot())
      expect(store.getAllSummaries()).toEqual(fresh.getAllSummaries())
      expect(store.getNavigationIndex()).toBe(nav)
      expect(initial).toEqual(initialCopy)
    }
  })

  it("rebuilds from the latest audit data when text or validation requirements also changed", () => {
    const store = new CellStore()
    const context = { projectId: "p", fileId: "f", username: "alice", requiredValidations: 1 }
    store.setRuntime({ ...context, auditStats: new Map() })
    store.replaceRows([row("a", "source", "one", "GEN 1:1")])
    store.getFileProgressSnapshot()
    store.applyOptimisticTargetEdit("a", { value: "translated" })
    const auditStats = new Map([["a", stats("a", ["alice"])]])
    store.setRuntime({ ...context, auditStats })
    expect(store.getFileProgressSnapshot()?.file).toMatchObject({ filledCount: 1, validatedCount: 1 })
    store.setRuntime({ ...context, auditStats, requiredValidations: 2 })
    expect(store.getFileProgressSnapshot()?.file).toMatchObject({ filledCount: 1, validatedCount: 0, validationLevels: [1, 0] })
  })
  it("keeps sparse footnote offsets correct across chapters, edits, lanes and reset", () => {
    const store = new CellStore()
    const context = { projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map() }
    store.setRuntime(context)
    const a = row("a", "source", "Text \\f + \\ft source note\\f*", "GEN 1:1")
    const b = { ...row("b", "source", "plain", "GEN 1:2"), anchorCellId: "a" }
    const c = { ...row("c", "source", "plain", "GEN 2:1"), anchorCellId: "b" }
    const target = row("a", "target", "Text \\f * \\ft symbolic note\\f*", "GEN 1:1")
    store.replaceRows([a, b, c, target,
      { ...target, targetLang: "fr", value: "Texte \\f 1 \\ft note\\f*" },
    ])
    expect(store.getFootnoteOffsets("a")).toEqual({ source: 0, target: 0 })
    expect(store.getFootnoteOffsets("b")).toEqual({ source: 1, target: 0 })
    expect(store.getFootnoteOffsets("c")).toEqual({ source: 0, target: 0 })
    store.setRuntime({ ...context, lane: "fr" })
    expect(store.getFootnoteOffsets("b")).toEqual({ source: 1, target: 1 })
    store.applyOptimisticTargetEdit("a", { value: "no footnote" })
    expect(store.getFootnoteOffsets("b")).toEqual({ source: 1, target: 0 })
    store.replaceRowsForCell("a", [{ ...a, value: "no footnote" }])
    expect(store.getFootnoteOffsets("b")).toEqual({ source: 0, target: 0 })
    store.reset("p", "another-file")
    expect(store.getFootnoteOffsets("b")).toEqual({ source: 0, target: 0 })
  })
  it("derives compact file/section counts and applies optimistic target edits", () => {
    const store = new CellStore()
    store.reset("project", "file")
    store.setRuntime({
      projectId: "project",
      fileId: "file",
      username: "alice",
      requiredValidations: 2,
      auditStats: new Map(),
    })
    store.replaceRows([
      row("c1", "source", "one", "GEN 1:1"),
      row("c2", "source", "two", "GEN 2:1"),
      row("c1", "target", "uno", null, 2),
      row("c2", "target", "", null, 0),
    ], { full: true, maxServerSeq: 12 })

    const initial = store.getFileProgressSnapshot()
    expect(initial).toMatchObject({
      revision: 12,
      validationCount: 2,
      file: { totalCount: 2, filledCount: 1, validatedCount: 1, validationLevels: [1, 1] },
      sections: [
        { key: "GEN 1", totalCount: 1, filledCount: 1, validatedCount: 1 },
        { key: "GEN 2", totalCount: 1, filledCount: 0, validatedCount: 0 },
      ],
    })
    expect(store.getFileProgressSnapshot()).toBe(initial)

    store.applyOptimisticTargetEdit("c2", { value: "dos" })
    expect(store.getFileProgressSnapshot()?.file.filledCount).toBe(2)
  })

  it("includes a restored outbox text overlay without rescanning on reads", () => {
    const store = new CellStore()
    store.reset("project", "file")
    store.setRuntime({
      projectId: "project",
      fileId: "file",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
    })
    store.replaceRows([
      row("c1", "source", "one", "GEN 1:1"),
      row("c1", "target", "", null),
    ], { full: true })

    store.setPendingOverlay(new Map([
      ["c1", { value: "restored offline edit", eventId: "event-1" }],
    ]))
    const snapshot = store.getFileProgressSnapshot()
    expect(snapshot?.file.filledCount).toBe(1)
    expect(store.getFileProgressSnapshot()).toBe(snapshot)
  })

  it("wakes the per-cell listener when that cell's audit stats change, and only that cell", () => {
    const store = new CellStore()
    store.reset("project", "file")
    const base = { projectId: "project", fileId: "file", username: "alice", requiredValidations: 1 }
    store.setRuntime({ ...base, auditStats: new Map() })
    store.replaceRows([
      row("c1", "source", "one", "GEN 1:1"),
      row("c1", "target", "uno", null, 0),
      row("c2", "source", "two", "GEN 1:2"),
      row("c2", "target", "dos", null, 0),
    ], { full: true })

    let c1 = 0
    let c2 = 0
    store.subscribeCell("c1", () => { c1++ })
    store.subscribeCell("c2", () => { c2++ })
    const beforeVersion = store.getCellVersion("c1")

    // A validate action refetches audit stats for c1 only; c2 is untouched.
    store.setRuntime({ ...base, auditStats: new Map([["c1", stats("c1", ["alice"])]]) })

    expect(c1).toBe(1) // row re-renders instead of going stale until refresh
    expect(c2).toBe(0) // per-keystroke isolation preserved for unrelated rows
    expect(store.getCellVersion("c1")).toBeGreaterThan(beforeVersion)

    // A fresh-but-value-equal stats map (e.g. a full refetch) must not re-emit.
    store.setRuntime({ ...base, auditStats: new Map([["c1", stats("c1", ["alice"])]]) })
    expect(c1).toBe(1)
    expect(c2).toBe(0)
  })

  it("filters target rows to the active lane and re-derives on lane switch", () => {
    const store = new CellStore()
    store.reset("project", "file")
    store.setRuntime({
      projectId: "project",
      fileId: "file",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
      lane: "",
    })
    // One source cell with a target row in TWO lanes: '' (default) and "fr".
    const rows: CellRow[] = [
      row("c1", "source", "hello", "GEN 1:1"),
      { ...row("c1", "target", "hola", null), targetLang: "" },
      { ...row("c1", "target", "bonjour", null), targetLang: "fr", eventId: "target-c1-fr" },
    ]
    store.replaceRows(rows, { full: true, maxServerSeq: 3 })

    // Default lane: the paired view shows only the default-lane target.
    expect(store.getCellView("c1")?.translated).toBe("hola")
    // Non-active-lane rows are retained so the cache stays lane-complete.
    expect(store.toRows().filter((r) => r.side === "target")).toHaveLength(2)

    // Switching lane re-derives the view instantly (no refetch) from the
    // already-loaded rows.
    store.setRuntime({
      projectId: "project",
      fileId: "file",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
      lane: "fr",
    })
    expect(store.getCellView("c1")?.translated).toBe("bonjour")
    expect(store.toRows().filter((r) => r.side === "target")).toHaveLength(2)

    // Back to default: the default-lane target is shown again.
    store.setRuntime({
      projectId: "project",
      fileId: "file",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
      lane: "",
    })
    expect(store.getCellView("c1")?.translated).toBe("hola")
  })

  it("tracks every progress-affecting outbox id independently of text overlays", () => {
    const store = new CellStore()
    store.setPendingProgressEventIds(["commit-1", "validate-1", "validate-1"])
    expect(store.getPendingProgressEventIds()).toEqual(["commit-1", "validate-1"])
    store.setPendingProgressEventIds([])
    expect(store.getPendingProgressEventIds()).toEqual([])
  })

  it("breaks a large IDML milestone into 50-cell navigation subsections with progress", () => {
    const store = new CellStore()
    store.reset("project", "file")
    store.setRuntime({
      projectId: "project",
      fileId: "file",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
    })
    const ids = Array.from({ length: 117 }, (_, index) => `idml-${index + 1}`)
    const metadata = {
      aquillaImport: {
        milestone: {
          key: "story:Stories/Story_u363.xml:u363",
          kind: "story",
          label: "Story u363",
          shortLabel: "363",
        },
      },
      idml: { version: 2 },
    }
    store.replaceRows(ids.flatMap((id, index) => [
      row(id, "source", `Source ${index + 1}`, null, 0, metadata),
      row(id, "target", index < 55 ? `Target ${index + 1}` : "", null, index < 5 ? 2 : 0),
    ]), { full: true })

    const [story] = store.getNavigationIndex(ids)
    expect(story?.subsections.map((subsection) => ({
      label: subsection.label,
      firstIndex: subsection.firstIndex,
      total: subsection.total,
      translated: subsection.translated,
      validated: subsection.validated,
    }))).toEqual([
      { label: "1–50", firstIndex: 0, total: 50, translated: 50, validated: 5 },
      { label: "51–100", firstIndex: 50, total: 50, translated: 5, validated: 0 },
      { label: "101–117", firstIndex: 100, total: 17, translated: 0, validated: 0 },
    ])
  })
})
