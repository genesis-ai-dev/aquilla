import { describe, expect, it } from "vitest"
import {
  accentLabelForRow,
  canonicalizeDesignLocale,
  defaultCodeForFamily,
  designAccentsForFamily,
  designLanguageFamilies,
  familyCodeOf,
  formatDesignAccentLabel,
  formatDesignLanguageName,
  isFamilyDefaultAccent,
  primaryLanguageOf,
  regionFlagEmoji,
  regionOf,
  withExtraDesignLanguage,
  localeRowsForPicker,
} from "./inworld-design-locales"
import {
  fallbackDesignLanguages,
  parseInworldSupportedLanguages,
  type InworldSupportedLanguage,
} from "./inworld-supported-languages"

const named = (region: "US" | "GB" | "MX" | "BR") =>
  ({ US: "American", GB: "British", MX: "Mexican", BR: "Brazilian" })[region]

function lang(
  partial: Partial<InworldSupportedLanguage> & Pick<InworldSupportedLanguage, "code" | "familyCode" | "familyDisplayName">,
): InworldSupportedLanguage {
  return {
    accentDisplayName: "",
    displayName: partial.familyDisplayName,
    creationEnabled: true,
    hasVoices: true,
    ...partial,
  }
}

const portalCatalog = parseInworldSupportedLanguages({
  languages: [
    lang({ code: "kbt", familyCode: "kbt", familyDisplayName: "Abadi" }),
    lang({ code: "en", familyCode: "en", familyDisplayName: "English" }),
    lang({
      code: "en-US",
      familyCode: "en",
      familyDisplayName: "English",
      accentDisplayName: "American",
    }),
    lang({
      code: "en-GB",
      familyCode: "en",
      familyDisplayName: "English",
      accentDisplayName: "British",
    }),
    lang({
      code: "en-scottish",
      familyCode: "en",
      familyDisplayName: "English",
      accentDisplayName: "Scottish",
    }),
    lang({ code: "fr", familyCode: "fr", familyDisplayName: "French" }),
    lang({
      code: "fr-FR",
      familyCode: "fr",
      familyDisplayName: "French",
      accentDisplayName: "French",
    }),
    lang({
      code: "es-MX",
      familyCode: "es",
      familyDisplayName: "Spanish",
      accentDisplayName: "Mexican",
    }),
    lang({ code: "und", familyCode: "und", familyDisplayName: "Undetermined" }),
  ],
})

describe("parseInworldSupportedLanguages", () => {
  it("drops undetermined and creation-disabled rows", () => {
    const rows = parseInworldSupportedLanguages({
      supportedLanguages: [
        lang({ code: "en-US", familyCode: "en", familyDisplayName: "English", accentDisplayName: "American" }),
        lang({ code: "und", familyCode: "und", familyDisplayName: "Undetermined" }),
        { ...lang({ code: "xx", familyCode: "xx", familyDisplayName: "Nope" }), creationEnabled: false },
      ],
    })
    expect(rows.map((row) => row.code)).toEqual(["en-US"])
  })

  it("accepts the worker JSON shape", () => {
    const rows = parseInworldSupportedLanguages({
      languages: [
        lang({ code: "kbt", familyCode: "kbt", familyDisplayName: "Abadi" }),
      ],
    })
    expect(rows[0]?.familyDisplayName).toBe("Abadi")
  })
})

describe("portal catalog grouping", () => {
  it("lists families from the live catalog, including languages with no SYSTEM voices", () => {
    const families = designLanguageFamilies(portalCatalog)
    expect(families.map((row) => row.familyDisplayName)).toEqual(
      expect.arrayContaining(["Abadi", "English", "French", "Spanish"]),
    )
    expect(families.some((row) => row.familyCode === "und")).toBe(false)
  })

  it("does not cap the catalog at the published TTS-2 table", () => {
    const rows = parseInworldSupportedLanguages({
      languages: Array.from({ length: 250 }, (_, i) => {
        const code = `l${String(i).padStart(2, "0")}`
        return lang({ code, familyCode: code, familyDisplayName: `Lang ${i}` })
      }),
    })
    expect(designLanguageFamilies(rows)).toHaveLength(250)
  })

  it("puts the family default first, then named accents", () => {
    expect(designAccentsForFamily("en", portalCatalog).map((row) => row.code)).toEqual([
      "en",
      "en-US",
      "en-GB",
      "en-scottish",
    ])
  })

  it("synthesizes Default when the catalog only has named regional rows", () => {
    const namedOnly = portalCatalog.filter((row) => row.code !== "en")
    expect(designAccentsForFamily("en", namedOnly).map((row) => row.code)).toEqual([
      "en",
      "en-US",
      "en-GB",
      "en-scottish",
    ])
  })

  it("defaults English to the family Default", () => {
    expect(defaultCodeForFamily("en", portalCatalog)).toBe("en")
  })

  it("canonicalizes a saved code, a bare family, and a lane display name", () => {
    expect(canonicalizeDesignLocale("en-GB", portalCatalog)).toBe("en-GB")
    expect(canonicalizeDesignLocale("en", portalCatalog)).toBe("en")
    expect(canonicalizeDesignLocale("French", portalCatalog)).toBe("fr")
    expect(canonicalizeDesignLocale("es-MX", portalCatalog)).toBe("es-MX")
    expect(canonicalizeDesignLocale("en-scottish", portalCatalog)).toBe("en-scottish")
    expect(canonicalizeDesignLocale(undefined, portalCatalog)).toBe("en")
  })

  it("does not add a second family when the extra is a display name already in the catalog", () => {
    const families = designLanguageFamilies(withExtraDesignLanguage(portalCatalog, "French"))
    expect(families.filter((row) => row.familyDisplayName === "French")).toHaveLength(1)
    expect(families.some((row) => row.familyCode === "French")).toBe(false)
  })

  it("keeps only languages with SYSTEM voices for the prebuilt picker", () => {
    const mixed = [
      lang({ code: "en", familyCode: "en", familyDisplayName: "English", hasVoices: true }),
      lang({ code: "kbt", familyCode: "kbt", familyDisplayName: "Abadi", hasVoices: false }),
    ]
    const families = designLanguageFamilies(localeRowsForPicker(mixed, "kbt", true))
    expect(families.map((row) => row.familyCode)).toEqual(["en"])
  })

  it("labels the bare family code as a family-default accent", () => {
    const english = portalCatalog.find((row) => row.code === "en")!
    expect(isFamilyDefaultAccent(english)).toBe(true)
    expect(isFamilyDefaultAccent(portalCatalog.find((row) => row.code === "en-US")!)).toBe(false)
  })

  it("labels accents from the portal fields", () => {
    const american = portalCatalog.find((row) => row.code === "en-US")!
    const scottish = portalCatalog.find((row) => row.code === "en-scottish")!
    expect(accentLabelForRow(american, "en", named, "Standard")).toBe("American")
    expect(accentLabelForRow(scottish, "en", named, "Standard")).toBe("Scottish")
    expect(familyCodeOf("en-US", portalCatalog)).toBe("en")
  })
})

describe("TTS-2 fallback catalog", () => {
  it("still offers the published table when Inworld is unreachable", () => {
    const rows = fallbackDesignLanguages()
    expect(designLanguageFamilies(rows).length).toBeGreaterThanOrEqual(90)
    expect(rows.some((row) => row.code === "sw")).toBe(true)
    expect(rows.some((row) => row.code === "fil")).toBe(true)
    expect(defaultCodeForFamily("en", rows)).toBe("en")
  })
})

describe("legacy helpers", () => {
  it("reads the primary tag and region", () => {
    expect(primaryLanguageOf("en-US")).toBe("en")
    expect(regionOf("en-GB")).toBe("GB")
    expect(regionOf("yo")).toBeUndefined()
  })

  it("names the language without a BCP-47 suffix", () => {
    expect(formatDesignLanguageName("en-US", "en")).toMatch(/^English$/i)
    expect(formatDesignLanguageName("fr", "en")).toMatch(/^French$/i)
    expect(formatDesignLanguageName("acw", "en")).toBe("Hijazi Arabic")
    expect(formatDesignLanguageName("uzn", "en")).toBe("Northern Uzbek")
  })

  it("uses named accents for US/GB/MX/BR and a region name otherwise", () => {
    expect(formatDesignAccentLabel("en-US", "en", named, "Standard")).toBe("American")
    expect(formatDesignAccentLabel("en-GB", "en", named, "Standard")).toBe("British")
    expect(formatDesignAccentLabel("fr-FR", "en", named, "Standard")).toMatch(/France/i)
    expect(formatDesignAccentLabel("yo", "en", named, "Standard")).toBe("Standard")
  })

  it("builds a regional-indicator flag", () => {
    expect(regionFlagEmoji("US")).toBe("🇺🇸")
    expect(regionFlagEmoji("GB")).toBe("🇬🇧")
    expect(regionFlagEmoji("x")).toBe("")
  })
})
