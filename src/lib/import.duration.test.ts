// Round 8c: MediaRecorder webm blobs carry NO duration header — the media
// element reports Infinity and the metadata probe rejects, so every mic take
// attached without a length (chips fell back to section width). The probe now
// falls back to DECODING the samples, which is authoritative.

import { describe, it, expect, vi, afterEach } from "vitest"
import { DECODE_TO_MEASURE_LIMIT_BYTES, probeDurationMsSafe, wholeRecordingSpecs } from "./import"

function stubAudioElement(duration: number, fail = false) {
  const orig = document.createElement.bind(document)
  return vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "audio") return orig(tag)
    const el = {
      preload: "",
      duration,
      onloadedmetadata: null as null | (() => void),
      onerror: null as null | (() => void),
      set src(_v: string) {
        queueMicrotask(() => (fail ? el.onerror?.() : el.onloadedmetadata?.()))
      },
    }
    return el as unknown as HTMLElement
  }) as typeof document.createElement)
}

class FakeAudioContext {
  async decodeAudioData(_buf: ArrayBuffer) {
    return { duration: 2.5 } as AudioBuffer
  }
  async close() {}
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as { AudioContext?: unknown }).AudioContext
})

describe("probeDurationMsSafe — webm fallback (round 8c)", () => {
  it("metadata probe works → no decode needed", async () => {
    stubAudioElement(4)
    const ms = await probeDurationMsSafe(new Blob(["x"], { type: "audio/webm" }), 500)
    expect(ms).toBeCloseTo(4000)
  })

  it("Infinity metadata (MediaRecorder webm) falls back to decoding the samples", async () => {
    stubAudioElement(Infinity)
    ;(window as { AudioContext?: unknown }).AudioContext = FakeAudioContext
    const ms = await probeDurationMsSafe(new Blob(["x"], { type: "audio/webm" }), 500)
    expect(ms).toBeCloseTo(2500)
  })

  it("element error also falls back to decode", async () => {
    stubAudioElement(0, true)
    ;(window as { AudioContext?: unknown }).AudioContext = FakeAudioContext
    const ms = await probeDurationMsSafe(new Blob(["x"], { type: "audio/webm" }), 500)
    expect(ms).toBeCloseTo(2500)
  })

  it("degrades to undefined when decode is unavailable too", async () => {
    stubAudioElement(Infinity)
    const ms = await probeDurationMsSafe(new Blob(["x"], { type: "audio/webm" }), 300)
    expect(ms).toBeUndefined()
  })
})

// AQU-2426 (review, Nov 9): a recording brought in whole took its length from
// the metadata probe alone, so what a browser records (.webm, no duration
// header) came in as a line with no length: nothing offered to split it, and
// Import and transcribe… sent it twice.
describe("wholeRecordingSpecs: a recording with no duration header (AQU-2426 review)", () => {
  it("is measured by decoding, so its one line has its length", async () => {
    stubAudioElement(Infinity)
    ;(window as { AudioContext?: unknown }).AudioContext = FakeAudioContext
    const { durationMs, specs } = await wholeRecordingSpecs(new Blob(["x"], { type: "audio/webm" }))
    expect(durationMs).toBeCloseTo(2500)
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({ startMs: 0, endMs: 2500 })
  })

  it("keeps the probed length when the header has one, without decoding", async () => {
    stubAudioElement(4)
    const decode = vi.fn(async () => ({ duration: 9 }) as AudioBuffer)
    ;(window as { AudioContext?: unknown }).AudioContext = class { decodeAudioData = decode; async close() {} }
    const { specs } = await wholeRecordingSpecs(new Blob(["x"], { type: "audio/webm" }))
    expect(specs[0]).toMatchObject({ startMs: 0, endMs: 4000 })
    expect(decode).not.toHaveBeenCalled()
  })

  it("never decodes a file too big to hold in memory: that one stays unmeasured", async () => {
    stubAudioElement(Infinity)
    const decode = vi.fn(async () => ({ duration: 9 }) as AudioBuffer)
    ;(window as { AudioContext?: unknown }).AudioContext = class { decodeAudioData = decode; async close() {} }
    const big = new Blob(["x"], { type: "video/webm" })
    Object.defineProperty(big, "size", { value: DECODE_TO_MEASURE_LIMIT_BYTES + 1 })
    // A video probes through a <video> element, which the stub leaves alone.
    const orig = document.createElement.bind(document)
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag !== "video") return orig(tag)
      const el = { preload: "", duration: Infinity, onloadedmetadata: null as null | (() => void), onerror: null,
        set src(_v: string) { queueMicrotask(() => el.onloadedmetadata?.()) } }
      return el as unknown as HTMLElement
    }) as typeof document.createElement)
    const { durationMs, specs } = await wholeRecordingSpecs(big)
    expect(durationMs).toBeUndefined()
    expect(specs[0]).not.toHaveProperty("endMs")
    expect(decode).not.toHaveBeenCalled()
  })
})
