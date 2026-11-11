import { describe, it, expect } from "vitest"
import { runCheck } from "./number-format"
import { numberFormatForLanguage } from "../../../../db/shared/number-format"
import type { NumberFormatConventions } from "../../../../db/shared/number-format"

// AQU-2430's number-format acceptance criteria:
//   - a number written with the wrong group or decimal separator for the
//     target language is flagged, and the project can override the expected
//     separators (the override itself is resolved in
//     db/shared/number-format.test.ts; here it is just another conventions
//     object, because that is all the check ever sees);
//   - a number written in a digit set the target language does not use is
//     flagged.

const forLanguage = (language: string): NumberFormatConventions => {
  const found = numberFormatForLanguage(language)
  if (!found) throw new Error(`no CLDR data for ${language}`)
  return found.conventions
}

const EN = forLanguage("en")
const DE = forLanguage("de")
const FR = forLanguage("fr")
const HI = forLanguage("hi")
const MY = forLanguage("my")

describe("number-format", () => {
  describe("separators", () => {
    it("flags a comma used as a fraction mark in English", () => {
      const spans = runCheck("", "He walked 3,5 miles.", { numberFormat: EN })
      expect(spans).toHaveLength(1)
      expect(spans?.[0]).toMatchObject({ side: "target", matchedText: "3,5" })
    })

    it("accepts English's own grouping and fraction mark", () => {
      expect(runCheck("", "1,234,567 people and 3.5 miles.", { numberFormat: EN })).toBeNull()
    })

    it("flags English-style grouping in German, and German-style in English", () => {
      expect(runCheck("", "Es waren 1,234.56 Schekel.", { numberFormat: DE })).toHaveLength(1)
      expect(runCheck("", "It was 1.234,56 shekels.", { numberFormat: EN })).toHaveLength(1)
    })

    it("accepts German's own grouping and fraction mark", () => {
      expect(runCheck("", "Es waren 1.234,56 Schekel.", { numberFormat: DE })).toBeNull()
    })

    it("reads an ambiguous separator as the role the language gives it", () => {
      // "1,234" is one thousand two hundred thirty-four in English and one
      // point two three four in French. Classifying by position alone would
      // report the French one as mis-grouped.
      expect(runCheck("", "Il a marché 1,234 km.", { numberFormat: FR })).toBeNull()
      expect(runCheck("", "He walked 1,234 miles.", { numberFormat: EN })).toBeNull()
    })

    it("accepts the Indian lakh grouping where the language uses it", () => {
      expect(runCheck("", "9,87,65,43,210", { numberFormat: HI })).toBeNull()
      // The same number grouped in threes is still correct Hindi.
      expect(runCheck("", "9,876,543,210", { numberFormat: HI })).toBeNull()
      // And the lakh grouping is not English.
      expect(runCheck("", "9,87,65,43,210", { numberFormat: EN })).toHaveLength(1)
    })

    it("says nothing about a plain number, in any language", () => {
      for (const conventions of [EN, DE, FR, HI, MY]) {
        expect(runCheck("", "There were 40 days and -12 degrees.", { numberFormat: conventions })).toBeNull()
      }
    })

    it("flags every offending number in the cell, at its own position", () => {
      const target = "3.5 and 1,234.5 and 3,5"
      const spans = runCheck("", target, { numberFormat: DE })
      expect(spans).toHaveLength(2)
      expect(target.slice(spans![0].start, spans![0].end)).toBe("3.5")
      expect(target.slice(spans![1].start, spans![1].end)).toBe("1,234.5")
    })
  })

  describe("digits", () => {
    it("flags digits from a script the language does not use", () => {
      // Devanagari digits in a Burmese lane.
      const spans = runCheck("", "४० ရက်", { numberFormat: MY })
      expect(spans).toHaveLength(1)
      expect(spans?.[0]).toMatchObject({ matchedText: "४०" })
    })

    it("accepts the language's own digits", () => {
      expect(runCheck("", "၄၀ ရက်", { numberFormat: MY })).toBeNull()
    })

    it("accepts Western digits in every language, because every language writes them", () => {
      // An Arabic or Burmese publication writing "40" is writing a number
      // correctly — the floor that keeps this rule off most real typography.
      expect(runCheck("", "40 ရက်", { numberFormat: MY })).toBeNull()
      expect(runCheck("", "40 días", { numberFormat: forLanguage("es") })).toBeNull()
    })

    it("flags a language's own digits in a language that does not use them", () => {
      expect(runCheck("", "٤٠ days", { numberFormat: EN })).toHaveLength(1)
    })
  })

  describe("what it leaves alone", () => {
    it("says nothing at all without conventions to judge by", () => {
      // A lane with no recorded language and no Language profile answer.
      expect(runCheck("", "He walked 3,5 miles.")).toBeNull()
      expect(runCheck("", "He walked 3,5 miles.", {})).toBeNull()
      expect(runCheck("", "He walked 3,5 miles.", { numberFormat: null })).toBeNull()
    })

    it("leaves a scripture reference's chapter-verse separator to its own check", () => {
      // "Jhn 3.16" is reference-shaped, not a decimal fraction;
      // scripture-reference's rule 3 owns whether a cell separates chapter
      // from verse consistently.
      expect(runCheck("", "Siehe Jhn 3.16 und Rom 1.17.", { numberFormat: DE })).toBeNull()
      // A number next to a reference is still judged.
      const spans = runCheck("", "Jhn 3.16 nennt 3,5 Tage.", { numberFormat: EN })
      expect(spans).toHaveLength(1)
      expect(spans?.[0]).toMatchObject({ matchedText: "3,5" })
    })

    it("judges the target only — the source may be written any way at all", () => {
      expect(runCheck("1,234.5", "1.234,5", { numberFormat: DE })).toBeNull()
    })
  })
})
