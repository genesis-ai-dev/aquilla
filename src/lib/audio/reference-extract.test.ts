// AQU-646: voice-reference extraction from an imported clip. The slicing math
// is the load-bearing part — longest-first selection up to the 20 s cap,
// chronological assembly, clamping — so it's tested against a ramp PCM where
// every sample holds its own index.

import { describe, it, expect, vi } from "vitest"
import {
  slicePcmForReference,
  extractVoiceReference,
  MAX_REFERENCE_SEC,
  type ReferenceRange,
} from "./reference-extract"

// 1 kHz sample rate keeps the index math human-readable: sample i = ms i.
const SR = 1000
const ramp = (seconds: number) => Float32Array.from({ length: seconds * SR }, (_, i) => i)

describe("slicePcmForReference", () => {
  it("slices a single range at sample indices", () => {
    const out = slicePcmForReference(ramp(30), [{ startMs: 2000, endMs: 5000 }], SR)
    expect(out.length).toBe(3000)
    expect(out[0]).toBe(2000)
    expect(out[out.length - 1]).toBe(4999)
  })

  it("assembles picked ranges chronologically even when picked longest-first", () => {
    // Longest range is LAST in time — the output must still be time-ordered.
    const ranges: ReferenceRange[] = [
      { startMs: 1000, endMs: 3000 }, // 2 s
      { startMs: 10000, endMs: 20000 }, // 10 s (longest)
    ]
    const out = slicePcmForReference(ramp(30), ranges, SR)
    expect(out.length).toBe(12000)
    expect(out[0]).toBe(1000) // earlier range first…
    expect(out[2000]).toBe(10000) // …then the longest
  })

  it("caps the assembled reference at maxSec, trimming the range that crosses it", () => {
    const ranges: ReferenceRange[] = [
      { startMs: 0, endMs: 15000 },
      { startMs: 16000, endMs: 28000 },
    ]
    const out = slicePcmForReference(ramp(30), ranges, SR, 20)
    expect(out.length).toBe(20 * SR)
  })

  it("skips sub-0.5s ranges (too short to carry voice character)", () => {
    const out = slicePcmForReference(
      ramp(30),
      [
        { startMs: 100, endMs: 400 }, // 300 ms → skipped
        { startMs: 5000, endMs: 6000 },
      ],
      SR,
    )
    expect(out.length).toBe(1000)
    expect(out[0]).toBe(5000)
  })

  it("clamps ranges to the clip bounds", () => {
    const out = slicePcmForReference(ramp(10), [{ startMs: 8000, endMs: 99999 }], SR)
    expect(out.length).toBe(2000)
    expect(out[out.length - 1]).toBe(9999)
  })

  it("returns an empty buffer when no range is usable", () => {
    expect(slicePcmForReference(ramp(10), [], SR).length).toBe(0)
    expect(slicePcmForReference(ramp(10), [{ startMs: 3000, endMs: 3200 }], SR).length).toBe(0)
  })

  it("defaults the cap to MAX_REFERENCE_SEC (Seed-VC reads ~25 s; we stay under)", () => {
    expect(MAX_REFERENCE_SEC).toBeLessThanOrEqual(25)
  })
})

describe("extractVoiceReference", () => {
  const baseArgs = {
    projectId: "p1",
    fileId: "f1",
    clipUrl: "frontier-audio://clip-abc.mp3",
    getSyncToken: async () => "tok",
  }

  it("fetches, decodes, slices, and uploads — returning a ref-*.wav id", async () => {
    const fetchBytes = vi.fn(async () => new Uint8Array([1, 2, 3]))
    // decode returns 30 s of 48 kHz-equivalent PCM; use the real TARGET_RATE
    // path by returning enough samples for the requested ranges.
    const decode = vi.fn(async () => Float32Array.from({ length: 48000 * 30 }, () => 0.25))
    const upload = vi.fn(async () => {})

    const id = await extractVoiceReference({
      ...baseArgs,
      ranges: [{ startMs: 1000, endMs: 4000 }],
      fetchBytes,
      decode,
      upload,
    })

    expect(id).toMatch(/^ref-.+\.wav$/)
    expect(fetchBytes).toHaveBeenCalledOnce()
    expect((fetchBytes.mock.calls[0] as unknown[])[0]).toMatchObject({
      projectId: "p1",
      fileId: "f1",
      audioId: "clip-abc",
      ext: "mp3",
    })
    expect(upload).toHaveBeenCalledOnce()
    const uploaded = (upload.mock.calls[0] as unknown[])[0] as { referenceAudioId: string; blob: Blob }
    expect(uploaded.referenceAudioId).toBe(id)
    expect(uploaded.blob.size).toBeGreaterThan(44) // WAV header + samples
  })

  it("returns null (no upload) when the ranges yield no usable audio", async () => {
    const upload = vi.fn(async () => {})
    const id = await extractVoiceReference({
      ...baseArgs,
      ranges: [{ startMs: 0, endMs: 100 }], // sub-minimum
      fetchBytes: async () => new Uint8Array([1]),
      decode: async () => Float32Array.from({ length: 48000 * 10 }, () => 0),
      upload,
    })
    expect(id).toBeNull()
    expect(upload).not.toHaveBeenCalled()
  })

  it("returns null for a non-frontier clip url", async () => {
    const fetchBytes = vi.fn(async () => new Uint8Array([1]))
    const id = await extractVoiceReference({
      ...baseArgs,
      clipUrl: "https://example.com/clip.mp3",
      ranges: [{ startMs: 0, endMs: 5000 }],
      fetchBytes,
      decode: async () => new Float32Array(0),
      upload: async () => {},
    })
    expect(id).toBeNull()
    expect(fetchBytes).not.toHaveBeenCalled()
  })
})
