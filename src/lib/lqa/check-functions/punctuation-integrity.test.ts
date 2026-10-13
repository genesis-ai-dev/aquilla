import { describe, it, expect } from "vitest"
import { runCheck } from "./punctuation-integrity"
import { resolvePunctuation } from "../../../../db/shared/punctuation-conventions"

/** The context the editor passes for a lane in `language` (AQU-1906). */
const lane = (language: string) => ({ punctuation: resolvePunctuation({ language }).conventions })

describe("punctuation-integrity", () => {
  it("returns null when the colon is preserved", () => {
    expect(runCheck("He said: run.", "Il a dit : cours.")).toBeNull()
  })

  it("returns null when source has no clause punctuation", () => {
    expect(runCheck("He went home.", "Il est rentré.")).toBeNull()
  })

  it("flags a mid-cell colon dropped in the target (the AQU-587 : -> . case)", () => {
    const spans = runCheck("He said: run.", "Il a dit. cours.")
    expect(spans).not.toBeNull()
    expect(spans).toEqual([
      { side: "source", start: 7, end: 8, matchedText: ":" },
    ])
  })

  it("flags a dropped semicolon", () => {
    const spans = runCheck("Wait; then go.", "Attends, puis vas-y.")
    expect(spans).toEqual([
      { side: "source", start: 4, end: 5, matchedText: ";" },
    ])
  })

  it("flags several dropped marks within one cell (colon and semicolon)", () => {
    const spans = runCheck("First: a; b.", "Primero. a, b.")
    expect(spans).toEqual([
      { side: "source", start: 5, end: 6, matchedText: ":" },
      { side: "source", start: 8, end: 9, matchedText: ";" },
    ])
  })

  it("flags every occurrence of a dropped mark, not just the first", () => {
    const spans = runCheck("a: b: c", "a. b. c")
    expect(spans).toEqual([
      { side: "source", start: 1, end: 2, matchedText: ":" },
      { side: "source", start: 4, end: 5, matchedText: ":" },
    ])
  })

  it("treats a full-width target colon as preserved", () => {
    expect(runCheck("He said: run", "彼は言った：走れ")).toBeNull()
  })

  it("treats a full-width source colon as the same mark", () => {
    const spans = runCheck("彼は言った：走れ", "He said. run")
    expect(spans).toEqual([
      { side: "source", start: 5, end: 6, matchedText: "：" },
    ])
  })

  // AQU-1906 — the target lane's own clause marks answer the source's.
  describe("target-language conventions", () => {
    it("treats the Arabic semicolon as the source semicolon preserved", () => {
      expect(runCheck("Wait; then go.", "انتظر؛ ثم اذهب.", lane("ar"))).toBeNull()
    })

    it("treats the Greek ano teleia as the source semicolon preserved", () => {
      expect(runCheck("Wait; then go.", "Περίμενε· μετά πήγαινε.", lane("el"))).toBeNull()
    })

    it("treats the Ethiopic colon and semicolon as preserved", () => {
      expect(runCheck("He said: run", "አለ፦ ሩጥ", lane("am"))).toBeNull()
      expect(runCheck("Wait; then go", "ቆይ፤ ከዚያ ሂድ", lane("am"))).toBeNull()
    })

    it("still flags a dropped mark in a lane whose conventions add nothing for it", () => {
      expect(runCheck("He said: run.", "قال. اركض.", lane("ar"))).toEqual([
        { side: "source", start: 7, end: 8, matchedText: ":" },
      ])
    })

    it("behaves exactly as with no lane when the lane records no language", () => {
      expect(runCheck("He said: run.", "Il a dit. cours.", lane(""))).toEqual(
        runCheck("He said: run.", "Il a dit. cours."),
      )
    })

    it("does not let a target convention excuse the OTHER clause mark", () => {
      // "؛" answers a ";", never a ":".
      expect(runCheck("He said: run", "قال؛ اركض", lane("ar"))).toEqual([
        { side: "source", start: 7, end: 8, matchedText: ":" },
      ])
    })
  })
})
