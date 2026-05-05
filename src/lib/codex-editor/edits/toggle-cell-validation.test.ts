import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import { commitCellEdit } from "./commit-cell-edit"
import { toggleCellValidation } from "./toggle-cell-validation"
import { getEditsArray, snapshotEntry } from "./yjs-helpers"

function setupDoc() {
  const doc = new Y.Doc()
  const cell = new Y.Map<unknown>()
  doc.getMap("cells").set("c1", cell)
  return { doc, cell }
}

describe("toggleCellValidation", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 3, 20, 10, 0, 0)) })
  afterEach(() => { vi.useRealTimers() })

  it("adds a second validator (bob) on alice's edit", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hi", "human")
    toggleCellValidation(doc, "c1", "alice", true)
    vi.advanceTimersByTime(60_000)
    toggleCellValidation(doc, "c1", "bob", true)
    const snap = snapshotEntry(getEditsArray(cell).get(0))
    expect(snap.validatedBy.map(v => v.username).sort()).toEqual(["alice", "bob"])
  })

  it("soft-deletes a validator (isDeleted true, entry preserved)", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hi", "human")
    toggleCellValidation(doc, "c1", "alice", true)
    vi.advanceTimersByTime(60_000)
    toggleCellValidation(doc, "c1", "alice", false)
    const snap = snapshotEntry(getEditsArray(cell).get(0))
    expect(snap.validatedBy).toHaveLength(1)
    expect(snap.validatedBy[0].isDeleted).toBe(true)
    expect(snap.validatedBy[0].updatedTimestamp).toBeGreaterThan(snap.validatedBy[0].creationTimestamp)
  })

  it("re-validates a soft-deleted validator (isDeleted false)", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hi", "human")
    toggleCellValidation(doc, "c1", "alice", true)
    vi.advanceTimersByTime(60_000)
    toggleCellValidation(doc, "c1", "alice", false)
    vi.advanceTimersByTime(60_000)
    toggleCellValidation(doc, "c1", "alice", true)
    const snap = snapshotEntry(getEditsArray(cell).get(0))
    expect(snap.validatedBy[0].isDeleted).toBe(false)
  })

  it("targets the latest value-edit, ignoring a later metadata-edit", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hi", "human")
    toggleCellValidation(doc, "c1", "alice", true)
    vi.advanceTimersByTime(6 * 60_000)
    commitCellEdit(doc, "c1", "alice", ["metadata", "cellLabel"], "Gen 1:1", "human")
    vi.advanceTimersByTime(60_000)
    toggleCellValidation(doc, "c1", "bob", true)
    const arr = getEditsArray(cell)
    const valueEntrySnap = snapshotEntry(arr.get(0))
    const metaEntrySnap = snapshotEntry(arr.get(1))
    expect(valueEntrySnap.validatedBy.map(v => v.username).sort()).toEqual(["alice", "bob"])
    expect(metaEntrySnap.validatedBy).toEqual([])
  })

  it("no-op when no value-edit exists", () => {
    const { doc } = setupDoc()
    toggleCellValidation(doc, "c1", "alice", true)
    const cell = doc.getMap("cells").get("c1") as Y.Map<unknown>
    const arr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined
    expect(arr?.length ?? 0).toBe(0)
  })

  it("no-op when cellId is missing", () => {
    const { doc } = setupDoc()
    expect(() => toggleCellValidation(doc, "nope", "alice", true)).not.toThrow()
  })
})
