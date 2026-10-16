import { describe, expect, it } from "vitest"
import {
  QWEN3_ASR_CODES, QWEN3_ASR_DIALECTS, autoRouteIsOpenRouter, loadOmnilingualCodes,
  omnilingualLanguages, toOmniCode, toQwenCode, toWhisperCode, whisperLanguages,
} from "./index"

// The picker promises "Supports <language>" per model, and the hosted client
// sizes its windows by where the server will route a tag. Both rest on these
// mappings agreeing with each model's real language list.

describe("ASR language catalogs", () => {
  it("ships the upstream Omnilingual list and Qwen's 30 + 22", async () => {
    const codes = await loadOmnilingualCodes()
    expect(codes.length).toBeGreaterThan(1600)
    expect(codes).toContain("tpi_Latn")
    expect(QWEN3_ASR_CODES).toHaveLength(30)
    expect(QWEN3_ASR_DIALECTS).toHaveLength(22)
    expect(whisperLanguages("en").find((l) => l.code === "sw")?.label).toBe("Swahili")
    expect(omnilingualLanguages(["tpi_Latn"], "en")[0].label).toMatch(/Tok Pisin/)
  })

  it("maps a tag onto each model whether it is written as 639-1 or 639-3", async () => {
    const codes = await loadOmnilingualCodes()
    expect(toOmniCode("ig", codes)).toBe("ibo_Latn")
    expect(toOmniCode("ibo", codes)).toBe("ibo_Latn")
    expect(toOmniCode("tpi", codes)).toBe("tpi_Latn")
    // The script subtag picks among scripts; without one, the first upstream code.
    expect(toOmniCode("uz-Latn", codes)).toBe("uzb_Latn")
    expect(toOmniCode("zh-Hant", codes)).toBe("cmn_Hant")
    expect(toOmniCode("Tripuri", codes)).toBeUndefined()
    expect(toQwenCode("yue")).toBe("yue")
    expect(toQwenCode("cmn-Hans")).toBe("zh")
    expect(toQwenCode("tgl")).toBe("fil")
    expect(toQwenCode("tpi")).toBeUndefined()
    expect(toWhisperCode("spa")).toBe("es")
  })

  it("sends to OpenRouter (60 s windows) what the server's Automatic routing does", () => {
    expect(autoRouteIsOpenRouter("sw")).toBe(true) // Whisper
    expect(autoRouteIsOpenRouter("yue")).toBe(true) // Qwen
    expect(autoRouteIsOpenRouter("")).toBe(true) // Whisper auto-detect
    expect(autoRouteIsOpenRouter("tpi")).toBe(false) // Omnilingual
  })
})
