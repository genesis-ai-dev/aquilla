import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { rehydrateFileDoc } from "./file-doc"
import { getFragmentHtml, getPlainText } from "@/lib/richtext/translated-xml"
import type { CodexCell, CodexNotebookFile } from "@/lib/codex-editor/types"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { getEditsArray, snapshotEntry } from "@/lib/codex-editor/edits/yjs-helpers"
import { getMetaEditsArray } from "@/lib/codex-editor/edits/commit-meta-edit"

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

  it("updates translatedXml fragment to reflect merged value", () => {
    const doc = seedDoc([cell("c1", "<p>stale</p>")])
    const merged: CodexNotebookFile = {
      cells: [cell("c1", "<p>new merged value</p>", [
        { editMap: ["value"], value: "<p>new merged value</p>", timestamp: 10, author: "a", type: "user-edit" },
      ])],
      metadata: { id: "f", originalName: "f" },
    }
    rehydrateFileDoc(doc, merged, Date.now())
    const y = doc.getMap("cells").get("c1") as Y.Map<unknown>
    const frag = y.get("translatedXml") as Y.XmlFragment
    expect(getPlainText(frag)).toBe("new merged value")
    // Ensure the fragment matches __source.value so isCellDirty returns false.
    expect(getFragmentHtml(frag)).toBe((y.get("__source") as CodexCell).value)
  })

  it("re-seeds history Y.Array from merged metadata.edits", () => {
    const doc = seedDoc([cell("c1", "<p>x</p>")])
    const merged: CodexNotebookFile = {
      cells: [cell("c1", "<p>merged</p>", [
        { editMap: ["value"], value: "<p>merged</p>", timestamp: 100, author: "alice", type: "user-edit",
          validatedBy: [{ username: "alice", creationTimestamp: 100, updatedTimestamp: 100, isDeleted: false }] },
      ])],
      metadata: { id: "f", originalName: "f" },
    }
    rehydrateFileDoc(doc, merged, Date.now())
    const y = doc.getMap("cells").get("c1") as Y.Map<unknown>
    const hist = (y.get("history") as Y.Array<CellHistoryEntry>).toArray()
    expect(hist).toHaveLength(1)
    expect(hist[0].value).toBe("<p>merged</p>")
    expect(hist[0].author).toBe("alice")
    expect(hist[0].validated).toBe(true)
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

describe("rehydrateFileDoc — seeds cell.edits and meta.edits", () => {
  it("populates cell.edits from merged __source.metadata.edits", () => {
    const doc = new Y.Doc()
    const merged = {
      cells: [{
        kind: 2 as const, languageId: "html", value: "hello",
        metadata: { id: "c1", type: "text" as const, edits: [
          { author: "alice", timestamp: 1000, type: "user-edit" as const, editMap: ["value"], value: "hello",
            validatedBy: [{ username: "alice", creationTimestamp: 1000, updatedTimestamp: 1000, isDeleted: false }] },
        ] },
      }],
      metadata: { id: "n1", originalName: "n.codex" },
    }
    rehydrateFileDoc(doc, merged as never, 2000)
    const cell = doc.getMap("cells").get("c1") as Y.Map<unknown>
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(1)
    expect(snapshotEntry(arr.get(0)).authors).toEqual(["alice"])
  })

  it("wipes and rebuilds cell.edits on subsequent rehydrate (GitLab pull path)", () => {
    const doc = new Y.Doc()
    const first = {
      cells: [{ kind: 2 as const, languageId: "html", value: "v1",
        metadata: { id: "c1", type: "text" as const, edits: [
          { author: "alice", timestamp: 1000, type: "user-edit" as const, editMap: ["value"], value: "v1" },
        ] } }],
      metadata: { id: "n1", originalName: "n.codex" },
    }
    rehydrateFileDoc(doc, first as never, 2000)

    const second = {
      cells: [{ kind: 2 as const, languageId: "html", value: "v2",
        metadata: { id: "c1", type: "text" as const, edits: [
          { author: "alice", timestamp: 1000, type: "user-edit" as const, editMap: ["value"], value: "v1" },
          { author: "bob", timestamp: 4000, type: "user-edit" as const, editMap: ["value"], value: "v2" },
        ] } }],
      metadata: { id: "n1", originalName: "n.codex" },
    }
    rehydrateFileDoc(doc, second as never, 5000)

    const cell = doc.getMap("cells").get("c1") as Y.Map<unknown>
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(2)
    expect(snapshotEntry(arr.get(1)).authors).toEqual(["bob"])
  })

  it("populates meta.edits from merged __source.edits", () => {
    const doc = new Y.Doc()
    const merged = {
      cells: [],
      metadata: { id: "n1", originalName: "n.codex",
        edits: [{ author: "alice", timestamp: 1000, type: "user-edit" as const, editMap: ["videoUrl"], value: "url" }] },
    }
    rehydrateFileDoc(doc, merged as never, 2000)
    const arr = getMetaEditsArray(doc.getMap("meta"))
    expect(arr.length).toBe(1)
  })
})
