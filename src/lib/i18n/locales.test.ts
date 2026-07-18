import { describe, it, expect } from "vitest"
import {
  DEFAULT_LOCALE,
  directionFor,
  isSupportedLocale,
  LOCALES,
  normalizeLocale,
} from "./locales"
import { detectInitialLocale } from "./store"

describe("locale registry", () => {
  it("English is the default and is LTR", () => {
    expect(DEFAULT_LOCALE).toBe("en")
    expect(directionFor("en")).toBe("ltr")
  })
  it("Arabic is the only RTL locale for now", () => {
    expect(directionFor("ar")).toBe("rtl")
    for (const l of LOCALES) {
      if (l.code !== "ar") expect(l.dir).toBe("ltr")
    }
  })
  it("directionFor defaults unknown codes to LTR", () => {
    expect(directionFor("zz")).toBe("ltr")
  })
  it("isSupportedLocale reflects the registry", () => {
    expect(isSupportedLocale("my")).toBe(true)
    expect(isSupportedLocale("mfa")).toBe(true)
    expect(isSupportedLocale("zz")).toBe(false)
  })
})

describe("normalizeLocale", () => {
  it("keeps an exact supported code", () => {
    expect(normalizeLocale("ar")).toBe("ar")
  })
  it("matches on the primary subtag", () => {
    expect(normalizeLocale("en-US")).toBe("en")
    expect(normalizeLocale("ar-EG")).toBe("ar")
  })
  it("falls back to the default for unsupported or empty input", () => {
    expect(normalizeLocale("zz")).toBe("en")
    expect(normalizeLocale(null)).toBe("en")
    expect(normalizeLocale(undefined)).toBe("en")
  })
})

describe("detectInitialLocale", () => {
  it("prefers a stored, supported locale", () => {
    expect(detectInitialLocale("my", "en-US")).toBe("my")
  })
  it("ignores an unsupported stored locale and uses the navigator", () => {
    expect(detectInitialLocale("zz", "ar-EG")).toBe("ar")
  })
  it("falls back to English when nothing matches", () => {
    expect(detectInitialLocale(null, "zz")).toBe("en")
  })
})
