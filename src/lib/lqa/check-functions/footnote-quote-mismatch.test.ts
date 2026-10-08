import { describe, it, expect } from "vitest"
import { runCheck } from "./footnote-quote-mismatch"

const SOURCE = "Blessed are you when they persecute you for my sake."

describe("footnote-quote-mismatch", () => {
  it("returns null when the \\fq quote is in the verse text", () => {
    const target =
      "Blessed are you when they persecute you \\f + \\fr 5:11 \\fq persecute you \\ft Or: harass.\\f* for my sake."
    expect(runCheck(SOURCE, target)).toBeNull()
  })

  it("flags a \\fq quote after the quoted word is edited out of the verse", () => {
    const target =
      "Blessed are you when they harass you \\f + \\fr 5:11 \\fq persecute you \\ft Or: harass.\\f* for my sake."
    const spans = runCheck(SOURCE, target)
    expect(spans).not.toBeNull()
    expect(spans).toHaveLength(1)
    expect(spans![0].side).toBe("target")
    expect(spans![0].matchedText).toBe("persecute you")
    expect(target.slice(spans![0].start, spans![0].end)).toBe("persecute you")
  })

  it("flags a \\fk keyword missing from the verse", () => {
    const target = "They came to the city \\f + \\fr 1:1 \\fk Antioch \\ft A Syrian city.\\f*"
    expect(runCheck(SOURCE, target)).not.toBeNull()
  })

  it("flags \\xq and \\xk on a cross-reference", () => {
    const quoted = "He trusted in God \\x - \\xo 27:43 \\xq let him deliver him \\xt Ps 22:8\\x*"
    expect(runCheck(SOURCE, quoted)).not.toBeNull()
    const clean = "let him deliver him now \\x - \\xo 27:43 \\xq let him deliver him \\xt Ps 22:8\\x*"
    expect(runCheck(SOURCE, clean)).toBeNull()
  })

  it("ignores \\fqa and \\xta — an alternative rendering is meant to differ", () => {
    const target =
      "Once, while eating with them \\f + \\fr 1:4 \\ft Or: \\fqa Once, having gathered them\\f* he commanded them."
    expect(runCheck(SOURCE, target)).toBeNull()
    const xref = "He trusted \\x - \\xo 27:43 \\xt Ps 22:8 \\xta a different rendering\\x*"
    expect(runCheck(SOURCE, xref)).toBeNull()
  })

  it("ignores the \\ft note body, which is prose about the verse", () => {
    const target =
      "Blessed are you \\f + \\fr 5:11 \\ft Some manuscripts add words not present in this verse.\\f*"
    expect(runCheck(SOURCE, target)).toBeNull()
  })

  it("tolerates case, punctuation, whitespace and inline markers", () => {
    const target =
      "Blessed  are you, O people! \\f + \\fr 5:11 \\fq “blessed are \\bd you\\bd*” \\ft Or: happy.\\f*"
    expect(runCheck(SOURCE, target)).toBeNull()
  })

  it("accepts an elided quote when each piece occurs in order", () => {
    const inOrder = "Blessed are you when they persecute you for my sake \\f + \\fr 5:11 \\fq Blessed … for my sake\\f*"
    expect(runCheck(SOURCE, inOrder)).toBeNull()
    const outOfOrder = "Blessed are you when they persecute you for my sake \\f + \\fr 5:11 \\fq for my sake … Blessed\\f*"
    expect(runCheck(SOURCE, outOfOrder)).not.toBeNull()
  })

  it("flags every mismatching quote, including a second note in the same cell", () => {
    const target =
      "A short verse \\f + \\fr 1:1 \\fq missing one\\f* \\f + \\fr 1:2 \\fq missing two\\f*"
    const spans = runCheck(SOURCE, target)
    expect(spans?.map((s) => s.matchedText)).toEqual(["missing one", "missing two"])
  })

  it("returns null for a cell that is nothing but notes — no verse to check against", () => {
    const target = "\\f + \\fr 1:1 \\fq nothing to compare \\ft Study note.\\f*"
    expect(runCheck(SOURCE, target)).toBeNull()
  })

  it("returns null for ordinary text with no notes", () => {
    expect(runCheck(SOURCE, "Bienheureux êtes-vous")).toBeNull()
    expect(runCheck(SOURCE, "")).toBeNull()
  })

  it("never reads the source — the quote belongs to the target verse", () => {
    const target = "Benditos sois \\f + \\fr 5:11 \\fq persecute you\\f*"
    // The quote IS in the English source, and is still a finding in Spanish.
    expect(runCheck(SOURCE, target)).not.toBeNull()
  })
})
