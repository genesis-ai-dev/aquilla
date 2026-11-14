// splitWav (AQU-2573): a WAV longer than one upload may be goes up as several.
//
// WHY these tests matter: the pieces are trained on, so the cut has to be
// lossless and in order — every sample once, none torn across a frame — and a
// file this cannot cut safely must be left alone, not mangled.
import { describe, expect, it } from "vitest"
import { splitWav } from "./wav-split"

interface WavOpts {
  channels?: number
  sampleRate?: number
  bytesPerSample?: number
  format?: number
  /** Extra chunk between `fmt ` and `data`, as recorders write (LIST, bext). */
  extraChunk?: Uint8Array
  /** What to write in the data chunk's size field (a streamed file writes 0). */
  declaredDataBytes?: number
}

/** A WAV whose sample bytes count 0,1,2…, so a lost or repeated byte shows. */
function makeWav(frames: number, opts: WavOpts = {}): File {
  const { channels = 2, sampleRate = 8000, bytesPerSample = 2, format = 1, extraChunk } = opts
  const blockAlign = channels * bytesPerSample
  const data = new Uint8Array(frames * blockAlign)
  for (let i = 0; i < data.length; i++) data[i] = i % 251
  const extra = extraChunk ? 8 + extraChunk.byteLength + (extraChunk.byteLength % 2) : 0
  const out = new Uint8Array(44 + extra + data.length)
  const view = new DataView(out.buffer)
  const tag = (at: number, text: string) => { for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i) }
  tag(0, "RIFF"); view.setUint32(4, out.length - 8, true); tag(8, "WAVE")
  tag(12, "fmt "); view.setUint32(16, 16, true)
  view.setUint16(20, format, true); view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true); view.setUint16(34, bytesPerSample * 8, true)
  let at = 36
  if (extraChunk) {
    tag(at, "LIST"); view.setUint32(at + 4, extraChunk.byteLength, true)
    out.set(extraChunk, at + 8)
    at += extra
  }
  tag(at, "data"); view.setUint32(at + 4, opts.declaredDataBytes ?? data.length, true)
  out.set(data, at + 8)
  return new File([out], "booth take.wav", { type: "audio/wav" })
}

/** The sample bytes of a canonical 44-byte-header WAV, after checking the header. */
async function samplesOf(part: File): Promise<Uint8Array> {
  const bytes = new Uint8Array(await part.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"])
  expect(view.getUint32(4, true)).toBe(bytes.length - 8)
  expect(view.getUint32(40, true)).toBe(bytes.length - 44)
  return bytes.subarray(44)
}

describe("splitWav", () => {
  it("cuts a long WAV into pieces under the cap that join back into the same samples", async () => {
    const frames = 10_000 // 40,000 sample bytes, stereo 16-bit
    const file = makeWav(frames)
    const split = await splitWav(file, 10_000)
    expect(split).not.toBeNull()
    const { parts, seconds } = split!
    expect(seconds).toBeCloseTo(frames / 8000, 6)
    expect(parts.map((p) => p.name)).toEqual([
      "booth take-part1.wav", "booth take-part2.wav", "booth take-part3.wav", "booth take-part4.wav", "booth take-part5.wav",
    ])
    const joined: number[] = []
    for (const part of parts) {
      expect(part.size).toBeLessThanOrEqual(10_000)
      const samples = await samplesOf(part)
      expect(samples.length % 4, "cut on a whole frame").toBe(0)
      joined.push(...samples)
    }
    expect(joined).toHaveLength(frames * 4)
    expect(joined.every((b, i) => b === i % 251)).toBe(true)
  })

  it("keeps the format of the original: 24-bit, mono, float", async () => {
    for (const opts of [{ bytesPerSample: 3 }, { channels: 1 }, { bytesPerSample: 4, format: 3 }] as WavOpts[]) {
      const file = makeWav(3000, opts)
      const original = new Uint8Array(await file.arrayBuffer()).subarray(20, 36)
      const split = await splitWav(file, 5000)
      for (const part of split!.parts) {
        expect(new Uint8Array(await part.arrayBuffer()).subarray(20, 36)).toEqual(original)
      }
      expect(split!.seconds).toBeCloseTo(3000 / 8000, 6)
    }
  })

  it("finds the samples behind a recorder's extra chunk, and when the size was never filled in", async () => {
    const withList = await splitWav(makeWav(2000, { extraChunk: new Uint8Array(33).fill(7) }), 3000)
    expect((await samplesOf(withList!.parts[0]))[0]).toBe(0)
    expect(withList!.seconds).toBeCloseTo(0.25, 6)

    const streamed = await splitWav(makeWav(2000, { declaredDataBytes: 0 }), 3000)
    expect(streamed!.seconds).toBeCloseTo(0.25, 6)
  })

  it("leaves alone what it cannot cut safely", async () => {
    expect(await splitWav(new File([new Uint8Array(5000)], "speech.mp3", { type: "audio/mpeg" }), 1000)).toBeNull()
    // A compressed WAV (ADPCM, format 2) has no fixed sample frame to cut on.
    expect(await splitWav(makeWav(2000, { format: 2 }), 1000)).toBeNull()
    expect(await splitWav(new File([new Uint8Array(4)], "tiny.wav"), 1000)).toBeNull()
  })
})
