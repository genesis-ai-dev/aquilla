import { describe, expect, it } from "vitest"
import {
  DEFAULT_KOKORO_BRITISH_VOICE,
  DEFAULT_KOKORO_VOICE,
  defaultKokoroVoiceForLanguage,
  inferKokoroLangPrefix,
  isBundledKokoroVoiceName,
  kokoroSpeaksEnglishOnlyFor,
  kokoroVoiceGroupsForLanguage,
  phonemizerLanguageForPrefix,
} from "./kokoro-languages"

describe("inferKokoroLangPrefix", () => {
  it("maps American English tags to prefix a (phonemizer en-us)", () => {
    expect(inferKokoroLangPrefix("en-us")).toBe("a")
    expect(inferKokoroLangPrefix("en-US")).toBe("a")
    expect(inferKokoroLangPrefix("en")).toBe("a")
    expect(inferKokoroLangPrefix("eng")).toBe("a")
    expect(inferKokoroLangPrefix("English")).toBe("a")
    expect(phonemizerLanguageForPrefix("a")).toBe("en-us")
  })

  it("maps British English tags to prefix b", () => {
    expect(inferKokoroLangPrefix("en-gb")).toBe("b")
    expect(inferKokoroLangPrefix("en-GB")).toBe("b")
    expect(inferKokoroLangPrefix("british")).toBe("b")
    expect(phonemizerLanguageForPrefix("b")).toBe("en-gb")
  })

  it("maps the rest of the Kokoro prefix table", () => {
    expect(inferKokoroLangPrefix("es")).toBe("e")
    expect(inferKokoroLangPrefix("fr-fr")).toBe("f")
    expect(inferKokoroLangPrefix("hi")).toBe("h")
    expect(inferKokoroLangPrefix("it")).toBe("i")
    expect(inferKokoroLangPrefix("ja")).toBe("j")
    expect(inferKokoroLangPrefix("pt-br")).toBe("p")
    expect(inferKokoroLangPrefix("zh")).toBe("z")
  })

  it("returns undefined for languages Kokoro does not cover", () => {
    expect(inferKokoroLangPrefix("tpi")).toBeUndefined()
    expect(inferKokoroLangPrefix("")).toBeUndefined()
    expect(inferKokoroLangPrefix(undefined)).toBeUndefined()
  })
})

describe("defaultKokoroVoiceForLanguage", () => {
  it("picks an American voice for en-us", () => {
    expect(defaultKokoroVoiceForLanguage("en-us")).toBe(DEFAULT_KOKORO_VOICE)
  })

  it("picks a British voice for en-gb", () => {
    expect(defaultKokoroVoiceForLanguage("en-gb")).toBe(DEFAULT_KOKORO_BRITISH_VOICE)
  })

  it("falls back to American for unknown or non-bundled languages", () => {
    expect(defaultKokoroVoiceForLanguage("es")).toBe(DEFAULT_KOKORO_VOICE)
    expect(defaultKokoroVoiceForLanguage(undefined)).toBe(DEFAULT_KOKORO_VOICE)
  })
})

describe("isBundledKokoroVoiceName", () => {
  it("accepts the 82M American and British ids", () => {
    expect(isBundledKokoroVoiceName("af_heart")).toBe(true)
    expect(isBundledKokoroVoiceName("am_adam")).toBe(true)
    expect(isBundledKokoroVoiceName("bf_emma")).toBe(true)
    expect(isBundledKokoroVoiceName("bm_george")).toBe(true)
  })

  it("rejects BCP-47 tags and prefixes the 82M model does not ship", () => {
    expect(isBundledKokoroVoiceName("en-us")).toBe(false)
    expect(isBundledKokoroVoiceName("ef_dora")).toBe(false)
    expect(isBundledKokoroVoiceName("Kore")).toBe(false)
  })
})

describe("kokoroVoiceGroupsForLanguage", () => {
  it("lists American voices first for en-us", () => {
    const groups = kokoroVoiceGroupsForLanguage("en-us")
    expect(groups.map((g) => g.prefix)).toEqual(["a", "b"])
    expect(groups[0]!.voices[0]!.id).toBe("af_heart")
  })

  it("lists British voices first for en-gb without dropping American ones", () => {
    const groups = kokoroVoiceGroupsForLanguage("en-gb")
    expect(groups.map((g) => g.prefix)).toEqual(["b", "a"])
    expect(groups[0]!.voices.some((v) => v.id === "bf_emma")).toBe(true)
    expect(groups[1]!.voices.some((v) => v.id === "af_bella")).toBe(true)
  })
})

describe("kokoroSpeaksEnglishOnlyFor", () => {
  it("is false for American and British tags", () => {
    expect(kokoroSpeaksEnglishOnlyFor("en-us")).toBe(false)
    expect(kokoroSpeaksEnglishOnlyFor("en-gb")).toBe(false)
    expect(kokoroSpeaksEnglishOnlyFor(undefined)).toBe(false)
  })

  it("is true for languages the 82M model cannot speak", () => {
    expect(kokoroSpeaksEnglishOnlyFor("es")).toBe(true)
    expect(kokoroSpeaksEnglishOnlyFor("tpi")).toBe(true)
  })
})
