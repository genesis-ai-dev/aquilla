/**
 * AQU-1597: one normalizer answers every "same language?" question. These
 * tests pin the contract every caller now depends on — the SPA, auth-worker
 * and sync-worker all import the same module, so a disagreement here is a
 * disagreement between a lane, a billing count and an API validation.
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
})

describe("languageTagKey / sameLanguageTag", () => {
  it("gives one key to every spelling of a language", () => {
    expect(languageTagKey("Spanish")).toBe(languageTagKey("es"))
    expect(languageTagKey("spanish")).toBe(languageTagKey("spa"))
  })

  it("keeps a regional lane distinct from its base language (AQU-1473)", () => {
    expect(sameLanguageTag("fr-CA", "French")).toBe(false)
    expect(sameLanguageTag("fr-CA", "FR_ca")).toBe(true)
    expect(languageTagKey("fr-CA")).toBe("fra-ca")
  })

  it("never treats the default lane as a language", () => {
    expect(languageTagKey("")).toBe("")
    expect(sameLanguageTag("", "")).toBe(false)
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

  it("returns undefined for a language nobody registered", () => {
    expect(matchLanguageTag("German", registered)).toBeUndefined()
    expect(matchLanguageTag("French", registered)).toBeUndefined()
  })

  it("matches an empty tag only against an empty candidate", () => {
    expect(matchLanguageTag("", registered)).toBeUndefined()
    expect(matchLanguageTag("", ["", "Spanish"])).toBe("")
  })
})
