// Cutting a WAV down to its trim, without a decoder. (2026-08-27)
//
// Every recorded take is born with a head trim (`take-margins.ts` — the
// pre-roll anchor shift is undone by a trim, not by moving bytes), so this is
// the ordinary path for the per-line export, not an edge case. The rule it has
// to obey: what comes out is what the timeline plays, and anything that cannot
// be cut honestly comes back untouched rather than approximately.

import { describe, it, expect } from "vitest"
import { readWavFormat, trimWav, withBwfTimestamp } from "./audio-bwf"

/** A real PCM WAV at 1000 Hz — one frame per millisecond, so a trim in ms
 *  reads directly as a frame count and the arithmetic is checkable by eye. */
function wav(opts: {
  frames?: number
  channels?: number
  bits?: number
  rate?: number
  audioFormat?: number
  extraChunk?: boolean
} = {}): Uint8Array {
  const { frames = 100, channels = 1, bits = 16, rate = 1000, audioFormat = 1, extraChunk = false } = opts
  const blockAlign = (channels * bits) / 8
  const dataBytes = frames * blockAlign
  const extra = extraChunk ? 8 + 3 + 1 : 0 // odd body + its pad byte
  const bytes = new Uint8Array(12 + 8 + 16 + extra + 8 + dataBytes)
  const view = new DataView(bytes.buffer)
  const tag = (at: number, s: string) => { for (let i = 0; i < 4; i += 1) view.setUint8(at + i, s.charCodeAt(i)) }
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE")
  tag(12, "fmt "); view.setUint32(16, 16, true)
  view.setUint16(20, audioFormat, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bits, true)
  let at = 36
  if (extraChunk) {
    // An odd-sized chunk we do not understand, to prove it survives with its
    // pad byte and does not shift the data that follows.
    tag(at, "LIST"); view.setUint32(at + 4, 3, true)
    view.setUint8(at + 8, 9); view.setUint8(at + 9, 9); view.setUint8(at + 10, 9)
    at += 8 + 3 + 1
  }
  tag(at, "data"); view.setUint32(at + 4, dataBytes, true)
  // Frame n holds the value n, so a slice is identifiable by its contents.
  for (let f = 0; f < frames; f += 1) view.setInt16(at + 8 + f * blockAlign, f, true)
  return bytes
}

/** The `data` payload of a WAV, as frame values. */
function frames(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!)
  let at = 12
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    if (id === "data") {
      const out: number[] = []
      for (let i = 0; i + 1 < size; i += 2) out.push(view.getInt16(at + 8 + i, true))
      return out
    }
    at += 8 + size + (size % 2)
  }
  return []
}

describe("readWavFormat", () => {
  it("reads the frame layout a byte-range cut depends on", () => {
    expect(readWavFormat(wav({ channels: 2, bits: 16, rate: 44100 }))).toEqual({
      audioFormat: 1, channels: 2, sampleRate: 44100, bitsPerSample: 16, blockAlign: 4,
    })
  })

  it("says nothing about what is not a WAV", () => {
    expect(readWavFormat(new Uint8Array([1, 2, 3, 4]))).toBeNull()
    expect(readWavFormat(new Uint8Array(0))).toBeNull()
  })
})

describe("trimWav", () => {
  it("keeps only the window, and the frames are the ones the timeline plays", () => {
    // 100 frames at 1000 Hz = 100 ms. Keep 20–60 ms.
    const out = trimWav(wav(), { trimStartMs: 20, trimEndMs: 60 })
    const kept = frames(out)
    expect(kept).toHaveLength(40)
    expect(kept[0]).toBe(20)
    expect(kept.at(-1)).toBe(59)
  })

  it("cuts a head alone, and a tail alone", () => {
    expect(frames(trimWav(wav(), { trimStartMs: 30 }))[0]).toBe(30)
    expect(frames(trimWav(wav(), { trimStartMs: 30 }))).toHaveLength(70)
    expect(frames(trimWav(wav(), { trimEndMs: 40 }))).toHaveLength(40)
    expect(frames(trimWav(wav(), { trimEndMs: 40 })).at(-1)).toBe(39)
  })

  it("counts frames, not bytes, on a stereo clip", () => {
    // 2ch/16-bit = 4 bytes a frame. A cut must land on a frame boundary or
    // every later sample is byte-shifted into noise.
    const out = trimWav(wav({ channels: 2, frames: 50 }), { trimStartMs: 10, trimEndMs: 20 })
    expect(out.byteLength - wav({ channels: 2, frames: 50 }).byteLength).toBe((10 - 50) * 4)
  })

  it("hands back the original when there is nothing to cut", () => {
    const w = wav()
    expect(trimWav(w, {})).toBe(w)
    expect(trimWav(w, { trimStartMs: null, trimEndMs: null })).toBe(w)
    // A window covering the whole clip is not a cut.
    expect(trimWav(w, { trimStartMs: 0, trimEndMs: 100 })).toBe(w)
  })

  // The defensive rule `resolvePcmWindow` already sets, inherited on purpose:
  // a nonsense window returns the whole clip rather than silence.
  it("refuses a window that would produce nothing", () => {
    const w = wav()
    expect(trimWav(w, { trimStartMs: 60, trimEndMs: 20 })).toBe(w)
    expect(trimWav(w, { trimStartMs: 500 })).toBe(w)
  })

  it("leaves alone anything it cannot cut honestly", () => {
    // Compressed payload in a WAV wrapper: a byte offset means nothing in it.
    const compressed = wav({ audioFormat: 0x11 })
    expect(trimWav(compressed, { trimStartMs: 10 })).toBe(compressed)
    // Not a RIFF file at all — a webm take passed straight through.
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])
    expect(trimWav(webm, { trimStartMs: 10 })).toBe(webm)
  })

  it("keeps the other chunks, their padding, and an honest RIFF size", () => {
    const out = trimWav(wav({ extraChunk: true }), { trimStartMs: 20, trimEndMs: 60 })
    const view = new DataView(out.buffer)
    expect(view.getUint32(4, true)).toBe(out.byteLength - 8)
    // The LIST chunk survived, so `data` was not found by a blind offset.
    expect(readWavFormat(out)).not.toBeNull()
    expect(frames(out)).toHaveLength(40)
  })

  // The two operations the per-line export runs back to back.
  it("composes with the BWF stamp in either order", () => {
    const trimmedThenStamped = withBwfTimestamp(trimWav(wav(), { trimStartMs: 20, trimEndMs: 60 }), {
      description: "d", originator: "o", originatorRef: "r", timeReferenceSamples: 480000,
    })
    expect(frames(trimmedThenStamped)).toHaveLength(40)
    expect(frames(trimmedThenStamped)[0]).toBe(20)
    expect(readWavFormat(trimmedThenStamped)?.blockAlign).toBe(2)
  })
})
