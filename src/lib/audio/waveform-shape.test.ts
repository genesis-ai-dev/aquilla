// The shape both waveform surfaces draw. (AQU-646)
//
// `envelopePoints` is consumed directly by CellWaveform's canvas and through
// `waveformPathD` by the timeline's SVG, so it is the one place that decides
// whether the same take looks like the same take in both.

import { describe, expect, it } from "vitest"
import { envelopePoints, envelopePath, VERTICAL_INSET_PX } from "./waveform-shape"

describe("envelopePoints", () => {
  it("puts one point per bin, at the bin's CENTRE", () => {
    const pts = envelopePoints(new Float32Array([1, 1, 1]), 40)
    expect(pts.map((p) => p.x)).toEqual([0.5, 1.5, 2.5])
  })

  it("halves the drawn height, because the caller mirrors it about the midline", () => {
    const pts = envelopePoints(new Float32Array([1]), 40)
    // 40 less the 2px inset = 38 usable, so 19 either side of the middle.
    expect(pts[0].y).toBe((40 - VERTICAL_INSET_PX) / 2)
  })

  it("floors silence at a hairline instead of nothing", () => {
    // A silent stretch inside a take is the gap between words; drawing nothing
    // there reads as the take having stopped.
    const pts = envelopePoints(new Float32Array([0, 0]), 40)
    expect(pts.every((p) => p.y === 0.5)).toBe(true)
  })

  it("scales with the height it is given, so every surface shares one shape", () => {
    const tall = envelopePoints(new Float32Array([1]), 72)
    const short = envelopePoints(new Float32Array([1]), 18)
    expect(tall[0].y).toBeGreaterThan(short[0].y)
    expect(tall[0].x).toBe(short[0].x)
  })

  it("survives a corrupt peak without producing NaN geometry", () => {
    const pts = envelopePoints(new Float32Array([Number.NaN, -1, Infinity]), 40)
    expect(pts.every((p) => Number.isFinite(p.y) && p.y >= 0.5)).toBe(true)
  })

  it("is total on an empty clip", () => {
    expect(envelopePoints(new Float32Array(0), 40)).toEqual([])
  })
})

describe("envelopePath", () => {
  it("closes the figure so it fills rather than strokes", () => {
    const d = envelopePath(envelopePoints(new Float32Array([1, 1]), 40), 20)
    expect(d.endsWith("Z")).toBe(true)
  })

  it("draws a single-bin clip as a bar rather than a degenerate line", () => {
    // One point has no run to trace out and back; without the special case the
    // whole clip would vanish.
    const d = envelopePath(envelopePoints(new Float32Array([1]), 40), 20)
    expect(d).toContain("h1")
    expect(d.endsWith("z")).toBe(true)
  })

  it("is total on no points", () => {
    expect(envelopePath([], 20)).toBe("")
  })
})
