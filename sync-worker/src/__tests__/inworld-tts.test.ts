import { describe, expect, it } from "vitest"
import {
  inworldAuthHeader,
  toInworldLanguage,
  wavDurationSeconds,
  bytesToBase64,
  base64ToBytes,
  buildListVoicesFilter,
  inworldLangCodeToBcp47,
  resolveInworldModelId,
  clampInworldSpeakingRate,
  clampInworldDesignSamples,
  parseInworldDesignPromptMode,
  DEFAULT_INWORLD_TTS_MODEL,
  INWORLD_TTS_MODEL_HIGHEST,
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

  it("passes through BCP-47 tags and ISO-639-3 language subtags", () => {
    expect(toInworldLanguage("en-GB")).toBe("en-GB")
    expect(toInworldLanguage("pt-BR")).toBe("pt-BR")
    expect(toInworldLanguage("fil")).toBe("fil")
    expect(toInworldLanguage("yue")).toBe("yue")
    expect(toInworldLanguage("en-scottish")).toBe("en-scottish")
    expect(toInworldLanguage("en-GB-u-sd-gbwls")).toBe("en-GB-u-sd-gbwls")
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

describe("list-voices filter", () => {
  it("maps EN_US onto BCP-47 for badges", () => {
    expect(inworldLangCodeToBcp47("EN_US")).toBe("en-US")
    expect(inworldLangCodeToBcp47("es-ES")).toBe("es-ES")
  })

  it("builds an AIP-160 SYSTEM + lang_code filter for each lane", () => {
    expect(buildListVoicesFilter(["eng"])).toBe('source = "SYSTEM" AND lang_code = "en-US"')
    expect(buildListVoicesFilter(["en-US", "es"])).toBe(
      'source = "SYSTEM" AND (lang_code = "en-US" OR lang_code = "es")',
    )
  })

  it("returns null when no lane maps onto an Inworld language", () => {
    expect(buildListVoicesFilter(["French"])).toBeNull()
    expect(buildListVoicesFilter([])).toBeNull()
  })
})

describe("playground knobs", () => {
  it("maps Standard/Highest onto Flash vs TTS-2", () => {
    expect(resolveInworldModelId("standard")).toBe(DEFAULT_INWORLD_TTS_MODEL)
    expect(resolveInworldModelId("highest")).toBe(INWORLD_TTS_MODEL_HIGHEST)
    expect(resolveInworldModelId(undefined)).toBe(INWORLD_TTS_MODEL_HIGHEST)
    expect(resolveInworldModelId(undefined, "inworld-tts-2")).toBe("inworld-tts-2")
    expect(resolveInworldModelId(undefined, "inworld-tts-2-flash")).toBe("inworld-tts-2-flash")
    expect(resolveInworldModelId("standard", "inworld-tts-2")).toBe(DEFAULT_INWORLD_TTS_MODEL)
  })

  it("clamps speakingRate", () => {
    expect(clampInworldSpeakingRate(0.95)).toBe(0.95)
    expect(clampInworldSpeakingRate(0.1)).toBe(0.5)
    expect(clampInworldSpeakingRate(9)).toBe(1.5)
  })
})

describe("voice design helpers", () => {
  it("defaults sample count to 3 and clamps to 1–3", () => {
    expect(clampInworldDesignSamples(undefined)).toBe(3)
    expect(clampInworldDesignSamples(2)).toBe(2)
    expect(clampInworldDesignSamples(9)).toBe(3)
    expect(clampInworldDesignSamples(0)).toBe(1)
  })

  it("accepts Inworld designPromptMode enum values", () => {
    expect(parseInworldDesignPromptMode("DESIGN_PROMPT_MODE_VERBATIM")).toBe(
      "DESIGN_PROMPT_MODE_VERBATIM",
    )
    expect(parseInworldDesignPromptMode("DESIGN_PROMPT_MODE_ASSISTED")).toBe(
      "DESIGN_PROMPT_MODE_ASSISTED",
    )
    expect(parseInworldDesignPromptMode("verbatim")).toBeUndefined()
    expect(parseInworldDesignPromptMode(undefined)).toBeUndefined()
  })
})
