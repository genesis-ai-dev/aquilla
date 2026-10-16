import { describe, expect, it } from "vitest"
import { windowStarts } from "./asr-windows"

// Omnilingual rejects audio of 40 s or more and ZS learned on ≤30 s clips, so
// no window may run past 30 s — and a cut mid-word costs that word twice.
describe("window starts", () => {
  const sec = 16000

  it("keeps fixed one-minute windows for Whisper and Qwen", () => {
    expect(windowStarts(new Float32Array(130 * sec), 60, false)).toEqual([0, 60 * sec, 120 * sec])
  })

  it("never lets an Omnilingual window pass 30 s, even through nonstop speech", () => {
    const pcm = new Float32Array(95 * sec).map((_, i) => Math.sin(i))
    const starts = windowStarts(pcm, 30, true)
    const ends = [...starts.slice(1), pcm.length]
    starts.forEach((start, i) => expect(ends[i] - start).toBeLessThanOrEqual(30 * sec))
  })

  it("cuts in the pause nearest before the 30 s mark", () => {
    const pcm = new Float32Array(40 * sec).fill(0.3)
    pcm.fill(0, 26 * sec, 26.2 * sec)
    const [, cut] = windowStarts(pcm, 30, true)
    expect(cut / sec).toBeGreaterThanOrEqual(26)
    expect(cut / sec).toBeLessThan(26.2)
  })

  it("a clip that fits is one window", () => {
    expect(windowStarts(new Float32Array(30 * sec), 30, true)).toEqual([0])
  })
})
