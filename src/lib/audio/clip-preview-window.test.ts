// AQU-646 stage 5: the arithmetic behind previewing one clip.
import { describe, it, expect } from "vitest"
import {
  canDecodePreview,
  grainWindow,
  previewWindowForGeom,
  shouldFireGrain,
  GRAIN_IDLE_MS,
  GRAIN_PERIOD_MS,
  GRAIN_SEC,
  PREVIEW_MAX_DECODE_SEC,
} from "./clip-preview-window"
import type { TargetChipGeom } from "@/lib/timeline/lane-timing"

const geom = (over: Partial<TargetChipGeom> = {}): TargetChipGeom =>
  ({
    anchor: 10, start: 10, end: 13, trimStartSec: 0, trimEndSec: null,
    durationSec: 3, usingFallback: false, ...over,
  }) as TargetChipGeom

describe("previewWindowForGeom", () => {
  // "As it appears in the timeline line" (Sam) — and since `takeTrims` gives
  // every recorded take a trim at birth, this is the ordinary case, not an edge.
  it("plays the trimmed window, in the CLIP's clock", () => {
    expect(previewWindowForGeom(geom({ trimStartSec: 0.4, trimEndSec: 2.1 }))).toEqual({
      startSec: 0.4, endSec: 2.1,
    })
  })

  it("plays to the natural end when nothing trims it", () => {
    expect(previewWindowForGeom(geom())).toEqual({ startSec: 0, endSec: null })
  })

  it("holds the head trim while playing to the end", () => {
    expect(previewWindowForGeom(geom({ trimStartSec: 0.4 }))).toEqual({ startSec: 0.4, endSec: null })
  })

  // A chip whose width came from its SECTION says nothing about where the sound
  // stops, so its end must not be mistaken for a trim.
  it("ignores the end of a chip that was never measured", () => {
    expect(previewWindowForGeom(geom({ usingFallback: true, trimEndSec: 2.1 }))).toEqual({
      startSec: 0, endSec: null,
    })
  })

  it("never returns a backwards window", () => {
    const w = previewWindowForGeom(geom({ trimStartSec: 2, trimEndSec: 1 }))
    expect(w.endSec).toBeGreaterThanOrEqual(w.startSec)
  })

  it("survives junk trims rather than handing NaN to the audio graph", () => {
    expect(previewWindowForGeom(geom({ trimStartSec: Number.NaN }))).toEqual({ startSec: 0, endSec: null })
    expect(previewWindowForGeom(geom({ trimEndSec: Number.NaN })).endSec).toBeNull()
  })
})

describe("grainWindow", () => {
  // THE ASYMMETRY IS THE FEATURE: the in-point keeps what follows it, the
  // out-point keeps what precedes it, and you are deciding whether the word
  // survives the cut.
  it("plays FORWARD from an in-point", () => {
    expect(grainWindow(1, "in", 3)).toEqual({ offsetSec: 1, durationSec: GRAIN_SEC })
  })

  it("plays UP TO an out-point", () => {
    const w = grainWindow(1, "out", 3)!
    expect(w.offsetSec).toBeCloseTo(1 - GRAIN_SEC, 6)
    expect(w.durationSec).toBeCloseTo(GRAIN_SEC, 6)
    // The material being thrown away is never what you hear.
    expect(w.offsetSec + w.durationSec).toBeCloseTo(1, 6)
  })

  it("clamps to the clip at the head, rather than asking for negative audio", () => {
    const w = grainWindow(0.01, "out", 3)!
    expect(w.offsetSec).toBe(0)
    expect(w.durationSec).toBeGreaterThan(0)
  })

  // Dragging the right handle to the very end must not silently stop making
  // sound — that reads as "the grains broke".
  it("shortens rather than vanishing at the tail", () => {
    const w = grainWindow(2.98, "in", 3)!
    expect(w.offsetSec).toBeCloseTo(2.98, 6)
    expect(w.durationSec).toBeCloseTo(0.02, 6)
  })

  it("makes no sound where there is none to make", () => {
    expect(grainWindow(3, "in", 3)).toBeNull()
    expect(grainWindow(1, "in", 0)).toBeNull()
    expect(grainWindow(Number.NaN, "in", 3)).toBeNull()
  })

  it("never asks for more than the whole clip", () => {
    const w = grainWindow(0, "in", 0.02)!
    expect(w.durationSec).toBeCloseTo(0.02, 6)
  })
})

describe("shouldFireGrain", () => {
  it("fires on the beat while the hand is moving", () => {
    expect(shouldFireGrain(1000, 1000 - GRAIN_PERIOD_MS, 990)).toBe(true)
  })

  it("does not fire between beats", () => {
    expect(shouldFireGrain(1000, 1000 - (GRAIN_PERIOD_MS - 5), 990)).toBe(false)
  })

  // The drone guard. Parked on a handle is where you spend most of a careful
  // trim, and repeating the same 80ms forever there is maddening.
  it("goes quiet when the hand stops, however long it has been parked", () => {
    expect(shouldFireGrain(5000, 0, 5000 - (GRAIN_IDLE_MS + 1))).toBe(false)
    expect(shouldFireGrain(5000, 0, 5000 - (GRAIN_IDLE_MS - 1))).toBe(true)
  })
})

describe("canDecodePreview", () => {
  it("decodes a spoken line — the case this feature is about", () => {
    expect(canDecodePreview(3)).toBe(true)
  })

  // 48kHz stereo Float32 is 384KB per second, and the recorder's upload control
  // accepts a 100MB file as a take. An hour decoded is 1.4GB.
  it("refuses a long attached file, which the element can seek correctly anyway", () => {
    expect(canDecodePreview(PREVIEW_MAX_DECODE_SEC + 1)).toBe(false)
    expect(canDecodePreview(3600)).toBe(false)
  })

  // A durationless webm — the exact clip an element CANNOT seek — has no length
  // to judge, so the file itself is all there is to go on.
  it("judges an unmeasured clip by its bytes", () => {
    expect(canDecodePreview(null, 1024)).toBe(true)
    expect(canDecodePreview(null, 500 * 1024 * 1024)).toBe(false)
    expect(canDecodePreview(null)).toBe(true)
  })
})
