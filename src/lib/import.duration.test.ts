// Round 8c: MediaRecorder webm blobs carry NO duration header — the media
// element reports Infinity and the metadata probe rejects, so every mic take
// attached without a length (chips fell back to section width). The probe now
// falls back to DECODING the samples, which is authoritative.

import { describe, it, expect, vi, afterEach } from "vitest"
import { probeDurationMsSafe } from "./import"

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
