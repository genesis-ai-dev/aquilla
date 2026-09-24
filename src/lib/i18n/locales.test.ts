import { describe, it, expect } from "vitest"
import {
  DEFAULT_LOCALE,
  directionFor,
  isSupportedLocale,
  LOCALE_ALIASES,
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
    expect(isSupportedLocale("ms")).toBe(true)
    expect(isSupportedLocale("zz")).toBe(false)
  })
})

describe("Malay is offered under its real code, not Patani Malay's (AQU-1306)", () => {
  it("does not offer a Patani Malay entry while the catalog is standard Malay", () => {
    // The Pattani Malay team selected "Bahasa Melayu Patani" and got ordinary
    // Bahasa Malaysia. A mislabelled locale is worse than a missing one, because
    // the label is the only thing a speaker can check before trusting the UI.
    expect(LOCALES.find((l) => l.code === "mfa")).toBeUndefined()
    expect(LOCALES.map((l) => l.nativeName)).not.toContain("Bahasa Melayu Patani")
    expect(LOCALES.map((l) => l.englishName)).not.toContain("Patani Malay")
  })
  it("registers the catalog as standard Malay with the matching endonym", () => {
    const malay = LOCALES.find((l) => l.code === "ms")
    expect(malay).toBeDefined()
    expect(malay?.englishName).toBe("Malay")
    expect(malay?.nativeName).toBe("Bahasa Melayu")
    expect(malay?.dir).toBe("ltr")
  })
  it("ships the populated catalog under `ms`, with nothing left under `mfa`", () => {
    expect(Object.keys(CATALOGS.ms ?? {}).length).toBeGreaterThan(4000)
    expect(CATALOGS.mfa).toBeUndefined()
  })
  it("migrates a stored `mfa` preference to the same strings instead of English", () => {
    // Anyone already on "Bahasa Melayu Patani" must keep the UI they had — the
    // strings were always Malay. Dropping to English would read as the app
    // losing their language rather than correcting its name.
    expect(LOCALE_ALIASES.mfa).toBe("ms")
    expect(normalizeLocale("mfa")).toBe("ms")
    expect(detectInitialLocale("mfa", "en-US")).toBe("ms")
  })
  it("keeps aliases out of the switcher", () => {
    // An alias is reachable from storage or Accept-Language, never offered as a
    // choice — otherwise removing the false claim would just reintroduce it.
    for (const retired of Object.keys(LOCALE_ALIASES)) {
      expect(LOCALES.some((l) => l.code === retired)).toBe(false)
    }
  })
  it("resolves every alias target to a real registered locale", () => {
    for (const target of Object.values(LOCALE_ALIASES)) {
      expect(isSupportedLocale(target)).toBe(true)
    }
  })
})

describe("Indonesian (AQU-869)", () => {
  it("is registered as a selectable LTR locale with its endonym", () => {
    const indonesian = LOCALES.find((l) => l.code === "id")
    expect(indonesian).toBeDefined()
    expect(indonesian?.englishName).toBe("Indonesian")
    expect(indonesian?.nativeName).toBe("Bahasa Indonesia")
    expect(indonesian?.dir).toBe("ltr")
  })
  it("ships a populated catalog, not an empty stub", () => {
    // Same bar as every other locale: registering the code is not the
    // deliverable, the strings are. An empty catalog falls back to English per
    // key and would look, from the switcher alone, exactly like a working one.
    expect(Object.keys(CATALOGS.id ?? {}).length).toBeGreaterThan(4000)
  })
  it("is Indonesian, not Malay wearing an Indonesian label (AQU-1306)", () => {
    // `id` and `ms` are close relatives, so the cheap way to produce this
    // catalog would have been to transform the Malay one. The UI register is
    // where that shortcut shows: these pairs mean the same thing and differ by
    // language, so Malay forms appearing under `id` mean the wrong language
    // shipped — the exact defect AQU-1306 was filed for, under a new code.
    const id = CATALOGS.id ?? {}
    const values = Object.values(id).filter((v): v is string => typeof v === "string")
    const joined = values.join("\n").toLowerCase()
    for (const malayOnly of ["muat naik", "muat turun", "pratonton", "tetapan", "projek"]) {
      expect(joined).not.toContain(malayOnly)
    }
    expect(id["common.save"]).toBe("Simpan")
    expect(id["common.delete"]).toBe("Hapus")
    expect(id["common.preview"]).toBe("Pratinjau")
    expect(id["common.project"]).toBe("Proyek")
    expect(id["nav.settings"]).toBe("Pengaturan")
    expect(id["common.comments"]).toBe("Komentar")
  })
  it("addresses the reader as `Anda`, never `kamu`", () => {
    // One register throughout. `kamu` is the familiar form; a Bible-translation
    // team reading their own tooling should not be addressed like a child.
    const values = Object.values(CATALOGS.id ?? {}).filter((v): v is string => typeof v === "string")
    expect(values.filter((v) => /\bkamu\b/i.test(v))).toEqual([])
    expect(values.some((v) => /\bAnda\b/.test(v))).toBe(true)
  })
  it("migrates the retired `in` code instead of dropping it to English", () => {
    // `in` is Indonesian's pre-1989 ISO 639-1 code. It shares no primary subtag
    // with `id`, so without the alias the subtag branch cannot save it.
    expect(LOCALE_ALIASES.in).toBe("id")
    expect(normalizeLocale("in")).toBe("id")
    expect(detectInitialLocale("in", "en-US")).toBe("id")
    expect(normalizeLocale("id")).toBe("id")
    expect(normalizeLocale("id-ID")).toBe("id")
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
  it("takes script-less and region-only Chinese as the first-listed zh entry", () => {
    // zh-Hant (AQU-976) is also registered; exact matches win, and non-exact
    // codes fall through on the primary subtag to the first-listed zh entry —
    // including zh-TW, since region codes are not exact matches.
    expect(normalizeLocale("zh")).toBe("zh-Hans")
    expect(normalizeLocale("zh-CN")).toBe("zh-Hans")
    expect(normalizeLocale("zh-TW")).toBe("zh-Hans")
  })
})

describe("Traditional Chinese (AQU-976)", () => {
  it("is registered as a selectable LTR locale under its script subtag", () => {
    const zhHant = LOCALES.find((l) => l.code === "zh-Hant")
    expect(zhHant).toBeDefined()
    expect(zhHant?.dir).toBe("ltr")
    expect(zhHant?.nativeName).toBe("繁體中文")
  })
  it("ships a populated catalog, not an empty stub", () => {
    expect(Object.keys(CATALOGS["zh-Hant"] ?? {}).length).toBeGreaterThan(4000)
  })
  it("resolves to itself rather than falling through to zh-Hans", () => {
    expect(normalizeLocale("zh-Hant")).toBe("zh-Hant")
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
