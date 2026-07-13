import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(
  cellId: string,
  side: "source" | "target",
  value: string,
  canonicalRef: string | null,
  endorsementCount = 0,
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
  }
}

describe("CellStore progress selectors", () => {
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
})
