import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import {
  getEditsArray,
  appendEntry,
  snapshotEntry,
  upsertValidator,
  softDeleteValidator,
  getValidatorsActive,
  entryHasAuthor,
  appendAuthor,
  editMapEquals,
  getEntryEditMap,
} from "./yjs-helpers"

function newCell(): Y.Map<unknown> {
  const doc = new Y.Doc()
  const cell = new Y.Map<unknown>()
  doc.getMap("cells").set("c1", cell)
  return cell
}

function newCellWithArr() {
  const doc = new Y.Doc()
  const cell = new Y.Map<unknown>()
  doc.getMap("cells").set("c1", cell)
  return { cell, arr: getEditsArray(cell) }
}

describe("yjs-helpers", () => {
  it("creates an edits Y.Array on first access and reuses it on second", () => {
    const cell = newCell()
    const a = getEditsArray(cell)
    const b = getEditsArray(cell)
    expect(a).toBe(b)
  })

  it("appendEntry builds a Y.Map with the expected shape", () => {
    const { arr } = newCellWithArr()
    const entry = appendEntry(arr, {
      authors: ["alice"],
      timestamp: 1000,
      type: "user-edit",
      editMap: ["value"],
      value: "hello",
      seedValidator: "alice",
    })
    const snap = snapshotEntry(entry)
    expect(snap.authors).toEqual(["alice"])
    expect(snap.timestamp).toBe(1000)
    expect(snap.type).toBe("user-edit")
    expect(snap.editMap).toEqual(["value"])
    expect(snap.value).toBe("hello")
    expect(snap.validatedBy).toEqual([
      { username: "alice", creationTimestamp: 1000, updatedTimestamp: 1000, isDeleted: false },
    ])
  })

  it("appendEntry omits validatedBy when seedValidator is undefined", () => {
    const { arr } = newCellWithArr()
    const entry = appendEntry(arr, {
      authors: ["alice"],
      timestamp: 1000,
      type: "llm-edit",
      editMap: ["value"],
      value: "hi",
    })
    const snap = snapshotEntry(entry)
    expect(snap.validatedBy).toEqual([])
  })

  it("upsertValidator adds a new username keyed entry", () => {
    const { arr } = newCellWithArr()
    const entry = appendEntry(arr, {
      authors: ["alice"],
      timestamp: 1000,
      type: "user-edit",
      editMap: ["value"],
      value: "hi",
      seedValidator: "alice",
    })
    upsertValidator(entry, "bob", 2000)
    expect(getValidatorsActive(entry)).toEqual(["alice", "bob"])
  })

  it("upsertValidator re-activates a soft-deleted validator", () => {
    const { arr } = newCellWithArr()
    const entry = appendEntry(arr, {
      authors: ["alice"],
      timestamp: 1000,
      type: "user-edit",
      editMap: ["value"],
      value: "hi",
      seedValidator: "alice",
    })
    softDeleteValidator(entry, "alice", 2000)
    expect(getValidatorsActive(entry)).toEqual([])
    upsertValidator(entry, "alice", 3000)
    expect(getValidatorsActive(entry)).toEqual(["alice"])
    const snap = snapshotEntry(entry)
    const alice = snap.validatedBy.find(v => v.username === "alice")!
    expect(alice.creationTimestamp).toBe(1000)
    expect(alice.updatedTimestamp).toBe(3000)
    expect(alice.isDeleted).toBe(false)
  })

  it("softDeleteValidator on a missing username is a no-op", () => {
    const { arr } = newCellWithArr()
    const entry = appendEntry(arr, {
      authors: ["alice"],
      timestamp: 1000,
      type: "user-edit",
      editMap: ["value"],
      value: "hi",
    })
    softDeleteValidator(entry, "zoe", 2000)
    expect(getValidatorsActive(entry)).toEqual([])
    expect(snapshotEntry(entry).validatedBy).toEqual([])
  })

  it("entryHasAuthor returns false when author is absent", () => {
    const { arr } = newCellWithArr()
    const entry = appendEntry(arr, {
      authors: ["alice"],
      timestamp: 1000,
      type: "user-edit",
      editMap: ["value"],
      value: "",
    })
    expect(entryHasAuthor(entry, "alice")).toBe(true)
    expect(entryHasAuthor(entry, "bob")).toBe(false)
  })

  it("appendAuthor adds a new author to an existing entry", () => {
    const { arr } = newCellWithArr()
    const entry = appendEntry(arr, {
      authors: ["alice"],
      timestamp: 1000,
      type: "user-edit",
      editMap: ["value"],
      value: "",
    })
    appendAuthor(entry, "bob")
    expect(snapshotEntry(entry).authors).toEqual(["alice", "bob"])
  })

  it("editMapEquals handles length and element mismatches", () => {
    expect(editMapEquals(["value"], ["value"])).toBe(true)
    expect(editMapEquals(["a", "b"], ["a", "b"])).toBe(true)
    expect(editMapEquals(["a"], ["a", "b"])).toBe(false)
    expect(editMapEquals(["a"], ["b"])).toBe(false)
    expect(editMapEquals([], [])).toBe(true)
  })

  it("getEntryEditMap returns the editMap as a plain array", () => {
    const { arr } = newCellWithArr()
    const entry = appendEntry(arr, {
      authors: ["alice"],
      timestamp: 1000,
      type: "user-edit",
      editMap: ["metadata", "cellLabel"],
      value: "Gen 1:1",
    })
    expect(getEntryEditMap(entry)).toEqual(["metadata", "cellLabel"])
  })
})
