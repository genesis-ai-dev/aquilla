import { describe, it, expect } from "vitest"
import { runCheck } from "./punctuation-integrity"

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
})
