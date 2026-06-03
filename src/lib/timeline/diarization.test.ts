import { describe, it, expect } from "vitest"
import {
  resampleToMono16k,
  turnsToSegments,
  speakerLabel,
  DIARIZATION_SAMPLE_RATE,
  type DiarizationTurn,
} from "./diarization"

// WHY: the diarizer needs 16 kHz mono, and its output ("speaker turns") must
// become media segments + a distinct speaker set we can turn into cast members.
// These pin the conversions a regression could silently corrupt (wrong rate ⇒
// garbage diarization; dropped/duplicate speakers ⇒ wrong cast).

describe("resampleToMono16k", () => {
  it("returns the input unchanged when already 16 kHz", () => {
    const ch = new Float32Array([0.1, 0.2, 0.3])
    expect(resampleToMono16k(ch, DIARIZATION_SAMPLE_RATE)).toBe(ch)
  })

  it("downsamples 48 kHz to 16 kHz (≈ 1/3 the samples)", () => {
    const ch = new Float32Array(48000).fill(0.5)
    const out = resampleToMono16k(ch, 48000)
    expect(out.length).toBe(16000)
    expect(out[0]).toBeCloseTo(0.5, 5)
    expect(out[out.length - 1]).toBeCloseTo(0.5, 5)
  })

  it("upsamples 8 kHz to 16 kHz (≈ 2x the samples) and interpolates", () => {
    const ch = new Float32Array([0, 1, 0, 1])
    const out = resampleToMono16k(ch, 8000)
    expect(out.length).toBe(8)
    // first sample maps to source 0 exactly
    expect(out[0]).toBeCloseTo(0, 5)
  })

  it("returns empty for empty input or bad rate", () => {
    expect(resampleToMono16k(new Float32Array(0), 16000).length).toBe(0)
    expect(resampleToMono16k(new Float32Array([1, 2]), 0).length).toBe(0)
  })
})

describe("turnsToSegments", () => {
  const turns: DiarizationTurn[] = [
    { startMs: 4000, endMs: 6000, speaker: 1 },
    { startMs: 0, endMs: 2000, speaker: 0 },
    { startMs: 2500, endMs: 3800, speaker: 0 },
    { startMs: 100, endMs: 100, speaker: 9 }, // zero-length → dropped
  ]

  it("sorts by start, drops zero-length turns, one segment per turn", () => {
    const { segments } = turnsToSegments(turns)
    expect(segments.map((s) => [s.startMs, s.endMs, s.speaker])).toEqual([
      [0, 2000, 0],
      [2500, 3800, 0],
      [4000, 6000, 1],
    ])
  })

  it("sets each segment's trim window to its own range", () => {
    const { segments } = turnsToSegments(turns)
    expect(segments.every((s) => s.trimStartMs === s.startMs && s.trimEndMs === s.endMs)).toBe(true)
  })

  it("returns the distinct speakers, ascending (the dropped turn's speaker is excluded)", () => {
    const { speakers } = turnsToSegments(turns)
    expect(speakers).toEqual([0, 1])
  })
})

describe("speakerLabel", () => {
  it("is 1-based and human", () => {
    expect(speakerLabel(0)).toBe("Speaker 1")
    expect(speakerLabel(2)).toBe("Speaker 3")
  })
})
