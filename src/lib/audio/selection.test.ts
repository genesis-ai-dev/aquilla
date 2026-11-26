import { afterEach, describe, expect, it } from "vitest"

import {
  clearSelection,
  getSelectedIds,
  setSelection,
  toggleSelected,
} from "./selection"

describe("cell selection", () => {
  afterEach(() => {
    clearSelection()
  })

  it("keeps a whole chapter, including a long one", () => {
    const ids = Array.from({ length: 176 }, (_, i) => `cell-${i}`)
    setSelection(ids, ids[0])
    expect(getSelectedIds().size).toBe(176)
    expect(getSelectedIds().has("cell-175")).toBe(true)
  })

  it("toggleSelected keeps adding past a chapter of twenty", () => {
    for (let i = 0; i < 25; i += 1) toggleSelected(`cell-${i}`)
    expect(getSelectedIds().size).toBe(25)
  })
})
