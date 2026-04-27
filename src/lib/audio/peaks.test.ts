import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

class StubAudioBuffer {
  numberOfChannels: number
  length: number
  sampleRate: number
  duration: number
  private channelData: Float32Array[]
  constructor(channels: Float32Array[], sampleRate: number) {
    this.numberOfChannels = channels.length
    this.length = channels[0]?.length ?? 0
    this.sampleRate = sampleRate
    this.duration = this.length / sampleRate
    this.channelData = channels
  }
  getChannelData(c: number): Float32Array {
    return this.channelData[c]
  }
}

class StubAudioContext {
  decodedFrom: ArrayBuffer | null = null
  closed = false
  static nextBuffer: StubAudioBuffer | null = null
  decodeAudioData(buf: ArrayBuffer): Promise<StubAudioBuffer> {
    this.decodedFrom = buf
    if (!StubAudioContext.nextBuffer) throw new Error("test forgot to set nextBuffer")
    return Promise.resolve(StubAudioContext.nextBuffer)
  }
  close(): Promise<void> { this.closed = true; return Promise.resolve() }
}

beforeEach(() => {
  vi.stubGlobal("AudioContext", StubAudioContext)
})
afterEach(() => { vi.unstubAllGlobals(); StubAudioContext.nextBuffer = null })

describe("decodePeaks", () => {
  it("reduces a single-channel buffer to the requested bin count and normalizes peaks", async () => {
    // 1000-sample mono buffer at 44.1kHz, ramp from 0 → 0.5
    const samples = new Float32Array(1000)
    for (let i = 0; i < samples.length; i++) samples[i] = (i / samples.length) * 0.5
    StubAudioContext.nextBuffer = new StubAudioBuffer([samples], 44100)

    const { decodePeaks } = await import("./peaks")
    const { peaks, duration, sampleRate } = await decodePeaks(new Uint8Array([1, 2, 3]), 10)

    expect(peaks.length).toBe(10)
    expect(sampleRate).toBe(44100)
    expect(duration).toBeCloseTo(1000 / 44100)
    // Last bin had the largest values, so after normalization it should be ~1
    expect(peaks[9]).toBeGreaterThan(0.9)
    expect(peaks[9]).toBeLessThanOrEqual(1)
    // First bin should be much quieter
    expect(peaks[0]).toBeLessThan(peaks[9])
  })

  it("averages across channels before computing the peak", async () => {
    // Two anti-phase channels — average is silence, peak should be ~0
    const left = new Float32Array(200).fill(0.5)
    const right = new Float32Array(200).fill(-0.5)
    StubAudioContext.nextBuffer = new StubAudioBuffer([left, right], 48000)

    const { decodePeaks } = await import("./peaks")
    const { peaks } = await decodePeaks(new Uint8Array([0]), 4)

    for (const v of peaks) expect(v).toBeCloseTo(0, 5)
  })

  it("rejects when targetBins is non-positive", async () => {
    StubAudioContext.nextBuffer = new StubAudioBuffer([new Float32Array(10)], 44100)
    const { decodePeaks } = await import("./peaks")
    await expect(decodePeaks(new Uint8Array(), 0)).rejects.toThrow()
  })
})
