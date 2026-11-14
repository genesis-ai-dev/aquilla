// AQU-2559: the document editor must never lose words, and must never move
// the caret for a change that is only its own save coming back. Both are
// bookkeeping rules, and each case here is a way that bookkeeping went wrong
// or could.

import { describe, expect, it } from "vitest"
import { SaveLedger } from "./save-ledger"

function ledger(): SaveLedger {
  const l = new SaveLedger()
  l.reset([["v1", "old"], ["v2", ""]])
  return l
}

describe("SaveLedger", () => {
  it("saves an undo that happens while the first save is still running", () => {
    // Found live: type, the save starts, undo before it settles. The document
    // showed the old words, the store kept the typed ones, and nothing was
    // left to save.
    const l = ledger()
    l.edited("v1", "typed")
    const settle = l.begin("v1", "typed")
    l.edited("v1", "old")
    settle(true)
    expect(l.pending()).toEqual([["v1", "old"]])
  })

  it("does not repaint for its own save coming back from the store", () => {
    const l = ledger()
    l.edited("v1", "typed")
    const settle = l.begin("v1", "typed")
    expect(l.storeHolds("v1", "typed")).toBe(false)
    settle(true)
    expect(l.storeHolds("v1", "typed")).toBe(false)
    expect(l.pending()).toEqual([])
  })

  it("repaints a colleague's edit, but not over words waiting to be saved", () => {
    const l = ledger()
    expect(l.storeHolds("v2", "theirs")).toBe(true)
    l.edited("v1", "mine")
    expect(l.storeHolds("v1", "theirs")).toBe(false)
    expect(l.shown("v1", "theirs")).toBe("mine")
  })

  it("keeps the words and reports the cell when a save fails", () => {
    const l = ledger()
    l.edited("v1", "typed")
    l.begin("v1", "typed")(false)
    expect(l.pending()).toEqual([["v1", "typed"]])
    expect(l.snapshot().failed).toBe(1)
    // The store still holds the old value, and the document keeps the new one.
    expect(l.storeHolds("v1", "old")).toBe(false)
  })

  it("forgets unsaved words only for cells that left the file", () => {
    const l = ledger()
    l.edited("v1", "typed")
    l.edited("v2", "also typed")
    l.reset([["v1", "old"]])
    expect(l.pending()).toEqual([["v1", "typed"]])
  })
})
