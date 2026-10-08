import { describe, it, expect } from "vitest"
import { runCheck } from "./number-integrity-extra"
import { runCheck as runSourceDirection } from "./number-integrity"

// AQU-1761: numbers the translation has and the source doesn't.
describe("number-integrity-extra", () => {
  it("returns null when every translation number is in the source", () => {
    expect(runCheck("He fasted 40 days.", "Il jeûna 40 jours.")).toBeNull()
  })

  it("returns null when the translation has no numbers", () => {
    expect(runCheck("He fasted 40 days.", "Il jeûna quarante jours.")).toBeNull()
  })

  it("flags a number the translation added, underlined in the translation", () => {
    expect(runCheck("He fasted forty days.", "Il jeûna 40 jours.")).toEqual([
      { side: "target", start: 9, end: 11, matchedText: "40" },
    ])
  })

  it("with no numbers in the source, every translation number is extra", () => {
    expect(runCheck("In the beginning.", "Au commencement (1:1), 3 fois.")).toEqual([
      { side: "target", start: 17, end: 18, matchedText: "1" },
      { side: "target", start: 19, end: 20, matchedText: "1" },
      { side: "target", start: 23, end: 24, matchedText: "3" },
    ])
  })

  it("counts occurrences: one 40 in the source covers one 40 in the translation", () => {
    expect(runCheck("40 days", "40 jours et 40 nuits")).toEqual([
      { side: "target", start: 12, end: 14, matchedText: "40" },
    ])
    expect(runCheck("40 days and 40 nights", "40 jours et 40 nuits")).toBeNull()
  })

  it("reads every script's digits by value, on both sides", () => {
    expect(runCheck("40 days", "၄၀ ရက်")).toBeNull() // Burmese
    expect(runCheck("40 days", "๔๐ วัน")).toBeNull() // Thai
    expect(runCheck("٤٠ يوما", "40 days")).toBeNull() // Arabic-Indic source
    expect(runCheck("40 days", "४१ दिन")).toEqual([
      { side: "target", start: 0, end: 2, matchedText: "४१" },
    ])
  })

  it("keeps the translation's own spans for digits outside the BMP (Adlam)", () => {
    expect(runCheck("days", "𞥔𞥐 x")).toEqual([
      { side: "target", start: 0, end: 4, matchedText: "𞥔𞥐" },
    ])
  })

  it("treats separators and signs the way Number integrity does", () => {
    expect(runCheck("1,000 people", "1.000 personnes")).toBeNull()
    expect(runCheck("2.5 cubits", "٢٫٥ ذراع")).toBeNull()
    expect(runCheck("-5 degrees", "-5 degrés")).toBeNull()
    expect(runCheck("5 degrees", "-5 degrés")).toEqual([
      { side: "target", start: 0, end: 2, matchedText: "-5" },
    ])
  })

  it("treats ranges the way Number integrity does", () => {
    expect(runCheck("verses 3-5", "versets 3-5")).toBeNull()
    expect(runCheck("verses 3-5", "versets 3-6")).not.toBeNull()
  })

  it("is the mirror of the source direction on a changed number", () => {
    // 40 written as 41: the source direction flags the 40, this one the 41.
    expect(runSourceDirection("40 days", "41 jours")?.[0]).toMatchObject({ side: "source", matchedText: "40" })
    expect(runCheck("40 days", "41 jours")?.[0]).toMatchObject({ side: "target", matchedText: "41" })
  })
})
