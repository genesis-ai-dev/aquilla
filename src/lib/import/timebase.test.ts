// The frame-grid detector and the correction it plans. (AQU-646, 2026-08-14)
//
// The numbers asserted here are the ones measured off The Chosen's real
// episode-101 files: the audio VTT sits on a 24 fps grid, the subtitle VTT on
// 23.976 with a ~1.7ms phase, and the ratio between them puts the audio cues
// about 2.4 seconds early by minute forty.

import { describe, it, expect } from "vitest"

import { detectFrameRate, planTimebaseCorrection, applyTimebaseScale } from "./timebase"
import { scaleCueTimes } from "./audio-vtt"
import type { TranslatableString } from "@/lib/parsers/types"

/** Timestamps as a real file carries them: frame-aligned, printed to ms. */
function grid(fps: number, count: number, phaseSec = 0, step = 17): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const t = ((i * step) % 60000) / fps + phaseSec
    out.push(Math.round(t * 1000) / 1000)
  }
  return out
}

/** A deterministic stand-in for timestamps that are on no grid at all. */
function randomMs(count: number): number[] {
  const out: number[] = []
  let seed = 12345
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    out.push(Math.round((seed / 2147483648) * 2400000) / 1000)
  }
  return out
}

describe("detectFrameRate", () => {
  it("reads a 24 fps grid — the audio VTT's shape", () => {
    const got = detectFrameRate(grid(24, 600))
    expect(got?.label).toBe("24")
    expect(got!.fit).toBeGreaterThan(0.95)
  })

  it("reads 23.976 through a phase offset — a file time-shifted after authoring", () => {
    // The real subtitle files sit ~1.7ms off zero. Assuming phase 0 drops the
    // fit from ~65% to ~32% and the detection fails on a perfectly good file.
    const got = detectFrameRate(grid(24000 / 1001, 600, 0.0017))
    expect(got?.label).toBe("23.976")
    expect(got!.phaseSec).toBeCloseTo(0.0017, 3)
  })

  it("does not confuse 23.976 with 24 — the whole point", () => {
    expect(detectFrameRate(grid(24, 600))?.label).toBe("24")
    expect(detectFrameRate(grid(24000 / 1001, 600))?.label).toBe("23.976")
  })

  it("prefers the true rate over a harmonic that fits just as well", () => {
    // EVERY 24 fps timestamp is also a 48/60-adjacent one, so a faster rate can
    // never score worse. Candidates are tried slowest-first for exactly this.
    const got = detectFrameRate(grid(24, 600))
    expect(got?.label).toBe("24")
    expect(got!.runnerUpFit).toBeLessThan(got!.fit)
  })

  it("refuses timestamps that are on no grid", () => {
    expect(detectFrameRate(randomMs(1200))).toBeNull()
  })

  it("refuses too small a sample to believe", () => {
    expect(detectFrameRate(grid(24, 10))).toBeNull()
  })

  it("ignores junk values rather than letting them drag the fit down", () => {
    const times = [...grid(24, 300), Number.NaN, Number.POSITIVE_INFINITY, -5]
    expect(detectFrameRate(times)?.label).toBe("24")
  })
})

describe("planTimebaseCorrection", () => {
  const NTSC = 24 / (24000 / 1001)

  it("plans the episode-101 correction: 24 fps cues onto a 23.976 file", () => {
    const plan = planTimebaseCorrection({
      cueTimes: grid(24, 600),
      referenceTimes: grid(24000 / 1001, 600, 0.0017),
      lastCueSec: 2400,
    })
    expect(plan).not.toBeNull()
    expect(plan!.cue.label).toBe("24")
    expect(plan!.reference.label).toBe("23.976")
    expect(plan!.scale).toBeCloseTo(NTSC, 6)
    // ~2.4s by minute forty — the number the dialog quotes and the one Sam
    // could see against the picture.
    expect(plan!.driftAtEndSec).toBeCloseTo(2.4, 1)
  })

  it("says nothing when both sides are on the same grid", () => {
    expect(
      planTimebaseCorrection({
        cueTimes: grid(24, 600),
        referenceTimes: grid(24, 600, 0.002),
        lastCueSec: 2400,
      }),
    ).toBeNull()
  })

  it("is symmetric — cues SLOWER than the file are reported too", () => {
    // Hardcoding 1.001 would quietly do the wrong thing the first time a file
    // arrives the other way round.
    const plan = planTimebaseCorrection({
      cueTimes: grid(24000 / 1001, 600),
      referenceTimes: grid(24, 600),
      lastCueSec: 2400,
    })
    expect(plan!.scale).toBeLessThan(1)
    expect(plan!.driftAtEndSec).toBeLessThan(0)
  })

  it("says nothing when the reference file can't be read confidently", () => {
    expect(
      planTimebaseCorrection({
        cueTimes: grid(24, 600),
        referenceTimes: randomMs(1200),
        lastCueSec: 2400,
      }),
    ).toBeNull()
  })

  it("says nothing when there is no reference at all", () => {
    expect(
      planTimebaseCorrection({ cueTimes: grid(24, 600), referenceTimes: [], lastCueSec: 2400 }),
    ).toBeNull()
  })
})

describe("applying the correction", () => {
  const cue = (over: Partial<TranslatableString>): TranslatableString => ({
    id: "c1",
    original: "hello",
    translated: "",
    context: "",
    group: "",
    type: "cue",
    ...over,
  })

  it("lands on whole milliseconds — the storage unit downstream", () => {
    expect(applyTimebaseScale(2353.7, 24 / (24000 / 1001))).toBe(2356.054)
  })

  it("moves a cue's start and end together", () => {
    const [out] = scaleCueTimes([cue({ start: 63.209, end: 63.667 })], 24 / (24000 / 1001))
    expect(out.start).toBeCloseTo(63.272, 3)
    expect(out.end).toBeCloseTo(63.731, 3)
  })

  it("leaves an untimed cue's absent timings absent", () => {
    // Defaulting a missing start to zero would file the cue at the head of the
    // film, which is worse than leaving it where the parser put it.
    const [out] = scaleCueTimes([cue({})], 1.001)
    expect(out.start).toBeUndefined()
    expect(out.end).toBeUndefined()
  })

  it("is a no-op at scale 1 and never mutates its input", () => {
    const input = [cue({ start: 10, end: 12 })]
    const out = scaleCueTimes(input, 1)
    expect(out[0].start).toBe(10)
    expect(out).not.toBe(input)
  })
})
