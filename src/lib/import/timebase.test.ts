// The frame-grid detector and the correction it plans. (AQU-646, 2026-08-14)
//
// The numbers asserted here are the ones measured off The Chosen's real
// episode-101 files: the audio VTT sits on a 24 fps grid, the subtitle VTT on
// 23.976 with a ~1.7ms phase, and the ratio between them puts the audio cues
// about 2.4 seconds early by minute forty.

import { assert, describe, it, expect } from "vitest"

import {
  detectFrameRate,
  measureDrift,
  planTimebaseCorrection,
  snapToFrameRatio,
  applyTimebaseScale,
} from "./timebase"
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

  it("reads a rate whose double is also on the list", () => {
    // Every 30fps timestamp is also a 60fps one, so 60 ties 30 exactly. Until
    // 2026-08-18 the margin test read that tie as doubt and refused to name
    // the file — which quietly made 25, 29.97 and 30 undetectable, half the
    // candidates. A harmonic is not a rival.
    expect(detectFrameRate(grid(30, 300))?.label).toBe("30")
    expect(detectFrameRate(grid(25, 300))?.label).toBe("25")
    expect(detectFrameRate(grid(30000 / 1001, 300))?.label).toBe("29.97")
  })

  it("ignores junk values rather than letting them drag the fit down", () => {
    const times = [...grid(24, 300), Number.NaN, Number.POSITIVE_INFINITY, -5]
    expect(detectFrameRate(times)?.label).toBe("24")
  })
})

describe("planTimebaseCorrection — the grid fingerprint alone", () => {
  const NTSC = 24 / (24000 / 1001)

  it("plans the episode-101 correction: 24 fps cues onto a 23.976 file", () => {
    const v = planTimebaseCorrection({
      cueTimes: grid(24, 600),
      referenceTimes: grid(24000 / 1001, 600, 0.0017),
      lastCueSec: 2400,
    })
    expect(v.kind).toBe("correct")
    assert(v.kind === "correct")
    expect(v.cue.label).toBe("24")
    expect(v.reference.label).toBe("23.976")
    expect(v.scale).toBeCloseTo(NTSC, 6)
    // ~2.4s by minute forty — the number the dialog quotes and the one Sam
    // could see against the picture.
    expect(v.driftAtEndSec).toBeCloseTo(2.4, 1)
  })

  it("says they are ALIGNED when both sides are on the same grid", () => {
    expect(
      planTimebaseCorrection({
        cueTimes: grid(24, 600),
        referenceTimes: grid(24, 600, 0.002),
        lastCueSec: 2400,
      }).kind,
    ).toBe("aligned")
  })

  it("is symmetric — cues SLOWER than the file are reported too", () => {
    // Hardcoding 1.001 would quietly do the wrong thing the first time a file
    // arrives the other way round.
    const v = planTimebaseCorrection({
      cueTimes: grid(24000 / 1001, 600),
      referenceTimes: grid(24, 600),
      lastCueSec: 2400,
    })
    assert(v.kind === "correct")
    expect(v.scale).toBeLessThan(1)
    expect(v.driftAtEndSec).toBeLessThan(0)
  })

  // THE EPISODE-306 HOLE. These three used to return null, which the dialog
  // rendered as nothing at all — indistinguishable from "the files agree".
  // 306 imported drifting and said not one word about it.
  it("says it CANNOT TELL when the reference file can't be read", () => {
    const v = planTimebaseCorrection({
      cueTimes: grid(24, 600),
      referenceTimes: randomMs(1200),
      lastCueSec: 2400,
    })
    expect(v.kind).toBe("unmeasurable")
    assert(v.kind === "unmeasurable")
    expect(v.reason).toMatch(/grid/)
  })

  it("says it cannot tell when there is no reference at all", () => {
    expect(
      planTimebaseCorrection({ cueTimes: grid(24, 600), referenceTimes: [], lastCueSec: 2400 }).kind,
    ).toBe("unmeasurable")
  })
})

// ── Measuring the drift on the words ─────────────────────────────────────
//
// The method that would have caught 306: pair lines by their WORDING, with no
// reference to timing at all, then see how far apart the pairs pull.

/** A run of lines with distinct wording, `n` of them, `gap` seconds apart. */
const script = (n: number, gap = 12, scale = 1, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({
    startTime: offset + i * gap * scale,
    original: `line number ${i} says something quite distinct about ${i * 7}`,
  }))

describe("measureDrift", () => {
  const NTSC = 24 / (24000 / 1001)

  it("recovers a 0.1% stretch from the words alone", () => {
    const reference = script(120)
    // The cues are the same script, running 0.1% fast — i.e. their timestamps
    // are SMALLER, exactly as a 24fps file against a 23.976 master.
    const cueLines = reference.map((l) => ({ ...l, startTime: l.startTime / NTSC }))
    const m = measureDrift({ cueLines, referenceLines: reference })!
    expect(m).not.toBeNull()
    expect(m.scale).toBeCloseTo(NTSC, 6)
    expect(m.anchors).toBeGreaterThan(100)
  })

  it("reports a file that is SHIFTED, not stretched, as scale 1 with an offset", () => {
    const reference = script(120)
    const cueLines = reference.map((l) => ({ ...l, startTime: l.startTime - 4 }))
    const m = measureDrift({ cueLines, referenceLines: reference })!
    expect(m.scale).toBeCloseTo(1, 6)
    expect(m.offsetSec).toBeCloseTo(4, 3)
  })

  it("says nothing when the two files share too few lines", () => {
    expect(
      measureDrift({ cueLines: script(120), referenceLines: script(120).map((l, i) => ({ ...l, original: `other ${i}` })) }),
    ).toBeNull()
  })

  it("says nothing when the shared lines span too short a stretch", () => {
    // 40 lines two seconds apart is 80 seconds — a 0.1% slope there is under a
    // tenth of a second, which is smaller than the files' own rounding.
    expect(measureDrift({ cueLines: script(40, 2), referenceLines: script(40, 2) })).toBeNull()
  })

  it("will not anchor on a line too short to be unique", () => {
    const short = Array.from({ length: 120 }, (_, i) => ({ startTime: i * 12, original: i % 2 ? "Yes." : "No." }))
    expect(measureDrift({ cueLines: short, referenceLines: short })).toBeNull()
  })

  it("ignores a line whose wording is ambiguous within its own file", () => {
    // Repeated wording cannot say WHICH line it is, so it must not anchor.
    const reference = [...script(120), { startTime: 5000, original: "line number 3 says something quite distinct about 21" }]
    const m = measureDrift({ cueLines: script(120), referenceLines: reference })!
    expect(m.anchors).toBe(119)
  })

  it("shrugs off a single false pairing — the median does not move", () => {
    // One stock phrase unique in both files by accident, filed at the wrong
    // end of the episode. A least-squares slope would lurch; a median cannot.
    const reference = script(120)
    const cueLines = reference.map((l) => ({ ...l, startTime: l.startTime / NTSC }))
    cueLines.push({ startTime: 30, original: "a stray line that fooled us" })
    reference.push({ startTime: 1400, original: "a stray line that fooled us" })
    expect(measureDrift({ cueLines, referenceLines: reference })!.scale).toBeCloseTo(NTSC, 5)
  })
})

describe("snapToFrameRatio", () => {
  it("snaps a noisy measurement to the exact ratio", () => {
    // Never apply the raw measurement: a pulldown error is an EXACT ratio, and
    // 1.0009987 is a noisy reading of 1001/1000.
    const r = snapToFrameRatio(1.0009987)!
    expect(r.ratio).toBeCloseTo(24 / (24000 / 1001), 9)
  })

  it("REFUSES TO NAME a ratio that several frame pairs share", () => {
    // 24-against-23.976 and 30-against-29.97 are both precisely 1001/1000. The
    // correction is identical either way, so the scale is knowable and the
    // rates are not — and "24 frames per second" on a 30fps show would be a
    // confident falsehood bolted to a correct fix.
    const r = snapToFrameRatio(1.001)!
    expect(r.cue).toBeNull()
    expect(r.reference).toBeNull()
    expect(r.ratio).toBeCloseTo(1.001, 6)
  })

  it("names it once either file's own grid breaks the tie", () => {
    expect(snapToFrameRatio(1.001, { cue: "24" })!.cue).toBe("24")
    expect(snapToFrameRatio(1.001, { cue: "30" })!.reference).toBe("29.97")
    // …and the other direction.
    expect(snapToFrameRatio(1 / 1.001, { reference: "24" })!.cue).toBe("23.976")
  })

  it("refuses a drift that is no frame-rate mistake at all", () => {
    // A trimmed master, or a different cut. Real, but not this module's story.
    expect(snapToFrameRatio(1.04)).toBeNull()
    expect(snapToFrameRatio(1.0004)).toBeNull()
  })
})

describe("planTimebaseCorrection — measuring beats fingerprinting", () => {
  const NTSC = 24 / (24000 / 1001)

  it("finds the drift on a file whose grid cannot be read — the 306 case", () => {
    // 306's subtitles are cut fine enough that their frame grid scores below
    // the floor, so the fingerprint declines. The words still pair perfectly.
    const referenceLines = script(120)
    const cueLines = referenceLines.map((l) => ({ ...l, startTime: l.startTime / NTSC }))
    const v = planTimebaseCorrection({
      // 306's AUDIO grid reads perfectly — it is only the subtitles, cut fine
      // enough to smear their quantisation, that cannot be read. That half an
      // answer is still enough to name which rate the cues are on.
      cueTimes: grid(24, 600),
      referenceTimes: randomMs(1200),
      lastCueSec: 2400,
      cueLines,
      referenceLines,
    })
    expect(v.kind).toBe("correct")
    assert(v.kind === "correct")
    expect(v.namedRatio).toBe(true)
    expect(v.cue.label).toBe("24")
    expect(v.reference.label).toBe("23.976")
    // The SNAPPED ratio, not the raw measurement.
    expect(v.scale).toBe(NTSC)
    expect(v.measured!.anchors).toBeGreaterThan(100)
  })

  it("reports a drift that matches no frame rate, flagged as unnamed", () => {
    const referenceLines = script(120)
    const cueLines = referenceLines.map((l) => ({ ...l, startTime: l.startTime / 1.04 }))
    const v = planTimebaseCorrection({
      cueTimes: [], referenceTimes: [], lastCueSec: 2400, cueLines, referenceLines,
    })
    assert(v.kind === "correct")
    expect(v.namedRatio).toBe(false)
    expect(v.scale).toBeCloseTo(1.04, 4)
  })

  it("corrects exactly but declines to name when NEITHER grid can be read", () => {
    // The honest end of the same story: the drift is measured and applied, and
    // nothing claims to know what rates produced it.
    const referenceLines = script(120)
    const cueLines = referenceLines.map((l) => ({ ...l, startTime: l.startTime / NTSC }))
    const v = planTimebaseCorrection({
      cueTimes: randomMs(1200),
      referenceTimes: randomMs(1200),
      lastCueSec: 2400,
      cueLines,
      referenceLines,
    })
    assert(v.kind === "correct")
    expect(v.scale).toBeCloseTo(NTSC, 9)
    expect(v.namedRatio).toBe(false)
    expect(v.ambiguousRates).toBe(true)
  })

  it("corrects a 30-against-29.97 file identically to a 24-against-23.976 one", () => {
    // Same ratio, same fix. The grid is what tells them apart, and when it can
    // it says so.
    const referenceLines = script(120)
    const cueLines = referenceLines.map((l) => ({ ...l, startTime: l.startTime / NTSC }))
    const v = planTimebaseCorrection({
      cueTimes: grid(30, 600),
      referenceTimes: grid(30000 / 1001, 600, 0.0017),
      lastCueSec: 2400,
      cueLines,
      referenceLines,
    })
    assert(v.kind === "correct")
    expect(v.cue.label).toBe("30")
    expect(v.reference.label).toBe("29.97")
    expect(v.scale).toBeCloseTo(NTSC, 9)
  })

  it("calls matching files aligned even when the grids are unreadable", () => {
    const lines = script(120)
    const v = planTimebaseCorrection({
      cueTimes: randomMs(1200), referenceTimes: randomMs(1200),
      lastCueSec: 2400, cueLines: lines, referenceLines: lines,
    })
    expect(v.kind).toBe("aligned")
  })

  it("still cannot tell when neither the words nor the grids can be read", () => {
    const v = planTimebaseCorrection({
      cueTimes: randomMs(1200),
      referenceTimes: randomMs(1200),
      lastCueSec: 2400,
      cueLines: script(5),
      referenceLines: script(5),
    })
    expect(v.kind).toBe("unmeasurable")
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
