import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { CellStore } from "./useActiveCellStore"
import { useImportCellRefs } from "./useImportCellRefs"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { matchEBibleToSourceCells } from "@/lib/import"
import { matchTargetRowsByRef } from "@/lib/import-file-target"

function row(side: "source" | "target", value: string, lane = ""): CellRow {
  return {
    cellId: "a", side, targetLang: lane, value, valueHtml: null,
    type: "verse", canonicalRef: "GEN 1:1", anchorCellId: null,
    eventId: `${side}-${lane}-${value}`, sourceEventId: null,
    lastEditor: "alice", lastEditAt: 1, validated: false, wordCount: 1,
    startMs: 1000, endMs: 2000,
  }
}

function seeded(fileId = "f") {
  const store = new CellStore()
  const context = { projectId: "p", fileId, username: "alice", requiredValidations: 1, auditStats: new Map() }
  store.setRuntime(context)
  store.replaceRows([row("source", "Source"), row("target", "Default"), row("target", "French", "fr")])
  return { store, context }
}

describe("import dialog cell references", () => {
  it("does no mapping and preserves empty identities while both dialogs are closed", () => {
    const { store } = seeded()
    const cells = Array.from({ length: 31_215 }, () => store.getAllSummaries()[0])
    const map = vi.spyOn(cells, "map")
    const { result, rerender } = renderHook(({ cells }) => useImportCellRefs(cells, false, false), { initialProps: { cells } })
    const previous = result.current
    rerender({ cells: [...cells] })
    expect(map).not.toHaveBeenCalled()
    expect(result.current.importSourceCells).toBe(previous.importSourceCells)
    expect(result.current.fileTargetCells).toBe(previous.fileTargetCells)
    expect(result.current.importSourceCells).toEqual([])
    expect(result.current.fileTargetCells).toEqual([])
  })

  it("opens with the current lane and event heads and refreshes an open dialog after edits", () => {
    const { store, context } = seeded()
    const { result, rerender } = renderHook(
      ({ cells, importOpen, fileImportOpen }) => useImportCellRefs(cells, importOpen, fileImportOpen),
      { initialProps: { cells: store.getAllSummaries(), importOpen: false, fileImportOpen: false } },
    )
    store.setRuntime({ ...context, lane: "fr" })
    rerender({ cells: store.getAllSummaries(), importOpen: true, fileImportOpen: false })
    expect(result.current.fileTargetCells).toEqual([])
    expect(matchEBibleToSourceCells([{ ref: "GEN 1:1", text: "Incoming" }], result.current.importSourceCells).matched[0])
      .toMatchObject({ cellId: "a", fileId: "f", currentText: "French", parentId: "target-fr-French", hasConflict: true })

    const changed = row("target", "New French", "fr")
    store.replaceRowsForCell("a", [row("source", "Source"), row("target", "Default"), changed])
    rerender({ cells: store.getAllSummaries(), importOpen: true, fileImportOpen: true })
    expect(result.current.fileTargetCells[0]).toMatchObject({ original: "Source", translated: "New French", startMs: 1000, endMs: 2000 })
    expect(matchTargetRowsByRef([{ ref: "GEN 1:1", text: "Incoming" }], result.current.fileTargetCells).matched[0])
      .toMatchObject({ cellId: "a", currentText: "New French", parentId: changed.eventId, sourceText: "Source" })

    rerender({ cells: store.getAllSummaries(), importOpen: false, fileImportOpen: false })
    store.setRuntime({ ...context, lane: "" })
    rerender({ cells: store.getAllSummaries(), importOpen: false, fileImportOpen: true })
    expect(result.current.importSourceCells).toEqual([])
    expect(result.current.fileTargetCells[0]).toMatchObject({ translated: "Default", targetEventId: "target--Default" })
    const otherFile = seeded("other-file")
    rerender({ cells: otherFile.store.getAllSummaries(), importOpen: true, fileImportOpen: true })
    expect(result.current.importSourceCells[0].fileId).toBe("other-file")
    expect(result.current.fileTargetCells[0].fileId).toBe("other-file")
  })
})
