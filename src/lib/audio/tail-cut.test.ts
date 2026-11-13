// AQU-1767: a trimmed dub's bytes, cut to end at the trim (Sam's walk, 2026-10-15).
import { describe, it, expect, beforeEach } from "vitest"
import { joinWavSpans, joinedClip, tailCutWav, tailCutNow, __resetTailCutForTests } from "./tail-cut"
import { encodeWavPcm16 } from "./wav-encode"

async function wav(seconds: number, rate = 48000): Promise<Uint8Array> {
  const samples = new Float32Array(Math.round(seconds * rate)).map((_, i) => Math.sin(i / 10) * 0.5)
  return new Uint8Array(await encodeWavPcm16(samples, rate).arrayBuffer())
}

const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true)
const tag = (b: Uint8Array, o: number) => String.fromCharCode(...b.subarray(o, o + 4))

/** A stereo 24-bit WAV with a LIST chunk before its audio, as other tools write them. */
function stereo24(frames: number, rate = 44100): Uint8Array {
  const list = 12
  const data = frames * 6
  const b = new Uint8Array(12 + 24 + 8 + list + 8 + data)
  const dv = new DataView(b.buffer)
  const put = (o: number, s: string) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i) }
  put(0, "RIFF"); dv.setUint32(4, b.length - 8, true); put(8, "WAVE")
  put(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true)
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 6, true); dv.setUint16(32, 6, true); dv.setUint16(34, 24, true)
  put(36, "LIST"); dv.setUint32(40, list, true)
  put(44 + list, "data"); dv.setUint32(48 + list, data, true)
  for (let i = 0; i < data; i++) b[52 + list + i] = i % 251
  return b
}

describe("tailCutWav", () => {
  it("keeps the head and ends the audio at the trim, with both sizes rewritten", async () => {
    const full = await wav(1)
    const cut = tailCutWav(full, 0.5)!
    expect(cut.length).toBe(44 + 24000 * 2)
    expect(u32(cut, 4)).toBe(cut.length - 8)
    expect(u32(cut, 40)).toBe(24000 * 2)
    // The audio it keeps is the clip's own, from its first sample.
    expect([...cut.subarray(44, 1044)]).toEqual([...full.subarray(44, 1044)])
  })

  it("cuts on a whole frame of a stereo 24-bit WAV, keeping the chunks before its audio", () => {
    const full = stereo24(44100)
    const cut = tailCutWav(full, 0.25)!
    const dataAt = 44 + 12
    expect(tag(cut, 36)).toBe("LIST")
    expect(tag(cut, dataAt)).toBe("data")
    expect(u32(cut, dataAt + 4)).toBe(11025 * 6)
    expect(cut.length).toBe(dataAt + 8 + 11025 * 6)
  })

  it("reads a header written before its length was known", async () => {
    const full = await wav(1)
    new DataView(full.buffer).setUint32(40, 0xffffffff, true)
    expect(u32(tailCutWav(full, 0.5)!, 40)).toBe(48000)
  })

  it("leaves alone what it cannot or need not cut", async () => {
    const full = await wav(1)
    expect(tailCutWav(full, 1.5)).toBeNull()
    expect(tailCutWav(full, 0)).toBeNull()
    expect(tailCutWav(new TextEncoder().encode("ID3 not a wav at all, an mp3 header and more"), 0.5)).toBeNull()
  })
})

describe("tailCutNow", () => {
  beforeEach(() => { __resetTailCutForTests() })

  it("cuts a WAV at once", async () => {
    const blob = tailCutNow("take", "wav", await wav(1), 0.5)
    expect(blob?.size).toBe(44 + 48000)
    expect(blob?.type).toBe("audio/wav")
  })

  it("never holds a due dub back for a decode: another format answers null until it is ready", async () => {
    expect(tailCutNow("take", "webm", new Uint8Array(64), 0.5)).toBeNull()
  })
})

// AQU-1767 (Sam, 2026-10-15): Free timing plays a split take's pieces as one clip.
describe("joining a split take's pieces", () => {
  it("joins the pieces' audio in the order given, skipping what lies between", async () => {
    const full = await wav(1)
    const joined = joinWavSpans(full, [{ start: 0.1, end: 0.3 }, { start: 0.5, end: 0.6 }])!
    expect(joined.length).toBe(44 + (9600 + 4800) * 2)
    expect(u32(joined, 4)).toBe(joined.length - 8)
    expect(u32(joined, 40)).toBe((9600 + 4800) * 2)
    // The second piece's first sample follows the first piece's last.
    const at = (sec: number) => 44 + Math.round(sec * 48000) * 2
    expect([...joined.subarray(44, 54)]).toEqual([...full.subarray(at(0.1), at(0.1) + 10)])
    expect([...joined.subarray(44 + 9600 * 2, 44 + 9600 * 2 + 10)]).toEqual([...full.subarray(at(0.5), at(0.5) + 10)])
  })

  // AQU-1758 (Sam's decision 3): a gap dragged open between two pieces is
  // deliberate silence, joined in as silence.
  it("puts a piece's silence before it", async () => {
    const full = await wav(1)
    const joined = joinWavSpans(full, [{ start: 0.1, end: 0.3 }, { start: 0.5, end: 0.6, gapBeforeSec: 0.25 }])!
    expect(joined.length).toBe(44 + (9600 + 12000 + 4800) * 2)
    expect(u32(joined, 40)).toBe((9600 + 12000 + 4800) * 2)
    const silence = joined.subarray(44 + 9600 * 2, 44 + (9600 + 12000) * 2)
    expect(silence.every((b) => b === 0)).toBe(true)
    const at = (sec: number) => 44 + Math.round(sec * 48000) * 2
    expect([...joined.subarray(44 + (9600 + 12000) * 2, 44 + (9600 + 12000) * 2 + 10)]).toEqual([...full.subarray(at(0.5), at(0.5) + 10)])
  })

  it("refuses an empty piece", async () => {
    expect(joinWavSpans(await wav(1), [{ start: 0.3, end: 0.3 }])).toBeNull()
  })

  it("answers a WAV with a WAV blob", async () => {
    const blob = await joinedClip(await wav(1), "wav", [{ start: 0, end: 0.5 }, { start: 0.75, end: 1 }])
    expect(blob?.size).toBe(44 + (24000 + 12000) * 2)
  })
})

// AQU-2432 (Sam, Nov 6): a piece dragged over the end of the piece in front
// sounds over it — both at full volume, mixed into the joined copy.
describe("joining pieces that overlap", () => {
  const i16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getInt16(o, true)

  it("mixes the overlap, sample by sample, and the clip lasts to the last end", async () => {
    const full = await wav(1)
    // 0.1–0.3 then 0.5–0.6 starting 0.05 s before the first ends.
    const joined = joinWavSpans(full, [{ start: 0.1, end: 0.3 }, { start: 0.5, end: 0.6, overlapBeforeSec: 0.05 }])!
    const frames = 9600 + 4800 - 2400
    expect(joined.length).toBe(44 + frames * 2)
    expect(u32(joined, 40)).toBe(frames * 2)
    const at = (sec: number) => 44 + Math.round(sec * 48000) * 2
    // Before the overlap: the first piece alone.
    expect(i16(joined, 44)).toBe(i16(full, at(0.1)))
    // In it: both, summed.
    const k = 9600 - 2400 + 10
    expect(i16(joined, 44 + k * 2)).toBe(i16(full, at(0.1) + k * 2) + i16(full, at(0.5) + 10 * 2))
    // After it: the second alone.
    const after = 9600 + 100
    expect(i16(joined, 44 + after * 2)).toBe(i16(full, at(0.5) + (after - 7200) * 2))
  })

  it("a piece inside the one in front ends before it: the clip ends with the first", async () => {
    const full = await wav(1)
    const joined = joinWavSpans(full, [{ start: 0, end: 0.5 }, { start: 0.6, end: 0.7, overlapBeforeSec: 0.4 }])!
    expect(u32(joined, 40)).toBe(24000 * 2)
  })

  it("is held at full scale where the sum would pass it", () => {
    // Two pieces of a full-scale square wave, laid one over the other.
    const loud = encodeWavPcm16(new Float32Array(4800).fill(0.9), 48000)
    return loud.arrayBuffer().then((buf) => {
      const bytes = new Uint8Array(buf)
      const joined = joinWavSpans(bytes, [{ start: 0, end: 0.05 }, { start: 0, end: 0.05, overlapBeforeSec: 0.05 }])!
      expect(i16(joined, 44 + 100)).toBe(32767)
    })
  })

  it("a WAV it cannot mix by bytes goes to the decode path", () => {
    expect(joinWavSpans(stereo24(4410), [{ start: 0, end: 0.05 }, { start: 0.05, end: 0.1, overlapBeforeSec: 0.01 }])).toBeNull()
  })
})
