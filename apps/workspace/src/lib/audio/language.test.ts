import { describe, expect, it } from "vitest"
import { whisperLanguageFromTag } from "./language"

describe("whisperLanguageFromTag", () => {
  it("passes through supported 2-letter codes", () => {
    expect(whisperLanguageFromTag("en")).toBe("en")
    expect(whisperLanguageFromTag("es")).toBe("es")
    expect(whisperLanguageFromTag("hi")).toBe("hi")
    expect(whisperLanguageFromTag("ja")).toBe("ja")
  })

  it("normalizes case and strips region", () => {
    expect(whisperLanguageFromTag("EN")).toBe("en")
    expect(whisperLanguageFromTag("en-US")).toBe("en")
    expect(whisperLanguageFromTag("pt_BR")).toBe("pt")
    expect(whisperLanguageFromTag("fr-CA")).toBe("fr")
  })

  it("maps ISO 639-2 codes to Whisper's 2-letter codes", () => {
    expect(whisperLanguageFromTag("eng")).toBe("en")
    expect(whisperLanguageFromTag("spa")).toBe("es")
    expect(whisperLanguageFromTag("fra")).toBe("fr")
    expect(whisperLanguageFromTag("fre")).toBe("fr")
    expect(whisperLanguageFromTag("deu")).toBe("de")
    expect(whisperLanguageFromTag("ger")).toBe("de")
    expect(whisperLanguageFromTag("hin")).toBe("hi")
    expect(whisperLanguageFromTag("zho")).toBe("zh")
    expect(whisperLanguageFromTag("chi")).toBe("zh")
  })

  it("returns undefined for languages Whisper doesn't support", () => {
    // Tok Pisin, low-resource Bible translation target — Whisper-base doesn't
    // support it, so we want auto-detect rather than throwing.
    expect(whisperLanguageFromTag("tpi")).toBeUndefined()
    // Alpha-2 fictional / not in Whisper's set
    expect(whisperLanguageFromTag("xx")).toBeUndefined()
    // Constructed language (Esperanto)
    expect(whisperLanguageFromTag("eo")).toBeUndefined()
  })

  it("returns undefined for empty / nullish / malformed input", () => {
    expect(whisperLanguageFromTag(undefined)).toBeUndefined()
    expect(whisperLanguageFromTag(null)).toBeUndefined()
    expect(whisperLanguageFromTag("")).toBeUndefined()
    expect(whisperLanguageFromTag("   ")).toBeUndefined()
    expect(whisperLanguageFromTag("english")).toBeUndefined() // 7 letters, falls through
  })
})
