// AQU-2654: the clip sent for hosted speech recognition is base64 in a JSON
// body. Encoding it by hand blocked the main thread for as long as the clip
// was long, on every row of a pass; the engine's own encoder does not. What
// must hold is that the request is byte for byte the one it was.

import { afterEach, describe, expect, it, vi } from "vitest"
import { base64ByHand, base64Of, buildTranscriptionRequest } from "./transcription-request"

const bytesOf = (length: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) % 256
  return bytes
}

type WithToBase64 = { toBase64?: () => string }
const proto = Uint8Array.prototype as unknown as WithToBase64
const original = proto.toBase64

/** Stand in for the engine's encoder (this test runtime may predate it) with
 *  an independent implementation of the same standard: Node's. */
function installNativeEncoder() {
  const calls = vi.fn()
  proto.toBase64 = function (this: Uint8Array) {
    calls()
    return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString("base64")
  }
  return calls
}

afterEach(() => {
  if (original) proto.toBase64 = original
  else delete proto.toBase64
})

describe("base64Of", () => {
  // Around the padding cases and the 8192-byte slices the hand encoder works in.
  const LENGTHS = [0, 1, 2, 3, 4, 8191, 8192, 8193, 100_001]

  it("uses the engine's encoder, and it gives the string encoding by hand gives", () => {
    const calls = installNativeEncoder()
    for (const length of LENGTHS) {
      const bytes = bytesOf(length)
      expect(base64Of(bytes), `${length} bytes`).toBe(base64ByHand(bytes))
    }
    expect(calls).toHaveBeenCalledTimes(LENGTHS.length)
    // A view into a larger buffer encodes its own bytes, not the buffer's.
    const view = bytesOf(100).subarray(10, 20)
    expect(base64Of(view)).toBe(base64ByHand(view))
  })

  it("encodes by hand on an engine without one", () => {
    delete proto.toBase64
    const bytes = bytesOf(8193)
    expect(base64Of(bytes)).toBe(base64ByHand(bytes))
    expect(atob(base64Of(bytes)).length).toBe(8193)
  })
})

describe("buildTranscriptionRequest", () => {
  it("sends the clip as a 16 kHz mono PCM16 WAV, whichever way it was encoded", async () => {
    const pcm = Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 10) * 0.5)
    delete proto.toBase64
    const byHand = await buildTranscriptionRequest(pcm, "p1", "sw", { model: "omni-fast" })
    installNativeEncoder()
    const byEngine = await buildTranscriptionRequest(pcm, "p1", "sw", { model: "omni-fast" })
    expect(byEngine).toEqual(byHand)
    expect(byEngine).toMatchObject({ projectId: "p1", language: "sw", model: "omni-fast", input_audio: { format: "wav" } })

    const wav = Uint8Array.from(atob(byEngine.input_audio.data), (c) => c.charCodeAt(0))
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF")
    expect(wav.length).toBe(44 + pcm.length * 2)
    const view = new DataView(wav.buffer)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getInt16(44 + 2 * 100, true)).toBe(Math.round(Math.sin(10) * 0.5 * 0x7fff))
  })
})
