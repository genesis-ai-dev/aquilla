/**
 * AQU-1597: one normalizer answers every "same language?" question. These
 * tests pin the contract every caller now depends on — the SPA, auth-worker
 * and sync-worker all import the same module. It answers "same language?",
 * never "same lane?".
 */
import { describe, it, expect } from "vitest"
import {
  normalizeLanguageTag,
  languagesEqual,
  languageTagKey,
  sameLanguageTag,
  matchLanguageTag,
} from "./language-normalize"

describe("languagesEqual", () => {
  it('treats "Spanish", "spanish" and "es" as the same language', () => {
    expect(languagesEqual("Spanish", "spanish")).toBe(true)
    expect(languagesEqual("Spanish", "es")).toBe(true)
    expect(languagesEqual("es", "spa")).toBe(true)
    expect(languagesEqual("  SPANISH  ", "es")).toBe(true)
  })

  it("keeps different languages apart", () => {
    expect(languagesEqual("Spanish", "French")).toBe(false)
    expect(languagesEqual("es", "fr")).toBe(false)
  })

  it("compares unknown tags by identity, case-insensitively", () => {
    expect(languagesEqual("Bla", "bla")).toBe(true)
    expect(languagesEqual("bla", "blb")).toBe(false)
  })

  it("strips the region, so a regional tag equals its base language", () => {
    expect(languagesEqual("fr-CA", "French")).toBe(true)
    expect(normalizeLanguageTag("fr-CA")).toBe("fra")
  })

  it("covers the full catalog, not a short table of common languages", () => {
    expect(languagesEqual("Yoruba", "yo")).toBe(true)
    expect(languagesEqual("yo", "yor")).toBe(true)
    expect(normalizeLanguageTag("Yoruba")).toBe("yor")
  })
})

describe("languageTagKey / sameLanguageTag", () => {
  it("gives one key to every spelling of a language", () => {
    expect(languageTagKey("Spanish")).toBe(languageTagKey("es"))
    expect(languageTagKey("spanish")).toBe(languageTagKey("spa"))
    expect(languageTagKey("Yoruba")).toBe(languageTagKey("yo"))
  })

  it("agrees with languagesEqual, including a region and a blank", () => {
    expect(sameLanguageTag("fr-CA", "French")).toBe(languagesEqual("fr-CA", "French"))
    expect(sameLanguageTag("fr-CA", "French")).toBe(true)
    expect(sameLanguageTag("fr-CA", "FR_ca")).toBe(true)
    expect(languageTagKey("fr-CA")).toBe("fra")
    expect(languageTagKey("")).toBe("")
    expect(sameLanguageTag("", "")).toBe(true)
    expect(sameLanguageTag("", "Spanish")).toBe(false)
  })
})

describe("matchLanguageTag", () => {
  const registered = ["Spanish", "fr-CA", "Tagalog"]

  it("resolves another spelling to the registered tag, which is what gets written", () => {
    expect(matchLanguageTag("es", registered)).toBe("Spanish")
    expect(matchLanguageTag("spanish", registered)).toBe("Spanish")
    expect(matchLanguageTag("SPA", registered)).toBe("Spanish")
  })

  it("prefers an exact match over a same-language one", () => {
    expect(matchLanguageTag("spanish", ["Spanish", "spanish"])).toBe("spanish")
  })

  it("returns undefined for a language nobody registered, and a region of one that is", () => {
    expect(matchLanguageTag("German", registered)).toBeUndefined()
    // fr-CA is French. This names a language, not a lane.
    expect(matchLanguageTag("French", registered)).toBe("fr-CA")
  })

  it("matches an empty tag only against an empty candidate", () => {
    expect(matchLanguageTag("", registered)).toBeUndefined()
    expect(matchLanguageTag("", ["", "Spanish"])).toBe("")
  })
})
