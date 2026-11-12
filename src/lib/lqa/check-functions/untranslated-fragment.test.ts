import { describe, it, expect } from "vitest"
import { runCheck } from "./untranslated-fragment"

describe("untranslated-fragment", () => {
  it("flags a source word left in the source's script inside a different-script translation", () => {
    const spans = runCheck("Then Jesus wept.", "तब Jesus फूट फूटकर रोया।")
    expect(spans).toEqual([{ side: "target", start: 3, end: 8, matchedText: "Jesus" }])
  })

  it("flags a Greek word left in an English translation of a Greek source", () => {
    expect(runCheck("ἐν ἀρχῇ ἦν ὁ λόγος", "In the beginning was the λόγος")!.map((s) => s.matchedText)).toEqual(["λόγος"])
  })

  it("does not flag foreign-script words that aren't in the source (translator's own gloss)", () => {
    expect(runCheck("Jesus wept.", "यीशु (Yeshu) रोया।")).toBeNull()
  })

  it("does not judge same-script pairs, where a shared word may be a name or cognate", () => {
    expect(runCheck("Jesus wept in Bethany.", "Jésus pleura à Bethany.")).toBeNull()
  })

  it("leaves abbreviations and very short words to other checks", () => {
    expect(runCheck("The USA is big.", "USA बड़ा है।")).toBeNull()
    expect(runCheck("Go to it.", "it जाओ।")).toBeNull()
  })

  it("is quiet for a cell written in one script", () => {
    expect(runCheck("Jesus wept.", "यीशु रोया।")).toBeNull()
  })
})
