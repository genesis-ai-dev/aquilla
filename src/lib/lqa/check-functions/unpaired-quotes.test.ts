import { describe, it, expect } from "vitest"
import { hasQuotationMarks, runCheck } from "./unpaired-quotes"

describe("unpaired-quotes", () => {
  it("flags a quotation the translator opened and never closed", () => {
    const spans = runCheck('He said, "Come."', "Il dit : « Viens.")
    expect(spans).toEqual([{ side: "target", start: 9, end: 10, matchedText: "«" }])
  })

  it("accepts every double-quote convention, since each uses two marks", () => {
    expect(runCheck('"Come."', "„Komm.“")).toBeNull() // German
    expect(runCheck('"Come."', "”Kom.”")).toBeNull() // Swedish
    expect(runCheck('"Come."', "»Kom.«")).toBeNull() // Danish
    expect(runCheck('"Come."', "« Viens. »")).toBeNull() // French
  })

  it("stays quiet when the source leaves the quotation open too (it continues in the next verse)", () => {
    expect(runCheck('Jesus answered, "Truly I tell you,', "Jésus répondit : « En vérité je vous le dis,")).toBeNull()
  })

  it("flags a quotation the translator closed but the source keeps open", () => {
    expect(runCheck('"Truly I tell you,', "« En vérité » je vous le dis,")).toBeNull()
    expect(runCheck('"Truly I tell you,"', "« En vérité je vous le dis,")).not.toBeNull()
  })

  it("says whether a text marks quotations at all", () => {
    // What the file pass asks of a source before treating an open quotation as
    // pending: a source with no marks is silent about where it ends.
    expect(hasQuotationMarks("Jesus answered them, Truly I tell you,")).toBe(false)
    expect(hasQuotationMarks("Don’t be afraid")).toBe(false) // an apostrophe is not a quotation mark
    expect(hasQuotationMarks('He said, "Come."')).toBe(true)
    expect(hasQuotationMarks("Il dit : « Viens.")).toBe(true)
    expect(hasQuotationMarks("「来。」")).toBe(true)
  })

  it("pairs CJK corner brackets by direction", () => {
    expect(runCheck('"Come."', "「来。」")).toBeNull()
    expect(runCheck('"Come."', "「来。")).toEqual([{ side: "target", start: 0, end: 1, matchedText: "「" }])
  })
})
