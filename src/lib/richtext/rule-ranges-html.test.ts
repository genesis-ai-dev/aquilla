/**
 * AQU-1757 — rule underlines on a FORMATTED source cell.
 *
 * The checks report findings as offsets into the cell's plain source text.
 * A cell that carries markup (any hand edit, any formatted import) renders
 * through `SanitizedRichHtml`, which drew none of them. These pin how the
 * offsets are placed on the markup's own text, and that anything that can't
 * be placed exactly is left undrawn rather than drawn on the wrong characters.
 */

import { describe, expect, it } from "vitest"
import type { Concept } from "@/lib/terminology/types"
import type { RangeHighlight } from "./rule-ranges"
import { alignPlainToText, decorateRuleRangesInHtml, mapRangesToText } from "./rule-ranges-html"
import { decorateTermsInHtml } from "./terminology-html"

function major(start: number, end: number, ruleId = "builtin:number-integrity"): RangeHighlight {
  return { start, end, ruleId, kind: "violation-major" }
}

function parse(html: string): HTMLElement {
  const host = document.createElement("div")
  host.innerHTML = html
  return host
}

/** The underlined runs, as [ruleId, text] in document order. */
function underlined(html: string): Array<[string, string]> {
  return [...parse(html).querySelectorAll<HTMLElement>("[data-rule-range]")]
    .filter((el) => !el.querySelector("[data-rule-range]"))
    .map((el) => [el.getAttribute("data-rule-id") ?? "", el.textContent ?? ""])
}

describe("alignPlainToText", () => {
  it("maps identical text one-to-one", () => {
    expect([...alignPlainToText("abc", "abc")]).toEqual([0, 1, 2])
  })

  it("tolerates whitespace differences: NBSP, and a block newline the plain text lacks", () => {
    expect([...alignPlainToText("a b", "a\u00a0b")]).toEqual([0, 1, 2])
    expect([...alignPlainToText("ab", "a\nb")]).toEqual([0, 2])
  })

  it("resyncs after markup-only text, such as a footnote marker", () => {
    const plain = "Psalm 119 has many verses."
    const text = "Psalm 119a has many verses."
    const map = alignPlainToText(plain, text)
    // "has many verses." still lines up after the extra "a".
    expect(text.slice(map[plain.indexOf("has")], map[plain.indexOf("has")] + 3)).toBe("has")
  })
})

describe("mapRangesToText", () => {
  it("drops a span whose text differs on the two sides", () => {
    // The plain text was changed since the markup was made (a pending edit).
    expect(mapRangesToText("Psalm 119 has verses.", "Psalm 120 has verses.", [major(6, 9)])).toEqual([])
  })

  it("keeps spans clamped to the plain text and skips empty ones", () => {
    expect(mapRangesToText("40 days", "40 days", [major(0, 2), major(5, 5), major(-3, 0)])).toEqual([major(0, 2)])
  })
})

describe("decorateRuleRangesInHtml", () => {
  const PLAIN = "Psalm 119 has verses."

  it("underlines the finding inside inline formatting", () => {
    const out = decorateRuleRangesInHtml("<p>Psalm <b>119</b> has verses.</p>", PLAIN, [major(6, 9)])
    expect(underlined(out)).toEqual([["builtin:number-integrity", "119"]])
    // The formatting survives, around the underline.
    expect(parse(out).querySelector("b [data-rule-range]")?.textContent).toBe("119")
  })

  it("draws the same classes as the plain-text path", () => {
    const out = decorateRuleRangesInHtml(PLAIN, PLAIN, [major(6, 9)])
    const span = parse(out).querySelector("[data-rule-range]")
    expect(span).toHaveClass("decoration-wavy", "underline", "underline-offset-[3px]", "decoration-red-500")
  })

  it("splits a span that crosses a tag boundary, underlining both halves", () => {
    const out = decorateRuleRangesInHtml("Psalm 1<i>19</i> has verses.", PLAIN, [major(6, 9)])
    expect(underlined(out)).toEqual([
      ["builtin:number-integrity", "1"],
      ["builtin:number-integrity", "19"],
    ])
  })

  it("handles nested formatting and decoded entities", () => {
    const plain = "Fish & loaves: 5 & 2."
    const out = decorateRuleRangesInHtml(
      "<p>Fish &amp; loaves: <b><i>5</i></b> &amp; 2.</p>", plain, [major(15, 16), major(19, 20)],
    )
    expect(underlined(out)).toEqual([
      ["builtin:number-integrity", "5"],
      ["builtin:number-integrity", "2"],
    ])
  })

  it("places spans after a <br> the plain text writes as a newline", () => {
    const plain = "First line\n40 days"
    const out = decorateRuleRangesInHtml("First line<br>40 days", plain, [major(11, 13)])
    expect(underlined(out)).toEqual([["builtin:number-integrity", "40"]])
  })

  it("keeps characters outside the basic plane intact (Adlam digits)", () => {
    const plain = "𞥔𞥐 days"
    const out = decorateRuleRangesInHtml(`<span>${plain}</span>`, plain, [major(0, 4)])
    expect(underlined(out)).toEqual([["builtin:number-integrity", "𞥔𞥐"]])
  })

  it("stacks overlapping findings with one underline each, most severe innermost", () => {
    const out = decorateRuleRangesInHtml(PLAIN, PLAIN, [
      { start: 6, end: 13, ruleId: "minor-rule", kind: "violation-minor" },
      major(6, 9),
    ])
    const inner = parse(out).querySelector('[data-rule-id="builtin:number-integrity"]')
    expect(inner?.textContent).toBe("119")
    expect(inner?.parentElement?.getAttribute("data-rule-id")).toBe("minor-rule")
    expect(inner?.parentElement).toHaveClass("underline-offset-[6px]")
  })

  it("marks a waived finding the way the plain path does", () => {
    const out = decorateRuleRangesInHtml(PLAIN, PLAIN, [{ ...major(6, 9), kind: "violation-waived" }])
    expect(parse(out).querySelector("[data-rule-range]")).toHaveClass("opacity-60")
  })

  it("gives the span a button role and a tab stop only when it can be opened", () => {
    expect(parse(decorateRuleRangesInHtml(PLAIN, PLAIN, [major(6, 9)])).querySelector("[data-rule-range]"))
      .not.toHaveAttribute("role")
    const clickable = parse(decorateRuleRangesInHtml(PLAIN, PLAIN, [major(6, 9)], { clickable: true }))
      .querySelector("[data-rule-range]")
    expect(clickable).toHaveAttribute("role", "button")
    expect(clickable).toHaveAttribute("tabindex", "0")
  })

  it("leaves the markup untouched when the plain text no longer matches it", () => {
    const html = "Psalm <b>120</b> has verses."
    expect(decorateRuleRangesInHtml(html, PLAIN, [major(6, 9)])).toBe(html)
  })

  it("nests a finding on a key term inside the term's chip, so the finding is innermost", () => {
    const spirit: Concept = {
      id: "c1", sourceTerm: "Spirit", renderings: [], status: "active", createdAt: "2026-01-01T00:00:00Z",
    }
    const plain = "The Spirit came."
    const withTerms = decorateTermsInHtml("The <b>Spirit</b> came.", [spirit])
    const out = decorateRuleRangesInHtml(withTerms, plain, [major(4, 10, "term:c1:approved")])
    const finding = parse(out).querySelector("[data-rule-range]")
    expect(finding?.textContent).toBe("Spirit")
    expect(finding?.closest("[data-source-term]")).not.toBeNull()
  })

  it("returns the html unchanged when there is nothing to draw", () => {
    expect(decorateRuleRangesInHtml("<b>x</b>", "x", [])).toBe("<b>x</b>")
    expect(decorateRuleRangesInHtml("<b>x</b>", "x", undefined)).toBe("<b>x</b>")
  })
})
