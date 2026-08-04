import { afterEach, describe, expect, it } from "vitest"

import {
  MAX_SELECTED,
  clearSelection,
  getSelectedIds,
  setSelection,
  toggleSelected,
} from "./selection"

describe("cell selection", () => {
  afterEach(() => {
    clearSelection()
  })

  it("setSelection stops at MAX_SELECTED", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `cell-${i}`)
    setSelection(ids)
    expect(getSelectedIds().size).toBe(MAX_SELECTED)
  })

  it("toggleSelected cannot grow past MAX_SELECTED", () => {
    for (let i = 0; i < MAX_SELECTED + 2; i += 1) {
      toggleSelected(`cell-${i}`)
    }
    expect(getSelectedIds().size).toBe(MAX_SELECTED)
  })
})
