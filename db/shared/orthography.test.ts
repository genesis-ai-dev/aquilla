import { describe, expect, it } from "vitest"
import {
  CANONICAL_APOSTROPHE,
  LEGACY_APOSTROPHE,
  approvedExceptions,
  convertOrthography,
  convertOrthographyText,
  findOldOrthography,
  hasOrthography,
  orthographyProblem,
  type OrthographyProfile,
} from "./orthography"
import {
  GEN1_NEW_SPELLING,
  GEN1_OLD_SPELLING,
  UZBEK_2026_RULES,
  UZBEK_2026_SEED_EXCEPTIONS,
} from "./orthography.fixture"

/** The old forms the ticket counted: the two digraphs and the two apostrophe pairs. */
const OLD_FORM = /(sh|ch|o['ʻʼ‘’`´′]|g['ʻʼ‘’`´′])/gi
/** The letters the 2026 alphabet added. */
const NEW_LETTER = /[şçöğŞÇÖĞ]/g

const uzbek: OrthographyProfile = {
  rules: UZBEK_2026_RULES.map((rule) => [rule[0], rule[1]] as [string, string]),
  apostrophe: CANONICAL_APOSTROPHE,
  exceptions: UZBEK_2026_SEED_EXCEPTIONS.map((word) => ({ word, status: "approved" as const })),
}

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length
}

describe("convertOrthography — the Genesis 1 run", () => {
  it("takes the 31 drafted verses from 175 old forms to none", () => {
    const before = GEN1_OLD_SPELLING.reduce((sum, verse) => sum + count(verse.text, OLD_FORM), 0)
    expect(before).toBe(175)

    const converted = GEN1_OLD_SPELLING.map((verse) => convertOrthographyText(verse.text, uzbek))
    expect(converted.reduce((sum, text) => sum + count(text, OLD_FORM), 0)).toBe(0)
    expect(converted.reduce((sum, text) => sum + count(text, NEW_LETTER), 0)).toBe(175)
  })

  it("produces the expected text verse for verse", () => {
    for (const [index, verse] of GEN1_OLD_SPELLING.entries()) {
      expect(convertOrthographyText(verse.text, uzbek), verse.ref).toBe(GEN1_NEW_SPELLING[index].text)
    }
  })

  it("round-trips through the legacy export back to the original", () => {
    for (const [index, verse] of GEN1_OLD_SPELLING.entries()) {
      const back = convertOrthographyText(GEN1_NEW_SPELLING[index].text, uzbek, "legacy")
      // The original is compared after apostrophe normalisation: the model
      // typed U+2018, and a legacy export writes the 1995 alphabet's U+02BB.
      const normalized = verse.text.replace(/['ʻʼ‘’`´′]/g, LEGACY_APOSTROPHE)
      expect(back, verse.ref).toBe(normalized)
    }
  })

  it("leaves already-converted text alone", () => {
    for (const verse of GEN1_NEW_SPELLING) {
      expect(convertOrthographyText(verse.text, uzbek), verse.ref).toBe(verse.text)
    }
  })
})

describe("convertOrthography — apostrophes", () => {
  it("reads every apostrophe variant after o and g as the ö/ğ rule", () => {
    for (const mark of ["'", "ʻ", "ʼ", "‘", "’", "`", "´", "′"]) {
      expect(convertOrthographyText(`bo${mark}sh va g${mark}alati`, uzbek)).toBe("böş va ğalati")
    }
  })

  it("normalises an apostrophe anywhere else to the canonical mark", () => {
    expect(convertOrthographyText("ma'no ’ kitob", uzbek)).toBe(
      `ma${CANONICAL_APOSTROPHE}no ${CANONICAL_APOSTROPHE} kitob`,
    )
  })
})

describe("convertOrthography — capitalisation", () => {
  it("derives Sh and SH from the lowercase rule", () => {
    expect(convertOrthographyText("shahar Shahar SHAHAR", uzbek)).toBe("şahar Şahar ŞAHAR")
    expect(convertOrthographyText("chiroq Chiroq CHIROQ", uzbek)).toBe("çiroq Çiroq ÇIROQ")
    expect(convertOrthographyText("oʻz Oʻz", uzbek)).toBe("öz Öz")
  })

  it("matches the longest rule first", () => {
    const profile: OrthographyProfile = {
      rules: [
        ["s", "x"],
        ["sh", "ş"],
      ],
      apostrophe: CANONICAL_APOSTROPHE,
    }
    expect(convertOrthographyText("shahar", profile)).toBe("şahar")
  })
})

describe("convertOrthography — exceptions", () => {
  it("keeps s and h apart, with the writer's capitals and any suffix", () => {
    expect(convertOrthographyText("Ishoq", uzbek)).toBe("Isʼhoq")
    expect(convertOrthographyText("ISHOQ", uzbek)).toBe("ISʼHOQ")
    expect(convertOrthographyText("Is'hoq", uzbek)).toBe("Isʼhoq")
    expect(convertOrthographyText("Ishoqning", uzbek)).toBe("Isʼhoqning")
  })

  it("converts the suffix after the exception by the rules", () => {
    expect(convertOrthographyText("Ishoqcha", uzbek)).toBe("Isʼhoqça")
  })

  it("ignores a pending exception until it is approved", () => {
    const pending: OrthographyProfile = {
      ...uzbek,
      exceptions: [{ word: "Isʼhoq", status: "pending" }],
    }
    expect(convertOrthographyText("Ishoq", pending)).toBe("Işoq")
    expect(approvedExceptions(pending)).toEqual([])
  })

  it("counts what it did, for the import preview", () => {
    const result = convertOrthography("shahar Ishoqning kitob", uzbek)
    expect(result).toEqual({ text: "şahar Isʼhoqning kitob", wordsConverted: 1, exceptionsApplied: 1 })
  })
})

describe("convertOrthography — what it must not touch", () => {
  it("leaves USFM markers, numbers and references alone", () => {
    const cell = "\\v 1 \\f + \\fr 1:1 \\ft Boshida \\f* shahar 1,234 GEN 1:31"
    expect(convertOrthographyText(cell, uzbek)).toBe(
      "\\v 1 \\f + \\fr 1:1 \\ft Boşida \\f* şahar 1,234 GEN 1:31",
    )
  })

  it("leaves HTML tags and entities alone", () => {
    expect(convertOrthographyText('<span class="shade">shahar</span>&nbsp;', uzbek)).toBe(
      '<span class="shade">şahar</span>&nbsp;',
    )
  })

  it("is a no-op for a lane with no orthography block", () => {
    for (const profile of [null, undefined, { rules: [], apostrophe: CANONICAL_APOSTROPHE }]) {
      expect(hasOrthography(profile)).toBe(false)
      expect(convertOrthography("bo‘sh shahar", profile)).toEqual({
        text: "bo‘sh shahar",
        wordsConverted: 0,
        exceptionsApplied: 0,
      })
      expect(findOldOrthography("bo‘sh shahar", profile)).toEqual([])
    }
  })
})

describe("findOldOrthography", () => {
  it("reports the word and what it should be", () => {
    expect(findOldOrthography("Men shahar va chiroq", uzbek)).toEqual([
      { start: 4, end: 10, text: "shahar", suggestion: "şahar" },
      { start: 14, end: 20, text: "chiroq", suggestion: "çiroq" },
    ])
  })

  it("never flags an approved exception", () => {
    expect(findOldOrthography("Ishoqning kitobi", uzbek)).toEqual([])
  })

  it("flags a word a pending exception only proposes", () => {
    const pending: OrthographyProfile = { ...uzbek, exceptions: [{ word: "Ashob", status: "pending" }] }
    expect(findOldOrthography("Ashob", pending).map((f) => f.text)).toEqual(["Ashob"])
  })

  it("says nothing about an apostrophe variant on its own", () => {
    expect(findOldOrthography("ma'no", uzbek)).toEqual([])
  })

  it("says nothing about text already in the new orthography", () => {
    for (const verse of GEN1_NEW_SPELLING) {
      expect(findOldOrthography(verse.text, uzbek), verse.ref).toEqual([])
    }
  })
})

describe("orthographyProblem", () => {
  it("accepts the Uzbek profile", () => {
    expect(orthographyProblem(uzbek)).toBeNull()
  })

  it.each([
    [{}, "orthography.rules must list 1 to 64 rules"],
    [{ rules: [["sh", "ş"]], apostrophe: "ab" }, "orthography.apostrophe must be one character"],
    [{ rules: [["Sh", "Ş"]], apostrophe: "ʼ" }, "orthography.rules[0][0] must be lowercase — the converter derives the capitalised forms"],
    [{ rules: [["sh"]], apostrophe: "ʼ" }, "orthography.rules[0] must be a [from, to] pair"],
    [{ rules: [["sh", "ş"]], apostrophe: "ʼ", nope: 1 }, 'orthography has an unknown field "nope"'],
    [
      { rules: [["sh", "ş"]], apostrophe: "ʼ", exceptions: [{ word: "Ishoq", status: "maybe" }] },
      "orthography.exceptions[0].status must be one of approved, pending",
    ],
  ])("rejects %o", (value, message) => {
    expect(orthographyProblem(value)).toBe(message)
  })
})
