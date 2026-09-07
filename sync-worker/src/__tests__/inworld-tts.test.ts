import { describe, expect, it } from "vitest"
import {
  inworldAuthHeader,
  toInworldLanguage,
  wavDurationSeconds,
  bytesToBase64,
  base64ToBytes,
} from "../inworld-tts"

describe("inworldAuthHeader", () => {
  it("prefixes Basic when the portal key has no scheme", () => {
    expect(inworldAuthHeader("abc123")).toBe("Basic abc123")
  })

  it("leaves an existing Basic prefix alone", () => {
    expect(inworldAuthHeader("Basic already")).toBe("Basic already")
  })
})

describe("toInworldLanguage", () => {
  it("maps ISO-639-3 scripture codes onto BCP-47", () => {
    expect(toInworldLanguage("eng")).toBe("en-US")
    expect(toInworldLanguage("spa")).toBe("es-ES")
    expect(toInworldLanguage("fra")).toBe("fr-FR")
  })

  it("passes through BCP-47 tags", () => {
    expect(toInworldLanguage("en-GB")).toBe("en-GB")
    expect(toInworldLanguage("pt-BR")).toBe("pt-BR")
  })

  it("normalizes underscore separators", () => {
    expect(toInworldLanguage("en_GB")).toBe("en-GB")
  })

  it("omits empty or auto values", () => {
    expect(toInworldLanguage(undefined)).toBeUndefined()
    expect(toInworldLanguage("auto")).toBeUndefined()
    expect(toInworldLanguage("")).toBeUndefined()
  })
})

describe("wavDurationSeconds", () => {
  it("reads duration from a PCM WAV header", () => {
    const sampleRate = 24000
    const samples = 48000
    const dataSize = samples * 2
    const buf = new ArrayBuffer(44 + dataSize)
    const view = new DataView(buf)
    const write = (offset: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
    }
    write(0, "RIFF")
    view.setUint32(4, 36 + dataSize, true)
    write(8, "WAVE")
    write(12, "fmt ")
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    write(36, "data")
    view.setUint32(40, dataSize, true)
    expect(wavDurationSeconds(buf)).toBeCloseTo(2)
  })
})

describe("base64 roundtrip", () => {
  it("survives bytesToBase64 → base64ToBytes", () => {
    const src = new Uint8Array([1, 2, 3, 250, 251, 252]).buffer
    expect(Array.from(new Uint8Array(base64ToBytes(bytesToBase64(src))))).toEqual([1, 2, 3, 250, 251, 252])
  })
})
