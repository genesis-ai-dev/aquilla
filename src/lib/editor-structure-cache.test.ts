import { describe, expect, it } from "vitest"
import { createEditorStructureCache } from "./editor-structure-cache"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellRow } from "./sync/cells-read-types"

function row(id: string, extra: Partial<CellRow> = {}): CellRow {
  return { cellId: id, side: "source", value: id, valueHtml: null, type: null,
    canonicalRef: null, anchorCellId: null, eventId: `source-${id}`, sourceEventId: null,
    lastEditor: null, lastEditAt: 0, validated: false, wordCount: 1, ...extra }
}

describe("editor structure cache with real store views", () => {
  it("retains maps for text edits and refreshes numbering, groups and removed IDs", () => {
    const store = new CellStore()
    store.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map() })
    const a = row("a")
    const b = row("b", { anchorCellId: "a" })
    const c = row("c", { anchorCellId: "b" })
    store.replaceRows([a, b, c])
    const cache = createEditorStructureCache()
    const read = () => cache.read(store.getCellIds(), store)
    const first = read()
    expect([...first.sequentialNumberByCellId]).toEqual([["a", 1], ["b", 2], ["c", 3]])
    expect(first.paragraphGroupInfoByCellId.get("a")?.memberIds).toEqual(["a", "b", "c"])
    store.applyOptimisticTargetEdit("b", { value: "Translation" })
    const edited = read()
    expect(edited.sequentialNumberByCellId).toBe(first.sequentialNumberByCellId)
    expect(edited.paragraphGroupInfoByCellId).toBe(first.paragraphGroupInfoByCellId)
    store.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations: 1,
      auditStats: new Map([["b", { cellId: "b", editCount: 1, contentHash: "", lastEditAt: 1,
        lastEditEventId: null, activeValidators: ["alice"], waivers: [] }]]) })
    // An optimistic edit intentionally remains unvalidated until its saved
    // target head is installed and the shadow is cleared.
    expect(read().paragraphGroupInfoByCellId.get("a")?.draftableCount).toBe(3)
    store.replaceRowsForCell("b", [b, row("b", { side: "target", value: "Translation",
      eventId: "saved-b", sourceEventId: b.eventId, validated: true, endorsementCount: 1 })])
    store.clearOptimisticIfValue("b", "Translation")
    expect(store.getCellView("b")?.status).toBe("validated")
    expect(read().paragraphGroupInfoByCellId.get("a")?.draftableCount).toBe(2)
    expect(first.paragraphGroupInfoByCellId.get("a")?.draftableCount).toBe(3)
    store.replaceRows([a, { ...b, type: "heading" }, c])
    expect([...read().sequentialNumberByCellId]).toEqual([["a", 1], ["c", 2]])
    // Deletion/reordering must rebuild even when surviving cell versions and
    // paragraph flags are unchanged. Previously returned maps stay immutable.
    store.replaceRows([a, { ...c, anchorCellId: "a" }])
    const deleted = read()
    expect(deleted.paragraphGroupInfoByCellId.get("a")?.memberIds).toEqual(["a", "c"])
    expect(first.paragraphGroupInfoByCellId.get("a")?.memberIds).toEqual(["a", "b", "c"])
    store.replaceRows([])
    expect(read().sequentialNumberByCellId.size).toBe(0)
    expect(read().paragraphGroupInfoByCellId.size).toBe(0)
  })
})
