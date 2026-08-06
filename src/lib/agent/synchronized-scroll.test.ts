import { describe, expect, it } from "vitest"
import { applyCellScrollAnchor, readCellScrollAnchor } from "./synchronized-scroll"

function pane(
  heights: number[],
  scrollTop: number,
): HTMLElement {
  const container = document.createElement("div")
  let top = 0
  heights.forEach((height, index) => {
    const cell = document.createElement("article")
    cell.dataset.cellId = `c${index + 1}`
    Object.defineProperties(cell, {
      offsetTop: { value: top, configurable: true },
      offsetHeight: { value: height, configurable: true },
    })
    top += height
    container.append(cell)
  })
  Object.defineProperties(container, {
    clientHeight: { value: 100, configurable: true },
    scrollHeight: { value: top, configurable: true },
  })
  container.scrollTop = scrollTop
  return container
}

describe("cell-aware synchronized scrolling", () => {
  it("aligns by cell and proportional progress instead of raw pixels", () => {
    const source = pane([100, 200, 100], 150)
    const target = pane([240, 80, 180], 0)

    const anchor = readCellScrollAnchor(source)
    expect(anchor).toEqual({ cellId: "c2", progress: 0.25 })

    expect(applyCellScrollAnchor(target, anchor!)).toBe(true)
    // Target c2 begins at 240 and is only 80px tall: 240 + 25% × 80.
    expect(target.scrollTop).toBe(260)
  })

  it("clamps at the destination scroll boundary and ignores missing cells", () => {
    const target = pane([50, 50], 0)
    expect(applyCellScrollAnchor(target, { cellId: "c2", progress: 1 })).toBe(true)
    expect(target.scrollTop).toBe(0)
    expect(applyCellScrollAnchor(target, { cellId: "missing", progress: 0 })).toBe(false)
  })
})
