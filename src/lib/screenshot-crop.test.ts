import { describe, it, expect } from "vitest"
import { boxFromDrag, displayBoxToNaturalRect, isUsableBox } from "./screenshot-crop"

describe("screenshot crop geometry (AQU-2467)", () => {
  it("builds the same box whichever corner the drag starts from, kept inside the image", () => {
    const bounds = { width: 400, height: 200 }
    expect(boxFromDrag({ x: 300, y: 150 }, { x: 100, y: 50 }, bounds)).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 100,
    })
    expect(boxFromDrag({ x: 350, y: 20 }, { x: 900, y: -40 }, bounds)).toEqual({
      x: 350,
      y: 0,
      width: 50,
      height: 20,
    })
  })

  it("ignores a box under 8 px on either edge", () => {
    expect(isUsableBox(null)).toBe(false)
    expect(isUsableBox({ x: 0, y: 0, width: 7, height: 50 })).toBe(false)
    expect(isUsableBox({ x: 0, y: 0, width: 50, height: 7 })).toBe(false)
    expect(isUsableBox({ x: 0, y: 0, width: 8, height: 8 })).toBe(true)
  })

  it("scales a box from the displayed size to the natural pixels", () => {
    // 3200x1800 screenshot shown at 800x450: every displayed pixel is 4 real ones.
    expect(
      displayBoxToNaturalRect(
        { x: 100, y: 50, width: 200, height: 100 },
        { width: 800, height: 450 },
        { width: 3200, height: 1800 },
      ),
    ).toEqual({ x: 400, y: 200, width: 800, height: 400 })
  })

  it("never reaches past the natural image and keeps at least one pixel", () => {
    const rect = displayBoxToNaturalRect(
      { x: 790, y: 440, width: 10, height: 10 },
      { width: 800, height: 450 },
      { width: 1000, height: 562 },
    )
    expect(rect.x + rect.width).toBeLessThanOrEqual(1000)
    expect(rect.y + rect.height).toBeLessThanOrEqual(562)
    expect(rect.width).toBeGreaterThanOrEqual(1)
    expect(rect.height).toBeGreaterThanOrEqual(1)
  })
})
