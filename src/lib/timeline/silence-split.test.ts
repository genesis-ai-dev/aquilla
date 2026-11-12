import { describe, it, expect } from "vitest"
import {
  createRmsEnvelope,
  detectSpeechSegments,
  detectSpeechSegmentsFromEnvelope,
  type SilenceSplitOptions,
} from "./silence-split"

// WHY: audio import splits one clip into per-line media segments at silences.
// These tests pin the contract the import path depends on — real boundaries
// from real energy, a single region for continuous speech, nothing for
// silence, and short blips ignored — so a regression can't silently produce
// junk segments (or fail to split a real multi-line recording).

const SR = 8000

/** Build a mono signal: each part is [seconds, amplitude]. amplitude 0 = silence,
 *  else a 220Hz sine at that peak amplitude. */
function build(parts: Array<[number, number]>): Float32Array {
  const total = parts.reduce((n, [sec]) => n + Math.round(sec * SR), 0)
  const out = new Float32Array(total)
  let i = 0
  for (const [sec, amp] of parts) {
    const n = Math.round(sec * SR)
    for (let j = 0; j < n; j++, i++) {
      out[i] = amp === 0 ? 0 : amp * Math.sin((2 * Math.PI * 220 * j) / SR)
    }
  }
  return out
}

const opts: SilenceSplitOptions = { minSilenceMs: 300, minSegmentMs: 200, padMs: 0, noiseFloorRms: 0.02 }

describe("detectSpeechSegments", () => {
  it("returns nothing for empty input", () => {
    expect(detectSpeechSegments(new Float32Array(0), SR)).toEqual([])
  })

  it("returns nothing for pure silence", () => {
    expect(detectSpeechSegments(build([[2, 0]]), SR, opts)).toEqual([])
  })

  it("returns a single region for continuous speech", () => {
    const segs = detectSpeechSegments(build([[1.5, 0.3]]), SR, opts)
    expect(segs).toHaveLength(1)
    expect(segs[0].startMs).toBeLessThanOrEqual(20)
    expect(segs[0].endMs).toBeGreaterThanOrEqual(1480)
  })

  it("splits two speech bursts separated by a long silence", () => {
    // speech 0–1s, silence 1–1.6s (>300ms), speech 1.6–2.6s
    const segs = detectSpeechSegments(build([[1, 0.3], [0.6, 0], [1, 0.3]]), SR, opts)
    expect(segs).toHaveLength(2)
    expect(segs[0].startMs).toBeLessThanOrEqual(20)
    expect(segs[0].endMs).toBeLessThanOrEqual(1100)
    expect(segs[1].startMs).toBeGreaterThanOrEqual(1500)
    // disjoint + ascending
    expect(segs[1].startMs).toBeGreaterThanOrEqual(segs[0].endMs)
  })

  it("does NOT split across a silence shorter than minSilenceMs", () => {
    // 100ms gap < 300ms threshold → one merged segment
    const segs = detectSpeechSegments(build([[1, 0.3], [0.1, 0], [1, 0.3]]), SR, opts)
    expect(segs).toHaveLength(1)
  })

  it("drops a sub-minimum blip", () => {
    // 50ms speech < 200ms minSegment, surrounded by silence → dropped
    const segs = detectSpeechSegments(build([[1, 0], [0.05, 0.3], [1, 0]]), SR, opts)
    expect(segs).toEqual([])
  })

  it("keeps segments disjoint and ascending even with padding", () => {
    const segs = detectSpeechSegments(
      build([[0.6, 0.3], [0.4, 0], [0.6, 0.3]]),
      SR,
      { ...opts, padMs: 300 }, // big pad would overlap without clamping
    )
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].startMs).toBeGreaterThanOrEqual(segs[i - 1].endMs)
    }
  })
})

// AQU-1857: the import no longer holds a whole decoded recording, so the
// detector has to reach the same answer from PCM arriving in pieces. These
// pin that equivalence — if chunk boundaries could shift a window, a
// 100-minute import would silently segment differently from a short one.
describe("createRmsEnvelope (streaming)", () => {
  const signal = build([[1, 0.3], [0.6, 0], [1, 0.3], [0.4, 0], [0.8, 0.25]])

  function streamed(chunkSamples: number): ReturnType<typeof detectSpeechSegments> {
    const acc = createRmsEnvelope(SR, 20)
    for (let i = 0; i < signal.length; i += chunkSamples) {
      acc.push(signal.subarray(i, Math.min(i + chunkSamples, signal.length)))
    }
    return detectSpeechSegmentsFromEnvelope(acc.finish(), opts)
  }

  it("matches the whole-array result for a chunk that is a whole number of windows", () => {
    // 20 ms at 8 kHz is 160 samples; 1600 is exactly 10 windows.
    expect(streamed(1600)).toEqual(detectSpeechSegments(signal, SR, opts))
  })

  it("matches the whole-array result when chunks straddle windows", () => {
    const whole = detectSpeechSegments(signal, SR, opts)
    for (const chunkSamples of [1, 7, 159, 161, 1000, 4321]) {
      expect(streamed(chunkSamples), `chunk of ${chunkSamples} samples`).toEqual(whole)
    }
  })

  it("matches the whole-array result when the signal is one chunk", () => {
    expect(streamed(signal.length)).toEqual(detectSpeechSegments(signal, SR, opts))
  })

  it("closes a partial final window, and finish() is idempotent", () => {
    const acc = createRmsEnvelope(SR, 20)
    acc.push(new Float32Array(160 + 40).fill(0.5))
    const first = acc.finish()
    expect(first.rms).toHaveLength(2) // one full window plus the 40-sample tail
    expect(acc.finish()).toEqual(first)
  })

  it("refuses samples pushed after finish rather than corrupting the envelope", () => {
    const acc = createRmsEnvelope(SR, 20)
    acc.push(new Float32Array(160))
    acc.finish()
    expect(() => acc.push(new Float32Array(160))).toThrow(/push after finish/)
  })

  it("reports totalMs from the samples folded in", () => {
    const acc = createRmsEnvelope(SR, 20)
    acc.push(new Float32Array(SR)) // exactly one second
    expect(acc.finish().totalMs).toBeCloseTo(1000, 6)
  })
})
