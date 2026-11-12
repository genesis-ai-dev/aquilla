// AQU-1688 — "Use defaults for <language>" and the card's form state.
//
// WHY: level 1 must match what the editor's smart quotes type for the same
// language, or a project that accepts the defaults gets a finding in every
// quoted verse. Deeper levels follow each language's own convention, and a
// draft that cannot be stored must never be saved half-valid.

import { describe, it, expect } from "vitest"
import { doubleQuoteMarks } from "@/lib/richtext/smart-quotes"
import { defaultQuoteMarks } from "./quote-mark-defaults"
import { draftFromQuoteMarks, quoteMarksFromDraft } from "./quote-marks-draft"

describe("defaultQuoteMarks", () => {
  it.each(["en", "fr", "es", "pt", "de", "ru", "id", "ar", "zh", "Italian", "pl"])(
    "level 1 for %s is what smart quotes type",
    (language) => {
      const { open, close } = doubleQuoteMarks(language)
      expect(defaultQuoteMarks(language)?.levels[0]).toEqual({ open, close })
    },
  )

  it("gives each listed language its own deeper levels and paragraph convention", () => {
    expect(defaultQuoteMarks("en")).toEqual({
      levels: [{ open: "“", close: "”" }, { open: "‘", close: "’" }, { open: "“", close: "”" }],
      continuation: "reopen-each-paragraph",
    })
    expect(defaultQuoteMarks("es")).toEqual({
      levels: [{ open: "«", close: "»" }, { open: "“", close: "”" }, { open: "‘", close: "’" }],
      continuation: "continuation-mark",
    })
    expect(defaultQuoteMarks("de")?.levels).toEqual([{ open: "„", close: "“" }, { open: "‚", close: "‘" }])
    expect(defaultQuoteMarks("ru")?.levels).toEqual([{ open: "«", close: "»" }, { open: "„", close: "“" }])
  })

  it("reads language names and region tags the way the rest of the app does", () => {
    expect(defaultQuoteMarks("French")).toEqual(defaultQuoteMarks("fr"))
    expect(defaultQuoteMarks("pt-BR")).toEqual(defaultQuoteMarks("pt"))
    expect(defaultQuoteMarks("cmn")).toEqual(defaultQuoteMarks("zh"))
  })

  it("offers level 1 alone for a language only the smart-quotes table knows", () => {
    expect(defaultQuoteMarks("pl")?.levels).toEqual([{ open: "„", close: "”" }])
  })

  it("offers nothing rather than guess for a language neither table knows", () => {
    expect(defaultQuoteMarks("tpi")).toBeNull()
    expect(defaultQuoteMarks("")).toBeNull()
  })
})

describe("the card's draft", () => {
  it("round-trips a stored slot through the three-row form", () => {
    const stored = defaultQuoteMarks("de")!
    expect(quoteMarksFromDraft(draftFromQuoteMarks(stored))).toEqual(stored)
  })

  it("trims marks and drops empty deeper rows", () => {
    const draft = draftFromQuoteMarks(null)
    draft.levels[0] = { open: " « ", close: "»" }
    expect(quoteMarksFromDraft(draft)).toEqual({ levels: [{ open: "«", close: "»" }], continuation: "reopen-each-paragraph" })
  })

  it("refuses a row with one mark, a third level without a second, or a mark that is not one character", () => {
    const half = draftFromQuoteMarks(null)
    half.levels[0] = { open: "“", close: "" }
    expect(quoteMarksFromDraft(half)).toBeNull()
    const gap = draftFromQuoteMarks(defaultQuoteMarks("en"))
    gap.levels[1] = { open: "", close: "" }
    expect(quoteMarksFromDraft(gap)).toBeNull()
    const long = draftFromQuoteMarks(null)
    long.levels[0] = { open: "<<", close: ">>" }
    expect(quoteMarksFromDraft(long)).toBeNull()
    expect(quoteMarksFromDraft(draftFromQuoteMarks(null))).toBeNull()
  })
})
