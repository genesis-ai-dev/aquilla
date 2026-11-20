import { describe, expect, it } from "vitest"

import { dragSelectionIndex, idsForDrag } from "./selection-drag-index"

describe("drag selection ids", () => {
  const list = ["a", "b", "c", "d", "e", "f"]

  it("follows the row under the pointer and does not jump to the end", () => {
    const cases: { name: string; rowIndex: number; count: number; want: number }[] = [
      { name: "a row in the middle", rowIndex: 2, count: 40, want: 2 },
      { name: "the last rendered row while more exist", rowIndex: 8, count: 40, want: 8 },
      { name: "no row under the pointer", rowIndex: -1, count: 40, want: -1 },
      { name: "an empty list", rowIndex: 0, count: 0, want: -1 },
    ]
    for (const entry of cases) {
      expect(dragSelectionIndex({
        rowIndex: entry.rowIndex,
        count: entry.count,
      }), entry.name).toBe(entry.want)
    }
  })

  it("replaces on a plain drag and adds to the stored ids when continuing", () => {
    const cases: { name: string; anchor: number; focus: number; keep: ReadonlySet<string> | null; want: string[] }[] = [
      { name: "a plain drag is only the range", anchor: 1, focus: 3, keep: null, want: ["b", "c", "d"] },
      { name: "command keeps what was already stored", anchor: 4, focus: 5, keep: new Set(["a", "b"]), want: ["a", "b", "e", "f"] },
      { name: "pulling the range back drops only the new ids", anchor: 3, focus: 3, keep: new Set(["a"]), want: ["a", "d"] },
    ]
    for (const entry of cases) {
      expect(idsForDrag({
        listIds: list,
        anchorIndex: entry.anchor,
        focusIndex: entry.focus,
        keep: entry.keep,
      }), entry.name).toEqual(entry.want)
    }
  })
})