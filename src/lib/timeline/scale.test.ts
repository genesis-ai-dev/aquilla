import { describe, it, expect } from "vitest"
import { secToPx, pxToSec, clampRange, isVisible, chipRadiusPx } from "./scale"

describe("scale", () => {
  it("converts seconds<->px round-trip", () => {
    expect(secToPx(4, 38)).toBe(152)
    expect(pxToSec(152, 38)).toBeCloseTo(4)
  })
  it("clampRange enforces min duration, non-negative start, finite", () => {
    expect(clampRange(5, 5.1, 0.3)).toEqual({ startSec: 5, endSec: 5.3 })
    expect(clampRange(-2, 1, 0.3)).toEqual({ startSec: 0, endSec: 1 })
    // invalid start resets to 0; a valid end past the min is kept as-is
    expect(clampRange(NaN, 1, 0.3)).toEqual({ startSec: 0, endSec: 1 })
    // invalid end falls back to start, then min duration applies
    expect(clampRange(5, NaN, 0.3)).toEqual({ startSec: 5, endSec: 5.3 })
  })
  it("isVisible is half-open intersection", () => {
    expect(isVisible(0, 3, 2, 8)).toBe(true)
    expect(isVisible(8, 9, 2, 8)).toBe(false) // touches end, excluded
    expect(isVisible(1, 2, 2, 8)).toBe(false) // ends at view start
  })
})

// AQU-646 round 9b. Sam saw what looked like a cue chip OVERLAPPING a silence
// chip when zoomed out — one wall solid, one dashed. Nothing overlapped: the
// data tiles and so do the drawn boxes. The illusion was built at the shared
// walls, by a constant 8px corner on a 26px chip. The radius now shrinks with
// the chip, so a narrow one is effectively square and flush walls read as a
// boundary rather than two interlocking shapes.
describe("chipRadiusPx", () => {
  const ratio = (w: number) => chipRadiusPx(w) / w

  it("leaves normal-zoom chips exactly as they were", () => {
    // At the default 38px/s anything from about a second upward clears 40px.
    expect(chipRadiusPx(40)).toBe(8)
    expect(chipRadiusPx(120)).toBe(8)
    expect(chipRadiusPx(1000)).toBe(8)
  })

  it("ramps down to square, rather than clipping to a fixed proportion", () => {
    // THE POINT of the whole helper, and what the first attempt got wrong:
    // min(max, width/4) holds the radius at a constant quarter of the width, so
    // every narrow chip is proportionally identical and none looks any squarer.
    // Here the ratio has to FALL as the chip narrows.
    expect(ratio(32)).toBeGreaterThan(ratio(20))
    expect(ratio(20)).toBeGreaterThan(ratio(12))
    expect(ratio(12)).toBeGreaterThan(ratio(8))
  })

  it("nearly halves the corner on the chip from Sam's screenshot", () => {
    // 26px, wedged between two dashed silences — the exact shape that read as
    // one interlocked box with a solid wall and a dashed wall.
    expect(chipRadiusPx(26)).toBeCloseTo(4.71, 2)
  })

  it("a sliver is square, not a lozenge", () => {
    expect(chipRadiusPx(6)).toBe(0)
    expect(chipRadiusPx(4)).toBe(0)
    expect(chipRadiusPx(1)).toBe(0)
  })

  it("is continuous — no step for an animated zoom to pop across", () => {
    // Zoom glides, so a threshold anywhere would make every chip's corners jump
    // mid-animation. Sweep the whole interesting range in half-pixel steps.
    let worst = 0
    for (let w = 0.5; w <= 120; w += 0.5) {
      worst = Math.max(worst, Math.abs(chipRadiusPx(w) - chipRadiusPx(w - 0.5)))
    }
    // Slope is maxPx / (40 - 6) below the cap and 0 above it, so half a pixel of
    // width can never move the radius by more than ~0.118px.
    expect(worst).toBeLessThanOrEqual(8 / 34 / 2 + 1e-9)
  })

  it("never exceeds a quarter of the chip, at any width", () => {
    // The browser pass asserts this geometrically against the real episode;
    // pinning it here too means a future tweak to the ramp cannot quietly
    // invalidate that guard.
    for (let w = 1; w <= 200; w += 1) {
      expect(chipRadiusPx(w)).toBeLessThanOrEqual(w / 4)
    }
  })

  it("honours a smaller cap — the dub chip's own rounding", () => {
    expect(chipRadiusPx(200, 6)).toBe(6)
    expect(chipRadiusPx(40, 6)).toBe(6)
    // Same ramp, scaled to the smaller cap.
    expect(chipRadiusPx(23, 6)).toBeCloseTo(3, 2)
  })

  it("answers square for anything it cannot measure", () => {
    // A non-finite width means something upstream is broken; square corners are
    // a harmless way to be wrong, and never a NaN in a style attribute.
    expect(chipRadiusPx(0)).toBe(0)
    expect(chipRadiusPx(-40)).toBe(0)
    expect(chipRadiusPx(NaN)).toBe(0)
    expect(chipRadiusPx(Infinity)).toBe(0)
  })
})
