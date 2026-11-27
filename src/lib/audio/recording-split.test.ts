import { describe, expect, it, vi } from "vitest"

vi.mock("./transcribe", () => ({ audioBytesToWhisperPcm: vi.fn(), readClipBytes: vi.fn(), transcribeAudio: vi.fn() }))

import { canReadLineAudio, cutsFromWords, pauseCuts, PCM_RATE, previewPeaks } from "./recording-split"

/** Speech (a tone) for each [startSec, endSec), silence between. */
function speech(totalSec: number, spans: Array<[number, number]>): Float32Array {
  const pcm = new Float32Array(Math.round(totalSec * PCM_RATE))
  for (const [a, b] of spans) {
    for (let i = Math.round(a * PCM_RATE); i < Math.round(b * PCM_RATE); i++) pcm[i] = 0.5 * Math.sin(i / 3)
  }
  return pcm
}

describe("recording-split (AQU-2426)", () => {
  it("cuts at pauses where the next stretch of speech starts, on the recording's clock", () => {
    const pcm = speech(9, [[0.5, 2.5], [4, 6], [7, 8.5]])
    const cuts = pauseCuts(pcm, 60_000)
    expect(cuts.length).toBe(2)
    expect(cuts[0]).toBeGreaterThan(60_000 + 3_000)
    expect(cuts[0]).toBeLessThan(60_000 + 4_200)
    expect(cuts[1]).toBeGreaterThan(60_000 + 6_000)
    expect(cuts[1]).toBeLessThan(60_000 + 7_200)
  })

  it("a recording with no pause has no cuts", () => {
    expect(pauseCuts(speech(3, [[0, 3]]), 0)).toEqual([])
  })

  it("previews peaks scaled to the loudest column", () => {
    const peaks = previewPeaks(speech(2, [[1, 2]]), 4)
    expect(peaks.length).toBe(4)
    expect(peaks[0]).toBe(0)
    expect(Math.max(...peaks)).toBe(1)
  })

  it("turns words into cuts on the recording's clock, with each line's words", () => {
    const { cuts, texts } = cutsFromWords([
      { text: "One.", start: 0.2, end: 0.8 }, { text: "Two.", start: 1.2, end: 1.8 },
    ], { lo: 10_000, hi: 13_000 })
    expect(cuts).toEqual([11_000])
    expect(texts).toEqual(["One.", "Two."])
  })

  it("reads only uploaded recordings", () => {
    expect(canReadLineAudio("frontier-audio://p/f/clip.mp3")).toBe(true)
    expect(canReadLineAudio("https://example.com/clip.mp3")).toBe(false)
    expect(canReadLineAudio(undefined)).toBe(false)
  })
})
