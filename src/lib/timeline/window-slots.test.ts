import { describe, expect, it } from "vitest"
import { cellsInSlotWindow, slotWindow, type WindowSlot } from "./window-slots"

function book(n: number): { cells: { id: string }[]; slots: WindowSlot[] } {
  const cells = []
  const slots: WindowSlot[] = []
  for (let i = 0; i < n; i++) {
    cells.push({ id: `c${i}` })
    slots.push({ cellId: `c${i}`, startSec: i * 10, slotLenSec: 10 })
  }
  return { cells, slots }
}

describe("slotWindow", () => {
  const { slots } = book(100)

  it("keeps the slots in view and one neighbour past each edge", () => {
    // 105s sits inside the slot that starts at 100 (c10). c9 is the neighbour.
    expect(slotWindow(slots, 105, 125)).toEqual({ from: 9, to: 14 })
  })
})

describe("cellsInSlotWindow", () => {
  it("returns a short list unchanged", () => {
    const { cells, slots } = book(10)
    expect(cellsInSlotWindow(cells, slots, 0, 5)).toBe(cells)
  })

  it("returns only the lines in the column, not the rest of the book", () => {
    const { cells, slots } = book(200)
    const picked = cellsInSlotWindow(cells, slots, 105, 125)
    const ids = picked.map((c) => c.id)
    expect(ids).toContain("c10")
    expect(ids).toContain("c9")
    expect(ids).not.toContain("c0")
    expect(ids).not.toContain("c80")
    expect(picked.length).toBeLessThan(10)
  })

  it("still returns a line the programme does not place", () => {
    const { cells, slots } = book(80)
    const extra = { id: "loose" }
    const withLoose = [...cells, extra]
    const picked = cellsInSlotWindow(withLoose, slots, 105, 125)
    expect(picked.map((c) => c.id)).toContain("loose")
  })
})
