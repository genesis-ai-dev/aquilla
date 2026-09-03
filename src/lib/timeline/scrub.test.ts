// AQU-646 stage 5: the pointer-to-second half of dragging the playhead.
import { describe, it, expect } from "vitest"
import { scrubSecAt, SCRUB_INTENT_PX, SCRUB_SEEK_THROTTLE_MS } from "./scrub"

const at = (clientX: number, over: Partial<Parameters<typeof scrubSecAt>[0]> = {}) =>
  scrubSecAt({ clientX, rectLeft: 0, pxPerSec: 38, durationSec: 100, ...over })

describe("scrubSecAt", () => {
  it("maps a pointer to the second under it, at the default zoom", () => {
    expect(at(152)).toBeCloseTo(4, 5) // 152 / 38
    expect(at(0)).toBe(0)
  })

  it("measures from the surface's own left edge, not the viewport's", () => {
    // The ruler is sticky over a scroller, so its rect moves under the pointer.
    expect(at(252, { rectLeft: 100 })).toBeCloseTo(4, 5)
  })

  // THE CLAMP THE CLICK NEVER NEEDED. A click cannot land outside the element;
  // a drag holds pointer capture and keeps reporting from anywhere on screen.
  // Past the end, an unclamped second reaches `startQueueAtTime`, which owns no
  // cell there and falls back to the first playable one — so overshooting a
  // 70-minute episode would silently yank the queue back to line one.
  it("never answers past the end of the file", () => {
    expect(at(38 * 500)).toBe(100)
  })

  it("never answers before the start of the file", () => {
    // Dragging left of the track — trivially reachable with pointer capture.
    expect(at(-4000)).toBe(0)
  })

  // "Not reported yet" is a real state: an element that has not loaded, or a
  // file with no timings at all. Clamping to it would pin every answer to zero.
  it("applies only the lower bound when the duration is unknown", () => {
    for (const durationSec of [0, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(at(38 * 12, { durationSec })).toBeCloseTo(12, 5)
    }
  })

  it("answers zero rather than a non-number on junk input", () => {
    expect(at(152, { pxPerSec: 0 })).toBe(0)
    expect(at(152, { pxPerSec: Number.NaN })).toBe(0)
    expect(at(Number.NaN)).toBe(0)
    expect(at(152, { rectLeft: Number.NaN })).toBe(0)
  })

  it("keeps the gesture's constants where the gesture can find them", () => {
    // Same 3px every other drag in this timeline uses — and the reason a press
    // that never reaches it stays an ordinary click.
    expect(SCRUB_INTENT_PX).toBe(3)
    expect(SCRUB_SEEK_THROTTLE_MS).toBeGreaterThan(0)
  })
})
