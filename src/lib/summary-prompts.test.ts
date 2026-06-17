import { describe, expect, it } from "vitest"
import { bookSummaryPrompt, chapterSummaryPrompt } from "./summary-prompts"

// These prompts are the contract between the summary buttons and the agent: they
// must name the scope, ask for vetted resources + profile tailoring, and carry
// the slide's four-part structure (so the summary matches what the translator
// was shown). If a section heading changes, the user-visible output changes.

describe("bookSummaryPrompt", () => {
  it("names the book and requests vetted resources + profile tailoring", () => {
    const p = bookSummaryPrompt("Ruth")
    expect(p).toContain("book of Ruth")
    expect(p).toContain("vetted Bible reference resources")
    expect(p).toContain("translator profile")
  })

  it("carries the four-part structure", () => {
    const p = bookSummaryPrompt("Ruth")
    expect(p).toContain("Key Meaning")
    expect(p).toContain("Important Insights")
    expect(p).toContain("Application")
    expect(p).toContain("Translation Notes")
  })
})

describe("chapterSummaryPrompt", () => {
  it("names the chapter reference and keeps the structure", () => {
    const p = chapterSummaryPrompt("GEN 1")
    expect(p).toContain("Summarize GEN 1")
    expect(p).toContain("Key Meaning")
    expect(p).toContain("Translation Notes")
  })
})
