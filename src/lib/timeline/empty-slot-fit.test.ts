import { describe, it, expect } from "vitest"
import { emptySlotFit, SLOT_INSET_PX, SLOT_PAIR_GAP_PX } from "./empty-slot-fit"
import { SLOT_BUTTON_MIN_PX } from "./row-metrics"

// AQU-2663 (Sam, Nov 19: "This won't do for narrow... chips"): what an empty
// line offers must fit INSIDE it. One rule, three outcomes by width.
describe("emptySlotFit", () => {
  const b = 28
  const pairNeed = 2 * b + SLOT_PAIR_GAP_PX + 2 * SLOT_INSET_PX // 68
  const oneNeed = b + 2 * SLOT_INSET_PX // 36
  const at = (lineWidthPx: number, actions: 1 | 2, neighbours: { startPx: number; endPx: number }[] = []) =>
    emptySlotFit({ lineLeftPx: 1000, lineWidthPx, buttonPx: b, actions, neighbours })

  it("a line that holds the pair with its margin gets the pair, unchanged", () => {
    expect(at(pairNeed, 2)).toEqual({ kind: "pair", sizePx: b })
    expect(at(500, 2)).toEqual({ kind: "pair", sizePx: b })
  })

  it("too narrow for the pair: one full-size button while it fits", () => {
    expect(at(pairNeed - 1, 2)).toEqual({ kind: "one", sizePx: b })
    expect(at(oneNeed, 2)).toEqual({ kind: "one", sizePx: b })
  })

  it("then the one button shrinks to fit inside, down to the 16px floor", () => {
    expect(at(oneNeed - 1, 2)).toEqual({ kind: "one", sizePx: b - 1 })
    expect(at(SLOT_BUTTON_MIN_PX + 2 * SLOT_INSET_PX, 2)).toEqual({ kind: "one", sizePx: SLOT_BUTTON_MIN_PX })
  })

  it("a line with one action never asks for the pair's room", () => {
    expect(at(oneNeed, 1)).toEqual({ kind: "one", sizePx: b })
    expect(at(30, 1)).toEqual({ kind: "one", sizePx: 22 })
  })

  it("narrower than the floor: revealed only, at the floor size, inside free space", () => {
    // 10px line, nothing around it: centred on the line, unclipped.
    const fit = at(10, 2)
    expect(fit).toEqual({ kind: "reveal", sizePx: SLOT_BUTTON_MIN_PX, boxLeftPx: -3, boxWidthPx: SLOT_BUTTON_MIN_PX, clipped: false })
  })

  it("never covers a neighbour: shifts into the empty side", () => {
    // Line at 1000..1010; a clip ends exactly at 1000, empty to the right.
    const fit = at(10, 2, [{ startPx: 900, endPx: 1000 }])
    expect(fit).toMatchObject({ kind: "reveal", boxLeftPx: 0, boxWidthPx: SLOT_BUTTON_MIN_PX, clipped: false })
    // Clip starts right at the line's end, empty to the left.
    const fit2 = at(10, 2, [{ startPx: 1010, endPx: 1100 }])
    expect(fit2).toMatchObject({ kind: "reveal", boxLeftPx: 10 - SLOT_BUTTON_MIN_PX, clipped: false })
  })

  it("with clips tight on both sides, is clipped to the line's edges", () => {
    const fit = at(10, 2, [{ startPx: 900, endPx: 1000 }, { startPx: 1010, endPx: 1100 }])
    expect(fit).toEqual({ kind: "reveal", sizePx: SLOT_BUTTON_MIN_PX, boxLeftPx: 0, boxWidthPx: 10, clipped: true })
  })

  it("a clip drawn into the line keeps its drawn part: the box is only the free space", () => {
    // A tiny take painted at its 10px minimum reaches 4px into the line.
    const fit = at(10, 2, [{ startPx: 900, endPx: 1004 }, { startPx: 1006, endPx: 1100 }])
    expect(fit).toMatchObject({ boxLeftPx: 4, boxWidthPx: 2, clipped: true })
    // Free space only on the right of the drawn take: shifted past it.
    expect(at(10, 2, [{ startPx: 990, endPx: 1006 }]))
      .toMatchObject({ boxLeftPx: 6, boxWidthPx: 16, clipped: false })
  })

  it("a line covered by a drawn clip reveals nothing", () => {
    expect(at(10, 2, [{ startPx: 990, endPx: 1012 }, { startPx: 1012, endPx: 1100 }])).toMatchObject({ boxWidthPx: 0, clipped: true })
  })

  it("uses only the empty space a little gap leaves", () => {
    // 4px free on the left, 0 on the right: 14px of room, clipped to it.
    const fit = at(10, 2, [{ startPx: 900, endPx: 996 }, { startPx: 1010, endPx: 1100 }])
    expect(fit).toMatchObject({ boxLeftPx: -4, boxWidthPx: 14, clipped: true })
  })
})
