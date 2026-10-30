import { describe, expect, it, vi } from "vitest"
import { encodeWavPcm16 } from "@/lib/audio/wav-encode"

const probed: string[] = []
vi.mock("@/lib/import", () => ({
  probeMediaDurationMs: vi.fn(async (file: File) => { probed.push(file.name); return 125_400 }),
}))

import { readLengths, recordingLengthMs, wavLengthMs } from "./read-length"

const wav = async (seconds: number, rate = 48_000) =>
  new Uint8Array(await encodeWavPcm16(new Float32Array(Math.round(seconds * rate)), rate).arrayBuffer())

/** A WAV with a LIST chunk before its data, as many recorders write. */
function withListChunk(bytes: Uint8Array): Uint8Array {
  const list = new Uint8Array(8 + 26)
  list.set([0x4c, 0x49, 0x53, 0x54], 0) // "LIST"
  new DataView(list.buffer).setUint32(4, 26, true)
  const out = new Uint8Array(bytes.length + list.length)
  out.set(bytes.subarray(0, 36), 0)
  out.set(list, 36)
  out.set(bytes.subarray(36), 36 + list.length)
  new DataView(out.buffer).setUint32(4, out.length - 8, true)
  return out
}

// Sam, Oct 29: when the count can't tell, the recordings' length decides. The
// length is read from the file's header or metadata, never by decoding it.
describe("reading a recording's length cheaply", () => {
  it("reads a WAV's length from its header", async () => {
    expect(wavLengthMs(await wav(3))).toBe(3000)
    expect(wavLengthMs(withListChunk(await wav(2.5)))).toBe(2500)
  })

  it("gives up on what isn't a whole WAV header", async () => {
    expect(wavLengthMs(new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0]))).toBeNull()
    expect(wavLengthMs((await wav(1)).subarray(0, 20))).toBeNull()
  })

  it("a WAV file is read from its first bytes, without the media player", async () => {
    probed.length = 0
    const bytes = await wav(4)
    const file = new File([bytes as BlobPart], "Ruth 01.wav", { type: "audio/wav" })
    expect(await recordingLengthMs(file)).toBe(4000)
    expect(probed).toEqual([])
  })

  it("any other file asks the browser for its metadata", async () => {
    probed.length = 0
    const file = new File([new Uint8Array(100)], "Ruth 01.m4a", { type: "audio/mp4" })
    expect(await recordingLengthMs(file)).toBe(125_400)
    expect(probed).toEqual(["Ruth 01.m4a"])
  })

  it("reads the lengths of the files asked for, by their place in the list", async () => {
    const files = [
      new File([await wav(1) as BlobPart], "a.wav", { type: "audio/wav" }),
      new File([await wav(2) as BlobPart], "b.wav", { type: "audio/wav" }),
      new File([await wav(3) as BlobPart], "c.wav", { type: "audio/wav" }),
    ]
    expect(await readLengths(files, [0, 2])).toEqual(new Map([[0, 1000], [2, 3000]]))
  })
})
