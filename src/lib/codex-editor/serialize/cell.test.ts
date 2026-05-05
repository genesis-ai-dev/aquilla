import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as Y from "yjs"
import { serializeCell } from "./cell"
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"
import { toggleCellValidation } from "@/lib/codex-editor/edits/toggle-cell-validation"
import { setPlainText } from "@/lib/richtext/translated-xml"

function setupCell(): Y.Map<unknown> {
  const doc = new Y.Doc()
  const cell = new Y.Map<unknown>()
  const frag = new Y.XmlFragment()
  cell.set("translatedXml", frag)
  cell.set("__source", {
    kind: 2, languageId: "html", value: "",
    metadata: { id: "c1", type: "text", edits: [] },
  })
  doc.getMap("cells").set("c1", cell)
  return cell
}

describe("serializeCell — cell.edits → metadata.edits", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 3, 20, 10, 0, 0)) })
  afterEach(() => { vi.useRealTimers() })

  it("emits metadata.edits empty when cell.edits is empty", () => {
    const cell = setupCell()
    const out = serializeCell(cell)
    expect(out.metadata.edits).toEqual([])
  })

  it("emits single-author entry with author string unchanged + explicit validation", () => {
    const cell = setupCell()
    const frag = cell.get("translatedXml") as Y.XmlFragment
    setPlainText(frag, "hello")
    const yDoc = cell.doc!
    commitCellEdit(yDoc, "c1", "alice", ["value"], "hello", "human")
    // Validation is now strictly explicit — the user must opt in.
    toggleCellValidation(yDoc, "c1", "alice", true)
    const out = serializeCell(cell)
    expect(out.metadata.edits).toHaveLength(1)
    expect(out.metadata.edits![0].author).toBe("alice")
    expect(out.metadata.edits![0].validatedBy).toEqual([
      expect.objectContaining({ username: "alice", isDeleted: false }),
    ])
  })

  it("emits 'alice/bob' when a session has multiple authors", () => {
    const cell = setupCell()
    const frag = cell.get("translatedXml") as Y.XmlFragment
    setPlainText(frag, "hi")
    const yDoc = cell.doc!
    commitCellEdit(yDoc, "c1", "alice", ["value"], "hi", "human")
    vi.advanceTimersByTime(60_000)
    commitCellEdit(yDoc, "c1", "bob", ["value"], "hi edited", "human")
    const out = serializeCell(cell)
    expect(out.metadata.edits).toHaveLength(1)
    expect(out.metadata.edits![0].author).toBe("alice/bob")
  })

  it("emits soft-deleted validators with isDeleted: true", () => {
    const cell = setupCell()
    const frag = cell.get("translatedXml") as Y.XmlFragment
    setPlainText(frag, "hi")
    const yDoc = cell.doc!
    commitCellEdit(yDoc, "c1", "alice", ["value"], "hi", "human")
    toggleCellValidation(yDoc, "c1", "alice", true)
    vi.advanceTimersByTime(60_000)
    toggleCellValidation(yDoc, "c1", "alice", false)
    const out = serializeCell(cell)
    const vb = out.metadata.edits![0].validatedBy!
    expect(vb).toHaveLength(1)
    expect(vb[0].isDeleted).toBe(true)
  })

  it("omits validatedBy when the map is empty (LLM edit)", () => {
    const cell = setupCell()
    const yDoc = cell.doc!
    commitCellEdit(yDoc, "c1", "llm", ["value"], "draft", "llm")
    const out = serializeCell(cell)
    expect(out.metadata.edits![0].validatedBy).toBeUndefined()
  })
})
