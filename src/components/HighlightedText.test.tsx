import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
import { HighlightedText, type RangeHighlight } from "./HighlightedText"

function r(start: number, end: number, ruleId: string, kind: RangeHighlight["kind"] = "violation-major"): RangeHighlight {
  return { start, end, kind, ruleId }
}

describe("HighlightedText range chunking", () => {
  const TEXT = "In the beginning God created the heavens"

  it("renders the text exactly once with non-overlapping ranges", () => {
    const { container } = render(
      <HighlightedText text={TEXT} ranges={[r(0, 2, "a"), r(7, 16, "b")]} />,
    )
    expect(container.textContent).toBe(TEXT)
  })

  // Regression: overlapping ranges used to re-emit the shared characters,
  // visibly duplicating the verse text wherever two rules intersected.
  it("does not duplicate text when ranges overlap", () => {
    const { container } = render(
      <HighlightedText text={TEXT} ranges={[r(0, 10, "a"), r(5, 16, "b")]} />,
    )
    expect(container.textContent).toBe(TEXT)
  })

  it("does not duplicate or rewind for a fully-contained range", () => {
    const { container } = render(
      <HighlightedText text={TEXT} ranges={[r(0, 16, "outer"), r(4, 8, "inner")]} />,
    )
    expect(container.textContent).toBe(TEXT)
    // Inner range is fully covered by the outer one — only the outer renders.
    expect(container.querySelector('[data-rule-id="inner"]')).toBeNull()
    expect(container.querySelector('[data-rule-id="outer"]')?.textContent).toBe(TEXT.slice(0, 16))
  })

  it("later overlapping range keeps only its uncovered tail", () => {
    const { container } = render(
      <HighlightedText text={TEXT} ranges={[r(0, 10, "a"), r(5, 16, "b")]} />,
    )
    expect(container.querySelector('[data-rule-id="a"]')?.textContent).toBe(TEXT.slice(0, 10))
    expect(container.querySelector('[data-rule-id="b"]')?.textContent).toBe(TEXT.slice(10, 16))
  })

  it("more severe range wins a shared start offset", () => {
    const { container } = render(
      <HighlightedText
        text={TEXT}
        ranges={[r(0, 10, "minor-rule", "violation-minor"), r(0, 10, "major-rule", "violation-major")]}
      />,
    )
    expect(container.textContent).toBe(TEXT)
    expect(container.querySelector('[data-rule-id="major-rule"]')).not.toBeNull()
    expect(container.querySelector('[data-rule-id="minor-rule"]')).toBeNull()
  })

  it("handles identical duplicate ranges without duplicating text", () => {
    const { container } = render(
      <HighlightedText text={TEXT} ranges={[r(3, 9, "a"), r(3, 9, "b")]} />,
    )
    expect(container.textContent).toBe(TEXT)
  })
})

describe("HighlightedText evidence tokens (Unicode)", () => {
  it("highlights accented Latin tokens", () => {
    const { container } = render(
      <HighlightedText
        text="más allá del río"
        highlights={[{ token: "más", colorIndex: 0 }]}
        showEvidence
      />,
    )
    const highlighted = Array.from(container.querySelectorAll("span[style]"))
    expect(highlighted.map((el) => el.textContent)).toContain("más")
  })

  it("highlights Greek tokens with surrounding punctuation", () => {
    const { container } = render(
      <HighlightedText
        text="ἦν ὁ λόγος,"
        highlights={[{ token: "λόγος", colorIndex: 1 }]}
        showEvidence
      />,
    )
    const highlighted = Array.from(container.querySelectorAll("span[style]"))
    expect(highlighted.map((el) => el.textContent)).toContain("λόγος,")
  })
})
