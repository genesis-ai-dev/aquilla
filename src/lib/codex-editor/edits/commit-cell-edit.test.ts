import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import { commitCellEdit } from "./commit-cell-edit"
import { getEditsArray, snapshotEntry } from "./yjs-helpers"

function setupDoc() {
  const doc = new Y.Doc()
  const cell = new Y.Map<unknown>()
  doc.getMap("cells").set("c1", cell)
  return { doc, cell }
}

describe("commitCellEdit", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 3, 20, 10, 0, 0)) })
  afterEach(() => { vi.useRealTimers() })

  it("appends a new entry on the first commit", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(1)
    const snap = snapshotEntry(arr.get(0))
    expect(snap.authors).toEqual(["alice"])
    expect(snap.value).toBe("hello")
    expect(snap.type).toBe("user-edit")
    expect(snap.validatedBy.map(v => v.username)).toEqual(["alice"])
  })

  it("updates the last entry in place for same author within 5 min", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human")
    vi.advanceTimersByTime(60_000)
    commitCellEdit(doc, "c1", "alice", ["value"], "hello world", "human")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(1)
    const snap = snapshotEntry(arr.get(0))
    expect(snap.value).toBe("hello world")
    expect(snap.authors).toEqual(["alice"])
  })

  it("appends a new entry when the gap exceeds 5 min", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human")
    vi.advanceTimersByTime(6 * 60_000)
    commitCellEdit(doc, "c1", "alice", ["value"], "later", "human")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(2)
  })

  it("appends a new entry when the editMap differs, with no validator seeded on metadata entries", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human")
    vi.advanceTimersByTime(60_000)
    commitCellEdit(doc, "c1", "alice", ["metadata", "cellLabel"], "Gen 1:1", "human")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(2)
    const metaSnap = snapshotEntry(arr.get(1))
    expect(metaSnap.editMap).toEqual(["metadata", "cellLabel"])
    // FileEditHistory shape: metadata edits carry no validators
    expect(metaSnap.validatedBy).toEqual([])
  })

  it("appends a new entry when the type differs (human vs llm)", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human")
    vi.advanceTimersByTime(60_000)
    commitCellEdit(doc, "c1", "alice", ["value"], "ai-version", "llm")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(2)
    const snap2 = snapshotEntry(arr.get(1))
    expect(snap2.type).toBe("llm-edit")
    expect(snap2.validatedBy).toEqual([])
  })

  it("extends a same-window session with a second author and auto-validates them", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hi", "human")
    vi.advanceTimersByTime(60_000)
    commitCellEdit(doc, "c1", "bob", ["value"], "hi edited", "human")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(1)
    const snap = snapshotEntry(arr.get(0))
    expect(snap.authors).toEqual(["alice", "bob"])
    expect(snap.validatedBy.map(v => v.username).sort()).toEqual(["alice", "bob"])
  })

  it("LLM commit does not seed validatedBy", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "llm-bot", ["value"], "draft", "llm")
    const arr = getEditsArray(cell)
    const snap = snapshotEntry(arr.get(0))
    expect(snap.authors).toEqual(["llm-bot"])
    expect(snap.validatedBy).toEqual([])
  })

  it("user commit after LLM entry appends a new entry and auto-validates the user", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "llm-bot", ["value"], "draft", "llm")
    vi.advanceTimersByTime(60_000)
    commitCellEdit(doc, "c1", "alice", ["value"], "polished", "human")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(2)
    const snap2 = snapshotEntry(arr.get(1))
    expect(snap2.authors).toEqual(["alice"])
    expect(snap2.validatedBy.map(v => v.username)).toEqual(["alice"])
  })

  it("no-op when cellId is missing", () => {
    const { doc } = setupDoc()
    expect(() => commitCellEdit(doc, "nonexistent", "alice", ["value"], "x", "human")).not.toThrow()
  })
})
