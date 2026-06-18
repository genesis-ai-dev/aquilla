import { describe, it, expect } from "vitest"
import { runCheck } from "./usfm-marker-integrity"
import { usfmSpanToHtml } from "@/lib/parsers/usfm-html"

describe("usfm-marker-integrity", () => {
  it("returns null when there is no inline markup in the source", () => {
    expect(runCheck("plain source", "plain target")).toBeNull()
  })

  it("derives source HTML from the raw span when no ctx is given (rule fallback)", () => {
    // The rule engine passes cell.originalHtml as ctx.sourceHtml; for USFM that
    // is undefined, so the check must derive structure from the raw source span.
    const spans = runCheck("the \\nd LORD\\nd* said", "the LORD said")
    expect(spans).not.toBeNull()
    expect(spans!.map((s) => s.matchedText)).toEqual(["\\nd"])
  })

  it("flags formatting dropped by the translation", () => {
    const source = "the \\nd LORD\\nd* said"
    const spans = runCheck(source, "the LORD said", {
      sourceHtml: usfmSpanToHtml(source),
      targetHtml: "the LORD said",
    })
    expect(spans).not.toBeNull()
    expect(spans!).toHaveLength(1)
    expect(spans![0].side).toBe("source")
    expect(spans![0].matchedText).toBe("\\nd")
    // Span points at the \nd marker in the raw source.
    expect(source.slice(spans![0].start, spans![0].end)).toBe("\\nd")
  })

  it("flags a dropped footnote", () => {
    const source = "In the beginning\\f + \\ft note\\f*"
    const spans = runCheck(source, "Au commencement", {
      sourceHtml: usfmSpanToHtml(source),
      targetHtml: "Au commencement",
    })
    expect(spans).not.toBeNull()
    expect(spans!.some((s) => s.matchedText === "\\f")).toBe(true)
  })

  it("passes when the translation preserved the markup (via data-usfm)", () => {
    const source = "the \\nd LORD\\nd*"
    const spans = runCheck(source, "le SEIGNEUR", {
      sourceHtml: usfmSpanToHtml(source),
      targetHtml: '<span data-usfm="nd">SEIGNEUR</span>',
    })
    expect(spans).toBeNull()
  })

  it("does not flag the inner markers of a preserved footnote", () => {
    // \fr/\ft live inside the note; only the note container (\f) is the unit.
    const source = "x\\f + \\fr 1:1 \\ft note\\f*"
    const spans = runCheck(source, "y", {
      sourceHtml: usfmSpanToHtml(source),
      targetHtml: "y",
    })
    expect(spans!.map((s) => s.matchedText)).toEqual(["\\f"])
  })
})
