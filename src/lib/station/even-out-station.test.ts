// AQU-2664 review M1: the Station plays and draws an evened-out take as the
// timeline does — the correction first, then the take's own volume line,
// which still reads relative to the evened level (0 dB = as evened).
import { describe, expect, it } from "vitest"
import { dbToGain, gainAt, type ClipMix } from "./edit-list"
import { STATION_WAVE_FLOOR, applyClipMix, mixWhole, peakOf, viewPeaks } from "./render"
import { stationLevelOf } from "./station-level"

const clip = (over: Partial<ClipMix> = {}): ClipMix => ({ trimA: 0, trimB: 1, fadeIn: 0, fadeOut: 0, gainDb: 0, ...over })

describe("the Station and an evened-out take", () => {
  it("works out the correction from the take, and keeps the volume line as its own volume", () => {
    const l = stationLevelOf({ gainDb: -3, loudnessLufs: -24, truePeakDb: -12, evenTargetLufs: -16 })
    expect(l.correctionDb).toBeCloseTo(8, 6)
    expect(l.ownDb).toBe(-3)
    // What the preview mixer is handed: the stages added up, as clipLevelOf.
    expect(l.playDb).toBeCloseTo(5, 6)
    expect(stationLevelOf({ gainDb: 2 })).toEqual({ correctionDb: 0, ownDb: 2, playDb: 2 })
  })

  it("plays the correction under the volume line and the fades", () => {
    const c = clip({ correctionDb: 8, gainDb: -3, fadeIn: 0.5 })
    expect(gainAt(0.75, c)).toBeCloseTo(dbToGain(5), 6)
    expect(gainAt(0.25, c)).toBeCloseTo(dbToGain(5) * 0.5, 6)
    const samples = new Float32Array(100).fill(0.1)
    expect(mixWhole(samples, 100, clip({ correctionDb: 8 }))[50]).toBeCloseTo(0.1 * dbToGain(8), 5)
    expect(applyClipMix(samples, 100, clip({ correctionDb: 8 }))[50]).toBeCloseTo(0.1 * dbToGain(8), 5)
  })

  // Evidence 72D/E/G, 73C: drawn against a FIXED headroom (full scale), at
  // the level it plays — taller when raised, never clipped into a block.
  const ramp = () => {
    const data = new Float32Array(100)
    for (let i = 0; i < 100; i++) data[i] = 0.1 * ((i % 25) + 1) / 25
    return data
  }
  const draw = (data: Float32Array, c: ClipMix) =>
    viewPeaks([{ src: "a", a: 0, b: 1, t0: 0, t1: 1 }] as never, (() => ({ data, rate: 100 })) as never, 0, 1, 20, peakOf(data), c)

  it("draws an evened take taller, at the level it plays", () => {
    const flat = draw(ramp(), clip())
    const evened = draw(ramp(), clip({ correctionDb: 6 }))
    expect(Math.max(...evened)).toBeGreaterThan(Math.max(...flat))
  })

  it("never clips: a take raised the full +12 dB is still a waveform, under full height", () => {
    const loud = ramp().map((v) => v * 9) // peak 0.9
    const held = draw(loud, clip({ correctionDb: 12 }))
    expect(Math.max(...held)).toBeLessThan(1)
    // Still a shape: its columns differ, as the recording's do.
    expect(Math.max(...held) / Math.min(...held)).toBeGreaterThan(2)
  })

  it("keeps the fades' shape inside the kept part", () => {
    const flat = draw(ramp().fill(0.5), clip({ correctionDb: 12, fadeIn: 0.5 }))
    expect(flat[1]).toBeLessThan(flat[15])
  })

  it("draws a quiet take that isn't raised small but readable", () => {
    const quiet = draw(ramp().map((v) => v / 10), clip()) // peak 0.01
    expect(Math.max(...quiet)).toBeGreaterThanOrEqual(STATION_WAVE_FLOOR * 0.9)
  })
})
