import { describe, expect, it } from "vitest"

import {
  LANGUAGES,
  LANGUAGE_SUGGESTION_LIMIT,
  filterLanguages,
  isSettledLanguage,
} from "./catalog"

const names = (query: string, options?: Parameters<typeof filterLanguages>[1]) =>
  filterLanguages(query, options).map((entry) => entry.name)

describe("language catalog", () => {
  it("bundles the ISO 639-1 set with unique codes and names", () => {
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(180)
    expect(new Set(LANGUAGES.map((l) => l.code)).size).toBe(LANGUAGES.length)
    expect(new Set(LANGUAGES.map((l) => l.name)).size).toBe(LANGUAGES.length)
  })

  it("stores display names, never codes", () => {
    for (const entry of LANGUAGES) {
      expect(entry.code).toMatch(/^[a-z]{2}$/)
      expect(entry.name.length).toBeGreaterThan(entry.code.length)
    }
  })
})

describe("filterLanguages", () => {
  it("surfaces French from a partial name (the AQU-988 example)", () => {
    expect(names("fre")).toContain("French")
  })

  it("ranks an exact code first", () => {
    expect(names("fr")[0]).toBe("French")
    expect(names("en")[0]).toBe("English")
  })

  it("ranks a name prefix above a mid-word substring", () => {
    const results = names("ala")
    // "Malayalam"/"Malay" contain "ala"; nothing starts with it, so a
    // substring match is still returned rather than dropped.
    expect(results.length).toBeGreaterThan(0)
    expect(names("mala")[0]).toMatch(/^Mala/)
  })

  it("is case- and diacritic-insensitive", () => {
    expect(names("SPANISH")).toContain("Spanish")
    // Catalog names are ASCII, but a user pasting accents must still match.
    expect(names("Français")).toEqual(names("Francais"))
  })

  it("returns the head of the catalog for an empty query", () => {
    const all = filterLanguages("")
    expect(all).toHaveLength(LANGUAGE_SUGGESTION_LIMIT)
    expect(all[0]).toEqual(LANGUAGES[0])
    expect(filterLanguages("   ")).toEqual(all)
  })

  it("returns nothing for a genuinely custom label", () => {
    // The free-text escape hatch: no suggestion should pretend to match.
    expect(filterLanguages("Grade 7 English")).toEqual([])
  })

  it("honours the limit", () => {
    expect(filterLanguages("a", { limit: 3 })).toHaveLength(3)
  })

  it("drops excluded values case-insensitively", () => {
    expect(names("fren", { exclude: ["french"] })).toEqual([])
    expect(names("fren", { exclude: ["  FRENCH  "] })).toEqual([])
    expect(names("fren", { exclude: ["German"] })).toContain("French")
  })

  it("ignores empty exclusions (the unset default lane)", () => {
    expect(names("fre", { exclude: [""] })).toContain("French")
  })
})

describe("isSettledLanguage", () => {
  it("is true when the text already IS the only remaining match", () => {
    expect(isSettledLanguage("French", filterLanguages("French"))).toBe(true)
    expect(isSettledLanguage("  french  ", filterLanguages("french"))).toBe(true)
  })

  it("is false while the text is still a partial match", () => {
    expect(isSettledLanguage("fre", filterLanguages("fre"))).toBe(false)
  })

  it("is false for a code, which still has a name worth offering", () => {
    expect(isSettledLanguage("fr", filterLanguages("fr"))).toBe(false)
  })

  it("is false when several languages still match", () => {
    expect(isSettledLanguage("Norwegian", filterLanguages("Norwegian"))).toBe(false)
  })

  it("is false with no matches at all (a custom label)", () => {
    expect(isSettledLanguage("Grade 7 English", [])).toBe(false)
  })
})
