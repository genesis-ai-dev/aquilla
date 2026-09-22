import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import {
  buildProjectCellSnapshot,
  loadProjectCellFiles,
  overlayKey,
  reconcileOptimisticEdits,
} from "./useProjectCells"

function row(
  cellId: string,
  side: "source" | "target",
  value: string,
  targetLang = "",
): CellRow {
  return {
    cellId,
    side,
    targetLang,
    value,
    valueHtml: null,
    type: "text",
    canonicalRef: null,
    anchorCellId: null,
    eventId: `${side}-${targetLang}-${cellId}`,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 1,
  }
}

describe("buildProjectCellSnapshot", () => {
  it("pairs source cells only with the requested target lane", () => {
    const cells = buildProjectCellSnapshot([
      row("1", "source", "Hello"),
      row("1", "target", "Bonjour", "fr"),
      row("1", "target", "Hola", "es"),
      row("other-lane-only", "target", "Seulement français", "fr"),
    ], "f1", "es")

    expect(cells).toHaveLength(1)
    expect(cells[0].original).toBe("Hello")
    expect(cells[0].translated).toBe("Hola")
  })
})

describe("loadProjectCellFiles", () => {
  it("loads more than 40 files completely, in input order, with bounded concurrency", async () => {
    const files = Array.from({ length: 66 }, (_, index) => ({
      id: `f${index}`,
      name: `Book ${index}`,
      type: "usfm",
    }))
    let active = 0
    let maxActive = 0
    const loaded = await loadProjectCellFiles({
      projectId: "p1",
      projectFiles: files,
      getToken: async (fileId) => `token-${fileId}`,
      lane: "fr",
    }, async (_projectId, fileId, _token, _side, lane) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, Number(fileId.slice(1)) % 3))
      active--
      return [row("1", "source", fileId), row("1", "target", `${fileId}-${lane}`, lane)]
    })

    expect(loaded).toHaveLength(66)
    expect(loaded.map((file) => file.fileId)).toEqual(files.map((file) => file.id))
    expect(loaded[65].cells[0].translated).toBe("f65-fr")
    expect(maxActive).toBeLessThanOrEqual(4)
  })

  it("rejects the whole snapshot when any file cannot be authorized", async () => {
    await expect(loadProjectCellFiles({
      projectId: "p1",
      projectFiles: [
        { id: "f1", name: "One", type: "txt" },
        { id: "f2", name: "Two", type: "txt" },
      ],
      getToken: async (fileId) => fileId === "f2" ? null : "token",
    }, async () => [])).rejects.toThrow("Two")
  })
})

describe("reconcileOptimisticEdits", () => {
  const shadow = (value: string) => ({ value, valueHtml: undefined, aiDrafted: false })

  function snapshot(translated: string) {
    return [{
      fileId: "f1",
      fileName: "One",
      cells: buildProjectCellSnapshot(
        [row("c1", "source", "by grace alone"), row("c1", "target", translated)],
        "f1",
      ),
    }]
  }

  // AQU-206: the outbox row that backs the pending overlay is deleted the
  // instant the flusher accepts the write. If the optimistic shadow were
  // retired at the same moment, the drill-down row would snap back to the
  // pre-edit text and its verdict would flip back to "infringed".
  it("keeps a shadow the server snapshot has not caught up with", () => {
    const optimistic = new Map([[overlayKey("f1", "c1"), shadow("por gracia sola")]])
    const next = reconcileOptimisticEdits(optimistic, snapshot("por favor solo"))
    expect(next.get(overlayKey("f1", "c1"))?.value).toBe("por gracia sola")
  })

  it("retires a shadow once the snapshot reports the same value", () => {
    const optimistic = new Map([[overlayKey("f1", "c1"), shadow("por gracia sola")]])
    const next = reconcileOptimisticEdits(optimistic, snapshot("por gracia sola"))
    expect(next.has(overlayKey("f1", "c1"))).toBe(false)
  })

  it("keys shadows per file, so a same-named cell in another file is untouched", () => {
    const optimistic = new Map([[overlayKey("f2", "c1"), shadow("por gracia sola")]])
    const next = reconcileOptimisticEdits(optimistic, snapshot("por gracia sola"))
    expect(next.get(overlayKey("f2", "c1"))?.value).toBe("por gracia sola")
  })

  it("returns the same map identity when nothing was retired", () => {
    const optimistic = new Map([[overlayKey("f1", "c1"), shadow("por gracia sola")]])
    expect(reconcileOptimisticEdits(optimistic, snapshot("por favor solo"))).toBe(optimistic)
  })
})
