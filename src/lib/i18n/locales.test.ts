import { describe, it, expect } from "vitest"
import {
  DEFAULT_LOCALE,
  directionFor,
  isSupportedLocale,
  LOCALES,
  normalizeLocale,
} from "./locales"
import { CATALOGS } from "./messages"
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

describe("Simplified Chinese (AQU-978)", () => {
  it("is registered as a selectable LTR locale under its script subtag", () => {
    const zhHans = LOCALES.find((l) => l.code === "zh-Hans")
    expect(zhHans).toBeDefined()
    expect(zhHans?.dir).toBe("ltr")
    // The switcher lists locales by endonym, so this is what a Chinese reader
    // actually scans the menu for — it must not regress to an English name.
    expect(zhHans?.nativeName).toBe("简体中文")
  })
  it("ships a populated catalog, not an empty stub", () => {
    // The locale being registered is not the deliverable — the strings are. An
    // empty catalog falls back to English per key and would look, from the
    // switcher alone, exactly like a working locale.
    expect(Object.keys(CATALOGS["zh-Hans"] ?? {}).length).toBeGreaterThan(4000)
  })
  it("resolves to itself rather than collapsing onto the bare `zh` subtag", () => {
    expect(normalizeLocale("zh-Hans")).toBe("zh-Hans")
  })
  it("takes script-less and region-only Chinese while it is the only zh catalog", () => {
    // Once zh-Hant (AQU-976) is also registered, exact matches still win and
    // only these script-less codes fall through to the first-listed zh entry.
    expect(normalizeLocale("zh")).toBe("zh-Hans")
    expect(normalizeLocale("zh-CN")).toBe("zh-Hans")
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
