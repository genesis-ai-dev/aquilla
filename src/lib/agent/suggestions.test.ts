// splitNextSteps — trailing NEXT: lines become tappable suggestions; the
// displayed prose must never show the marker, even mid-stream. Why it matters:
// the buttons are the "what do I do now?" affordance (2026-08-31 review) — a
// marker leaking into prose or a suggestion silently dropped both break it.

import { describe, expect, it } from "vitest"
import { splitNextSteps } from "./suggestions"

describe("splitNextSteps", () => {
  it("returns prose untouched when there are no NEXT lines", () => {
    const text = "The file is fully drafted.\n\nNothing else stands out."
    expect(splitNextSteps(text)).toEqual({ body: text, suggestions: [] })
  })

  it("extracts one or two trailing NEXT lines in reading order", () => {
    const { body, suggestions } = splitNextSteps(
      "I checked ECC — 14 cells are untranslated.\n\nNEXT: Draft the next 5 untranslated cells in ECC\nNEXT: Check my recent edits in GEN 1",
    )
    expect(body).toBe("I checked ECC — 14 cells are untranslated.")
    expect(suggestions).toEqual([
      "Draft the next 5 untranslated cells in ECC",
      "Check my recent edits in GEN 1",
    ])
  })

  it("does not treat a NEXT: mid-prose as a suggestion", () => {
    const text = "NEXT: steps are described above.\n\nAll done."
    expect(splitNextSteps(text)).toEqual({ body: text, suggestions: [] })
  })

  it("strips a partially streamed marker from the displayed prose", () => {
    // "NEXT: Dra" (still streaming) — body must not show it; the truncated
    // suggestion is harmless because buttons render only on terminal runs.
    expect(splitNextSteps("Drafts are staged.\nNEXT: Dra").body).toBe("Drafts are staged.")
    // A bare prefix of the marker itself is stripped and never suggested.
    const partial = splitNextSteps("Drafts are staged.\nNEX")
    expect(partial.body).toBe("Drafts are staged.")
    expect(partial.suggestions).toEqual([])
    // A bare "NEXT:" with no text yet is stripped, not suggested.
    expect(splitNextSteps("Drafts are staged.\nNEXT:")).toEqual({
      body: "Drafts are staged.",
      suggestions: [],
    })
  })

  it("ignores blank lines between and after the NEXT block", () => {
    const { body, suggestions } = splitNextSteps("Done.\n\nNEXT: Review the drafts\n\n")
    expect(body).toBe("Done.")
    expect(suggestions).toEqual(["Review the drafts"])
  })
})
