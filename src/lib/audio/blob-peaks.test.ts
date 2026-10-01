import { describe, expect, it, vi } from "vitest"
import { prepareTakeBlob, wavSamples } from "./blob-peaks"
import { encodeWavPcm16 } from "./wav-encode"

function tone(n: number, amp: number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(i / 3)
  return out
}

describe("wavSamples", () => {
  it("reads back what the recorder's WAV encoder wrote", async () => {
    const src = tone(4800, 0.5)
    const parsed = wavSamples(await encodeWavPcm16(src, 48_000).arrayBuffer())!
    expect(parsed.sampleRate).toBe(48_000)
    expect(parsed.samples.length).toBe(4800)
    expect(parsed.samples[10]).toBeCloseTo(src[10], 3)
  })

  it("declines anything that is not PCM WAV", async () => {
    expect(wavSamples(new TextEncoder().encode("OggS not a wav at all").buffer as ArrayBuffer)).toBeNull()
  })
})

describe("prepareTakeBlob", () => {
  it("draws a WAV take from its own samples and plays the take itself", async () => {
    const quietThenLoud = new Float32Array(9600)
    quietThenLoud.set(tone(4800, 0.05), 0)
    quietThenLoud.set(tone(4800, 0.6), 4800)
    const blob = encodeWavPcm16(quietThenLoud, 48_000)
    const offline = vi.fn()
    vi.stubGlobal("OfflineAudioContext", offline)
    const prepared = await prepareTakeBlob(blob, 4)
    vi.unstubAllGlobals()
    expect(offline).not.toHaveBeenCalled()
    expect(prepared.durationSec).toBeCloseTo(0.2)
    expect(prepared.playable).toBe(blob)
    expect(prepared.peaks[3]).toBeCloseTo(1, 1)
    expect(prepared.peaks[0]).toBeLessThan(0.2)
  })
})
