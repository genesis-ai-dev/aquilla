import { describe, expect, it } from "vitest"
import { versionCredit, verseTextPresentation } from "./version-display"

describe("version display", () => {
  it("credits the version with its licence and its own site", () => {
    // SBLGNT: helloao lists one eBible page for both; its CC BY terms want sblgnt.com.
    expect(versionCredit("grc_sbl", {
      englishName: "SBL Greek NT",
      shortName: "SBL",
      licenseUrl: "https://ebible.org/Scriptures/details.php?id=grcsbl",
      website: "https://ebible.org/Scriptures/details.php?id=grcsbl",
    })).toEqual({
      name: "SBL Greek NT",
      licenseUrl: "https://ebible.org/Scriptures/details.php?id=grcsbl",
      websiteUrl: "https://sblgnt.com/",
    })
    // Same page twice is one link; a non-http link and missing fields drop out.
    expect(versionCredit("BSB", {
      englishName: "", shortName: "BSB", licenseUrl: "https://berean.bible/", website: "https://berean.bible/",
    })).toEqual({ name: "BSB", licenseUrl: "https://berean.bible/", websiteUrl: null })
    expect(versionCredit("X", {
      englishName: "", shortName: "", licenseUrl: "javascript:alert(1)", website: "",
    })).toEqual({ name: "X", licenseUrl: null, websiteUrl: null })
    expect(versionCredit("Y", undefined)).toEqual({ name: "Y", licenseUrl: null, websiteUrl: null })
  })

  it("sets direction from the catalogue and the serif from the language code", () => {
    expect(verseTextPresentation({ language: "hbo", textDirection: "rtl" })).toEqual({ dir: "rtl", lang: "hbo", script: "hebrew" })
    expect(verseTextPresentation({ language: "grc", textDirection: "ltr" })).toEqual({ dir: "auto", lang: "grc", script: "greek" })
    expect(verseTextPresentation({ language: "arb", textDirection: "rtl" })).toEqual({ dir: "rtl", lang: "arb", script: null })
    expect(verseTextPresentation({ language: "eng", textDirection: "ltr" })).toEqual({ dir: "auto", lang: "eng", script: null })
    expect(verseTextPresentation(undefined)).toEqual({ dir: "auto", lang: undefined, script: null })
  })
})
