import { describe, it, expect } from "vitest"
import {
  EMPTY_SELECTION,
  applySelect,
  readSelectMods,
  selectedIdsInOrder,
  type TimelineSelection,
} from "./selection"

const ORDER = ["a", "b", "c", "d", "e"]

const sel = (primaryId: string | null, ...extraIds: string[]): TimelineSelection => ({
  primaryId,
  extraIds,
})

describe("readSelectMods", () => {
  it("reports undefined for a plain click so the card still seeks", () => {
    expect(readSelectMods({ metaKey: false, ctrlKey: false, shiftKey: false })).toBeUndefined()
  })

  it("maps ⌘ and Ctrl to toggle", () => {
    expect(readSelectMods({ metaKey: true, ctrlKey: false, shiftKey: false })).toEqual({ toggle: true })
    expect(readSelectMods({ metaKey: false, ctrlKey: true, shiftKey: false })).toEqual({ toggle: true })
  })

  it("lets Shift win over ⌘ — a range is the more specific intent", () => {
    expect(readSelectMods({ metaKey: true, ctrlKey: false, shiftKey: true })).toEqual({ range: true })
  })
})

describe("applySelect — plain click", () => {
  it("replaces the whole selection", () => {
    expect(applySelect(sel("a", "b", "c"), "d", undefined, ORDER)).toEqual(sel("d"))
  })
})

describe("applySelect — toggle (⌘-click)", () => {
  it("adds a section while leaving the primary alone", () => {
    expect(applySelect(sel("a"), "c", { toggle: true }, ORDER)).toEqual(sel("a", "c"))
  })

  it("removes a section that was already an extra", () => {
    expect(applySelect(sel("a", "b", "c"), "b", { toggle: true }, ORDER)).toEqual(sel("a", "c"))
  })

  it("promotes the next selected section when the PRIMARY is toggled off", () => {
    // The chip strip must never blank out while other sections stay selected.
    expect(applySelect(sel("a", "b", "c"), "a", { toggle: true }, ORDER)).toEqual(sel("b", "c"))
  })

  it("empties the selection when the last section is toggled off", () => {
    expect(applySelect(sel("a"), "a", { toggle: true }, ORDER)).toEqual(EMPTY_SELECTION)
  })

  it("behaves like a plain click when nothing is selected yet", () => {
    expect(applySelect(EMPTY_SELECTION, "c", { toggle: true }, ORDER)).toEqual(sel("c"))
  })

  it("never duplicates a section", () => {
    const once = applySelect(sel("a"), "c", { toggle: true }, ORDER)
    const twice = applySelect(once, "c", { toggle: true }, ORDER)
    expect(twice).toEqual(sel("a"))
  })
})

describe("applySelect — range (Shift-click)", () => {
  it("selects every section from the primary to the clicked one", () => {
    expect(applySelect(sel("b"), "d", { range: true }, ORDER)).toEqual(sel("b", "c", "d"))
  })

  it("works backwards, keeping the primary as the anchor", () => {
    expect(applySelect(sel("d"), "b", { range: true }, ORDER)).toEqual(sel("d", "b", "c"))
  })

  it("replaces any previous extras rather than accumulating", () => {
    expect(applySelect(sel("a", "e"), "c", { range: true }, ORDER)).toEqual(sel("a", "b", "c"))
  })

  it("becomes a plain selection when there is no anchor", () => {
    expect(applySelect(EMPTY_SELECTION, "c", { range: true }, ORDER)).toEqual(sel("c"))
  })

  it("falls back to toggle when an id is not in the file order", () => {
    // A range over ids we cannot place would otherwise select nothing.
    expect(applySelect(sel("a"), "zz", { range: true }, ORDER)).toEqual(sel("a", "zz"))
  })
})

describe("selectedIdsInOrder", () => {
  it("returns the selection in file order, not click order", () => {
    expect(selectedIdsInOrder(sel("d", "b", "a"), ORDER)).toEqual(["a", "b", "d"])
  })

  it("is empty when nothing is selected", () => {
    expect(selectedIdsInOrder(EMPTY_SELECTION, ORDER)).toEqual([])
  })

  it("drops ids the file no longer contains", () => {
    // Switching files must not leave an invisible section in the batch scope.
    expect(selectedIdsInOrder(sel("a", "gone"), ORDER)).toEqual(["a"])
    expect(selectedIdsInOrder(sel("gone"), ORDER)).toEqual([])
  })
})
