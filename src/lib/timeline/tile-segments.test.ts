// AQU-646: tiling turns detected speech ranges into an exhaustive partition of
// the clip so playback can never skip inter-segment audio ("cuts, not
// deletions"). These invariants are what the play-queue relies on.

import { describe, it, expect } from "vitest"
import { tileSegments, type TimedRange } from "./tile-segments"
import { detectSpeechSegments } from "./silence-split"

describe("tileSegments", () => {
  it("empty in → empty out", () => {
    expect(tileSegments([], 10_000)).toEqual([])
  })

  it("single range stretches to cover the whole clip", () => {
    expect(tileSegments([{ startMs: 500, endMs: 2_000 }], 10_000)).toEqual([
      { startMs: 0, endMs: 10_000 },
    ])
  })

  it("partitions exactly: start_0=0, end_i===start_{i+1}, end_last=round(totalMs)", () => {
    const tight: TimedRange[] = [
      { startMs: 300, endMs: 1_200 },
      { startMs: 2_500, endMs: 4_000 },
      { startMs: 4_800, endMs: 6_100 },
    ]
    const tiled = tileSegments(tight, 7_500.4)
    expect(tiled).toEqual([
      { startMs: 0, endMs: 2_500 },
      { startMs: 2_500, endMs: 4_800 },
      { startMs: 4_800, endMs: 7_500 },
    ])
    // Parallel to the input: same length/order; speech-onset starts preserved (i > 0).
    expect(tiled).toHaveLength(tight.length)
    expect(tiled[1].startMs).toBe(tight[1].startMs)
    expect(tiled[2].startMs).toBe(tight[2].startMs)
  })

  it("never shrinks an overlapping range's end", () => {
    const tiled = tileSegments(
      [
        { startMs: 0, endMs: 5_000 },
        { startMs: 3_000, endMs: 6_000 }, // overlaps the first
      ],
      6_000,
    )
    expect(tiled[0].endMs).toBe(5_000) // max(5000, next start 3000) — not shrunk
    expect(tiled[1]).toEqual({ startMs: 3_000, endMs: 6_000 })
  })

  it("keeps the last end tight when totalMs is unknown", () => {
    const tiled = tileSegments([
      { startMs: 100, endMs: 900 },
      { startMs: 2_000, endMs: 3_000 },
    ])
    expect(tiled).toEqual([
      { startMs: 0, endMs: 2_000 },
      { startMs: 2_000, endMs: 3_000 },
    ])
  })

  it("never truncates when totalMs is smaller than the last end (duration mismatch)", () => {
    const tiled = tileSegments([{ startMs: 0, endMs: 5_000 }], 4_800)
    expect(tiled[0].endMs).toBe(5_000)
  })

  it("composes with detectSpeechSegments into a full cover of the clip", () => {
    // Two speech bursts separated by >300ms silence at 1kHz sample rate.
    const sr = 1000
    const samples = new Float32Array(6 * sr) // 6s
    for (let i = 500; i < 1_500; i++) samples[i] = 0.5 // speech 0.5–1.5s
    for (let i = 3_000; i < 4_200; i++) samples[i] = 0.5 // speech 3.0–4.2s
    const tight = detectSpeechSegments(samples, sr)
    expect(tight.length).toBe(2)
    const tiled = tileSegments(tight, 6_000)
    expect(tiled[0].startMs).toBe(0)
    expect(tiled[tiled.length - 1].endMs).toBe(6_000)
    for (let i = 0; i < tiled.length - 1; i++) {
      expect(tiled[i].endMs).toBe(tiled[i + 1].startMs) // no gap, no overlap
    }
  })
})
