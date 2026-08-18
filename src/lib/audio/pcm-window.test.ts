// AQU-929 regression guard: transcription must materialise only the samples it
// is going to send to Whisper. The window math below is what bounds peak
// memory — if a trim window silently widens back to the whole clip, a
// chapter-length shared clip is decoded and resampled in full for every
// section, which is how a transcribe run reached ~2.6 GB.
import { describe, expect, it } from "vitest"
import { resolvePcmWindow } from "./pcm-window"

const RATE = 16000

describe("resolvePcmWindow", () => {
  it("returns the full clip when no trim is given", () => {
    expect(resolvePcmWindow(RATE * 10, RATE)).toEqual({
      start: 0, end: RATE * 10, length: RATE * 10, isFull: true,
    })
    expect(resolvePcmWindow(RATE * 10, RATE, { trimStartMs: null, trimEndMs: null }).isFull).toBe(true)
  })

  it("resolves a trim window to sample offsets", () => {
    const win = resolvePcmWindow(RATE * 10, RATE, { trimStartMs: 2000, trimEndMs: 3500 })
    expect(win).toEqual({ start: RATE * 2, end: RATE * 3.5, length: RATE * 1.5, isFull: false })
  })

  it("materialises only the window, not the clip, for a small slice of a long clip", () => {
    // 30 minutes of 16 kHz mono; one 12-second section.
    const total = RATE * 60 * 30
    const win = resolvePcmWindow(total, RATE, { trimStartMs: 600_000, trimEndMs: 612_000 })
    expect(win.length).toBe(RATE * 12)
    expect(win.length / total).toBeLessThan(0.01)
  })

  it("clamps out-of-range edges to the clip bounds", () => {
    const total = RATE * 10
    expect(resolvePcmWindow(total, RATE, { trimStartMs: -5000, trimEndMs: 99_999_999 }))
      .toEqual({ start: 0, end: total, length: total, isFull: true })
    const tail = resolvePcmWindow(total, RATE, { trimStartMs: 8000, trimEndMs: null })
    expect(tail).toEqual({ start: RATE * 8, end: total, length: RATE * 2, isFull: false })
  })

  it("falls back to the full clip for an inverted or empty window", () => {
    const total = RATE * 10
    expect(resolvePcmWindow(total, RATE, { trimStartMs: 8000, trimEndMs: 2000 }).isFull).toBe(true)
    expect(resolvePcmWindow(total, RATE, { trimStartMs: 4000, trimEndMs: 4000 }).isFull).toBe(true)
  })

  it("works at a non-Whisper source rate (the resample fallback path)", () => {
    const rate = 48000
    const win = resolvePcmWindow(rate * 10, rate, { trimStartMs: 1000, trimEndMs: 3000 })
    expect(win).toEqual({ start: 48000, end: 144000, length: 96000, isFull: false })
  })
})
