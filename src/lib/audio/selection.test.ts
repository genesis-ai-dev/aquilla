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

  it("setSelection keeps the full range (no 20-cell cap)", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `cell-${i}`)
    setSelection(ids)
    expect(getSelectedIds().size).toBe(25)
  })

  it("toggleSelected can grow past 20 cells", () => {
    for (let i = 0; i < 22; i += 1) {
      toggleSelected(`cell-${i}`)
    }
    expect(getSelectedIds().size).toBe(22)
  })
})
