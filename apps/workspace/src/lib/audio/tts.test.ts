import { describe, expect, it } from "vitest"
import { pcmToWavBlob, synthesizeToWavBlob } from "./tts"

describe("pcmToWavBlob", () => {
  it("emits a valid RIFF/WAVE header for 16-bit mono PCM", async () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1.0, -1.0])
    const blob = await pcmToWavBlob(pcm, 24000).arrayBuffer()
    const view = new DataView(blob)
    const decoder = new TextDecoder()

    // RIFF magic + WAVE format
    expect(decoder.decode(blob.slice(0, 4))).toBe("RIFF")
    expect(decoder.decode(blob.slice(8, 12))).toBe("WAVE")
    expect(decoder.decode(blob.slice(12, 16))).toBe("fmt ")
    expect(decoder.decode(blob.slice(36, 40))).toBe("data")

    // fmt chunk
    expect(view.getUint32(16, true)).toBe(16)         // sub-chunk size
    expect(view.getUint16(20, true)).toBe(1)          // PCM
    expect(view.getUint16(22, true)).toBe(1)          // mono
    expect(view.getUint32(24, true)).toBe(24000)      // sample rate
    expect(view.getUint16(34, true)).toBe(16)         // 16-bit

    // Data size = 5 samples * 2 bytes
    expect(view.getUint32(40, true)).toBe(10)

    // Spot-check sample encoding (little-endian s16)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(Math.round(0.5 * 0x7fff))
    expect(view.getInt16(48, true)).toBe(Math.round(-0.5 * 0x8000))
    expect(view.getInt16(50, true)).toBe(0x7fff)      // clamp positive
    expect(view.getInt16(52, true)).toBe(-0x8000)     // clamp negative
  })

  it("clamps out-of-range samples", async () => {
    const pcm = new Float32Array([2.0, -2.0])
    const blob = await pcmToWavBlob(pcm, 16000).arrayBuffer()
    const view = new DataView(blob)
    expect(view.getInt16(44, true)).toBe(0x7fff)
    expect(view.getInt16(46, true)).toBe(-0x8000)
  })
})

describe("synthesizeToWavBlob", () => {
  it("rejects empty text before loading a provider", async () => {
    await expect(synthesizeToWavBlob("   ", {
      voice: { id: "mms-eng", name: "English", provider: "mms", voiceName: "eng" },
    })).rejects.toThrow("No text to synthesize")
  })
})
