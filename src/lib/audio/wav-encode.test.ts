import { describe, it, expect } from "vitest"
import { encodeWavPcm16 } from "./wav-encode"

async function bytes(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer())
}

describe("encodeWavPcm16", () => {
  it("writes a valid mono 16-bit RIFF/WAVE header", async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
    const dv = await bytes(encodeWavPcm16(samples, 48000))
    // "RIFF"
    expect(String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))).toBe("RIFF")
    // "WAVE"
    expect(String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11))).toBe("WAVE")
    expect(dv.getUint16(22, true)).toBe(1)       // channels = mono
    expect(dv.getUint32(24, true)).toBe(48000)   // sample rate
    expect(dv.getUint16(34, true)).toBe(16)      // bits per sample
    // data chunk size = samples * 2 bytes
    expect(dv.getUint32(40, true)).toBe(5 * 2)
  })

  it("clamps and quantizes samples to int16 range", async () => {
    const dv = await bytes(encodeWavPcm16(new Float32Array([1, -1, 2, -2]), 8000))
    const first = dv.getInt16(44, true)
    const second = dv.getInt16(46, true)
    expect(first).toBe(32767)   // +1.0 → max
    expect(second).toBe(-32768) // -1.0 → min
    expect(dv.getInt16(48, true)).toBe(32767)  // +2.0 clamped
    expect(dv.getInt16(50, true)).toBe(-32768) // -2.0 clamped
  })
})
