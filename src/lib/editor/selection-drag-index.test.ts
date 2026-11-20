import { describe, expect, it } from "vitest"

import { dragSelectionIndex } from "./selection-drag-index"

describe("dragSelectionIndex", () => {
  const view = { viewTop: 100, viewBottom: 700, edgeZone: 56, count: 40 }

  it("follows the mounted row, and the list edge selects the unmounted end", () => {
    const cases: { name: string; clientY: number; rowIndex: number; want: number }[] = [
      { name: "a row in the middle", clientY: 400, rowIndex: 6, want: 6 },
      { name: "the bottom edge, past the rendered rows", clientY: 660, rowIndex: 8, want: 39 },
      { name: "the top edge", clientY: 120, rowIndex: 1, want: 0 },
      { name: "no row under the pointer", clientY: 400, rowIndex: -1, want: -1 },
      { name: "an empty list", clientY: 400, rowIndex: 0, want: -1 },
    ]
    for (const entry of cases) {
      expect(dragSelectionIndex({
        ...view,
        count: entry.name === "an empty list" ? 0 : view.count,
        clientY: entry.clientY,
        rowIndex: entry.rowIndex,
      }), entry.name).toBe(entry.want)
    }
  })
})
