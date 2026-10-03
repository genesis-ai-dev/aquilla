// AQU-1592 — a lane stores only what the user typed; the display name and the
// language code are DERIVED here, on the read path.
//
// These are the regression guards for AQU-1585: a derived value captured at
// write time keeps claiming the old language after the label is edited. Every
// test below asserts that deriving on read makes that impossible.

import { describe, expect, it } from "vitest"
import {
  canonicalLanguageCodeOverride,
  derivedLaneLanguageCode,
  hasLaneCodeOverride,
  laneDisplayName,
  laneLanguage,
  laneLanguageCode,
} from "./lane-display"
import { BLANK_LANE_PLACEHOLDER, SOURCE_LANE_PLACEHOLDER } from "./backfill-plan"

describe("laneLanguage", () => {
  it("is the language the user typed", () => {
    expect(laneLanguage({ language: "Yooper English", name: null })).toBe("Yooper English")
  })

  it("falls back to the stored name on a row that predates migration 0129", () => {
    // Until the AQU-1616 backfill runs, a legacy row carries its label in
    // `name` with `language` NULL. Reading it must still answer "Spanish".
    expect(laneLanguage({ language: null, name: "Spanish" })).toBe("Spanish")
  })

  it("prefers the language over a display name that disagrees with it", () => {
    expect(laneLanguage({ language: "Spanish", name: "Draft Spanish" })).toBe("Spanish")
  })

  it("is empty for a lane that carries neither", () => {
    expect(laneLanguage({ language: "", name: null })).toBe("")
  })
})

describe("laneDisplayName", () => {
  it("is the name when the user set one", () => {
    expect(laneDisplayName({ language: "Spanish", name: "Draft Spanish" })).toBe("Draft Spanish")
  })

  it("is the language when no name was set", () => {
    expect(laneDisplayName({ language: "Spanish", name: null })).toBe("Spanish")
  })

  it("follows the language when the language is edited and there is no name", () => {
    // The acceptance criterion: changing the language changes the display.
    const before = { role: "target" as const, language: "Spanish", name: null }
    const after = { ...before, language: "Castilian Spanish" }
    expect(laneDisplayName(before)).toBe("Spanish")
    expect(laneDisplayName(after)).toBe("Castilian Spanish")
  })

  it("keeps a name the user chose when the language is edited", () => {
    const after = { role: "target" as const, language: "Castilian Spanish", name: "Draft" }
    expect(laneDisplayName(after)).toBe("Draft")
  })

  it("derives the placeholder rather than reading a stored one", () => {
    expect(laneDisplayName({ role: "source", language: "", name: null })).toBe(
      SOURCE_LANE_PLACEHOLDER,
    )
    expect(laneDisplayName({ role: "target", language: "", name: null })).toBe(
      BLANK_LANE_PLACEHOLDER,
    )
    expect(laneDisplayName({ language: null, name: null })).toBe(BLANK_LANE_PLACEHOLDER)
  })

  it("ignores whitespace-only stored values", () => {
    expect(laneDisplayName({ role: "target", language: "Spanish", name: "   " })).toBe("Spanish")
  })
})

describe("laneLanguageCode", () => {
  it("derives the code from the language when there is no override", () => {
    expect(laneLanguageCode({ language: "Spanish", name: null, langCode: null })).toBe("es")
  })

  it("follows the language when the language is edited", () => {
    // The code is not stored, so it cannot drift away from the label.
    expect(laneLanguageCode({ language: "Spanish", name: null, langCode: null })).toBe("es")
    expect(laneLanguageCode({ language: "French", name: null, langCode: null })).toBe("fr")
  })

  it("is null for a freeform language no catalog entry matches", () => {
    expect(laneLanguageCode({ language: "Grade 7 English", name: null, langCode: null })).toBeNull()
    expect(laneLanguageCode({ language: "Potato", name: null, langCode: null })).toBeNull()
  })

  it("prefers an override over the derived code", () => {
    expect(laneLanguageCode({ language: "Spanish", name: null, langCode: "es-MX" })).toBe("es-MX")
  })

  it("keeps the override when the language is edited", () => {
    // The acceptance criterion: an override survives language edits.
    const lane = { language: "Spanish", name: null, langCode: "es-419" }
    expect(laneLanguageCode({ ...lane, language: "Latin American Spanish" })).toBe("es-419")
  })

  it("canonicalizes a stored override's case", () => {
    expect(laneLanguageCode({ language: "Spanish", name: null, langCode: "ES-mx" })).toBe("es-MX")
  })

  it("reports a malformed stored override as stored rather than throwing", () => {
    // A reader says what the row holds; refusing bad input is the write path's
    // job. Throwing here would take out the whole languages screen.
    expect(laneLanguageCode({ language: "Spanish", name: null, langCode: "!!" })).toBe("!!")
  })

  it("derives from the stored name on a row that predates migration 0129", () => {
    expect(laneLanguageCode({ language: null, name: "French", langCode: null })).toBe("fr")
  })
})

describe("derivedLaneLanguageCode / hasLaneCodeOverride", () => {
  it("reports the derived code for the Advanced placeholder, ignoring the override", () => {
    expect(derivedLaneLanguageCode({ language: "Spanish", langCode: "es-MX" })).toBe("es")
  })

  it("distinguishes an explicit override from a derived code", () => {
    expect(hasLaneCodeOverride({ language: "Spanish", langCode: "es-MX" })).toBe(true)
    expect(hasLaneCodeOverride({ language: "Spanish", langCode: null })).toBe(false)
    expect(hasLaneCodeOverride({ language: "Spanish", langCode: "  " })).toBe(false)
  })
})

describe("canonicalLanguageCodeOverride", () => {
  it("treats blank as no override", () => {
    expect(canonicalLanguageCodeOverride("")).toEqual({ ok: true, code: null })
    expect(canonicalLanguageCodeOverride("   ")).toEqual({ ok: true, code: null })
    expect(canonicalLanguageCodeOverride(null)).toEqual({ ok: true, code: null })
    expect(canonicalLanguageCodeOverride(undefined)).toEqual({ ok: true, code: null })
  })

  it("canonicalizes a well-formed tag so two spellings cannot disagree", () => {
    expect(canonicalLanguageCodeOverride("es")).toEqual({ ok: true, code: "es" })
    expect(canonicalLanguageCodeOverride("es-mx")).toEqual({ ok: true, code: "es-MX" })
    expect(canonicalLanguageCodeOverride("ES-MX")).toEqual({ ok: true, code: "es-MX" })
    expect(canonicalLanguageCodeOverride(" zh-hant-tw ")).toEqual({
      ok: true,
      code: "zh-Hant-TW",
    })
  })

  it("refuses a malformed tag", () => {
    for (const bad of ["not a tag!", "e", "english language", "es_MX", "-es", "123456789"]) {
      expect(canonicalLanguageCodeOverride(bad)).toEqual({ ok: false, problem: "malformed" })
    }
  })
})
