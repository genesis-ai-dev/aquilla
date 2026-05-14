import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import type { EditHistory, ValidationEntry } from "@/lib/codex-editor/types"
import { seedCellEditsFromSource, seedMetaEditsFromSource } from "./seed-from-source"
import { getEditsArray, snapshotEntry } from "./yjs-helpers"
import { getMetaEditsArray } from "./commit-meta-edit"

function makeCellWithSourceEdits(edits: EditHistory[]): { doc: Y.Doc; cell: Y.Map<unknown> } {
  const doc = new Y.Doc()
  const cell = new Y.Map<unknown>()
  cell.set("__source", {
    kind: 2,
    languageId: "html",
    value: "",
    metadata: { id: "c1", type: "text", edits },
  })
  doc.getMap("cells").set("c1", cell)
  return { doc, cell }
}

describe("seedCellEditsFromSource", () => {
  it("populates cell.edits from __source.metadata.edits", () => {
    const validated: ValidationEntry = { username: "alice", creationTimestamp: 1000, updatedTimestamp: 1000, isDeleted: false }
    const { doc, cell } = makeCellWithSourceEdits([
      { author: "alice", timestamp: 1000, type: "user-edit", editMap: ["value"], value: "hi", validatedBy: [validated] },
    ])
    doc.transact(() => seedCellEditsFromSource(cell))
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(1)
    const snap = snapshotEntry(arr.get(0))
    expect(snap.authors).toEqual(["alice"])
    expect(snap.value).toBe("hi")
    expect(snap.validatedBy).toEqual([validated])
  })

  it("wipes existing cell.edits before seeding (idempotent + supports merge-pulls)", () => {
    const { doc, cell } = makeCellWithSourceEdits([
      { author: "alice", timestamp: 1000, type: "user-edit", editMap: ["value"], value: "v1" },
    ])
    doc.transact(() => seedCellEditsFromSource(cell))
    expect(getEditsArray(cell).length).toBe(1)
    doc.transact(() => seedCellEditsFromSource(cell))
    expect(getEditsArray(cell).length).toBe(1)
  })

  it("splits multi-author 'alice/bob' back into an authors array", () => {
    const { doc, cell } = makeCellWithSourceEdits([
      { author: "alice/bob", timestamp: 1000, type: "user-edit", editMap: ["value"], value: "hi" },
    ])
    doc.transact(() => seedCellEditsFromSource(cell))
    const snap = snapshotEntry(getEditsArray(cell).get(0))
    expect(snap.authors).toEqual(["alice", "bob"])
  })

  it("drops legacy string validatedBy entries", () => {
    const { doc, cell } = makeCellWithSourceEdits([
      { author: "alice", timestamp: 1000, type: "user-edit", editMap: ["value"], value: "hi",
        validatedBy: ["bob" as unknown as ValidationEntry] },
    ])
    doc.transact(() => seedCellEditsFromSource(cell))
    const snap = snapshotEntry(getEditsArray(cell).get(0))
    expect(snap.validatedBy).toEqual([])
  })

  it("no-op when __source is missing", () => {
    const doc = new Y.Doc()
    const cell = new Y.Map<unknown>()
    doc.getMap("cells").set("c1", cell)
    expect(() => doc.transact(() => seedCellEditsFromSource(cell))).not.toThrow()
    expect(getEditsArray(cell).length).toBe(0)
  })
})

describe("seedMetaEditsFromSource", () => {
  it("populates meta.edits from __source.edits and never creates validatedBy", () => {
    const doc = new Y.Doc()
    const meta = doc.getMap("meta")
    meta.set("__source", { id: "n1", originalName: "n.codex",
      edits: [{ author: "alice", timestamp: 1000, type: "user-edit", editMap: ["videoUrl"], value: "url" }] })
    doc.transact(() => seedMetaEditsFromSource(meta))
    const arr = getMetaEditsArray(meta)
    expect(arr.length).toBe(1)
    expect(snapshotEntry(arr.get(0)).validatedBy).toEqual([])
  })
})
