import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { rehydrateFileDoc } from "./file-doc"
import type { CodexCell, CodexNotebookFile } from "@/lib/codex-editor/types"

function seedDoc(cells: CodexCell[]): Y.Doc {
  const doc = new Y.Doc()
  const cellsMap = doc.getMap("cells")
  const order = doc.getArray<string>("order")
  doc.transact(() => {
    for (const c of cells) {
      const y = new Y.Map<unknown>()
      y.set("__source", JSON.parse(JSON.stringify(c)))
      y.set("history", new Y.Array<unknown>())
      y.set("translatedXml", new Y.XmlFragment())
      cellsMap.set(c.metadata.id, y)
      order.push([c.metadata.id])
    }
    doc.getMap("meta").set("__source", { id: "f", originalName: "f" })
  })
  return doc
}

function cell(id: string, value: string, edits: CodexCell["metadata"]["edits"] = []): CodexCell {
  return {
    kind: 2, languageId: "html", value,
    metadata: { id, type: "text", edits },
  }
}

describe("rehydrateFileDoc", () => {
  it("replaces __source stash with merged cell content", () => {
    const doc = seedDoc([cell("c1", "old")])
    const merged: CodexNotebookFile = {
      cells: [cell("c1", "new", [
        { editMap: ["value"], value: "new", timestamp: 10, author: "a", type: "user-edit" },
      ])],
      metadata: { id: "f", originalName: "f" },
    }
    rehydrateFileDoc(doc, merged, Date.now())
    const y = doc.getMap("cells").get("c1") as Y.Map<unknown>
    const src = y.get("__source") as CodexCell
    expect(src.value).toBe("new")
    expect(src.metadata.edits).toHaveLength(1)
  })

  it("removes cells no longer in merged output", () => {
    const doc = seedDoc([cell("c1", "x"), cell("c2", "y")])
    const merged: CodexNotebookFile = {
      cells: [cell("c1", "only")],
      metadata: { id: "f", originalName: "f" },
    }
    rehydrateFileDoc(doc, merged, Date.now())
    expect(doc.getMap("cells").has("c2")).toBe(false)
  })

  it("adds cells that are new in merged output", () => {
    const doc = seedDoc([cell("c1", "x")])
    const merged: CodexNotebookFile = {
      cells: [cell("c1", "x"), cell("c2", "added")],
      metadata: { id: "f", originalName: "f" },
    }
    rehydrateFileDoc(doc, merged, Date.now())
    const order = doc.getArray<string>("order").toArray()
    expect(order).toEqual(["c1", "c2"])
    const c2 = doc.getMap("cells").get("c2") as Y.Map<unknown>
    expect((c2.get("__source") as CodexCell).value).toBe("added")
  })

  it("bumps __lastSyncedHistoryAt on every cell and clears unsynced history", () => {
    const doc = seedDoc([cell("c1", "x")])
    // Seed some unsynced local history.
    const hist = doc.getMap("cells").get("c1") as Y.Map<unknown>
    ;(hist.get("history") as Y.Array<unknown>).push([{ timestamp: "2026-01-01T00:00:00Z", source: "human" }])

    const merged: CodexNotebookFile = {
      cells: [cell("c1", "x")],
      metadata: { id: "f", originalName: "f" },
    }
    const ts = 123456
    rehydrateFileDoc(doc, merged, ts)
    const c1 = doc.getMap("cells").get("c1") as Y.Map<unknown>
    expect(c1.get("__lastSyncedHistoryAt")).toBe(ts)
    expect((c1.get("history") as Y.Array<unknown>).length).toBe(0)
  })

  it("updates meta __source to merged file metadata", () => {
    const doc = seedDoc([cell("c1", "x")])
    const merged: CodexNotebookFile = {
      cells: [cell("c1", "x")],
      metadata: { id: "f", originalName: "f", videoUrl: "https://example.com/v.mp4" },
    }
    rehydrateFileDoc(doc, merged, Date.now())
    const src = doc.getMap("meta").get("__source") as { videoUrl?: string }
    expect(src.videoUrl).toBe("https://example.com/v.mp4")
  })
})
