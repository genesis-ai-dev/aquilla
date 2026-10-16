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
  })

  // AQU-1633: a range sitting wholly inside another used to be dropped, so a
  // red "Identical to source" underline hid an amber finding on the same words
  // and the amber one was unreachable from the editor.
  it("keeps a fully-contained range reachable alongside the one covering it", () => {
    const { container } = render(
      <HighlightedText
        text={TEXT}
        ranges={[r(0, 16, "outer"), r(4, 8, "inner", "violation-minor")]}
      />,
    )
    expect(container.textContent).toBe(TEXT)
    expect(container.querySelector('[data-rule-id="inner"]')?.textContent).toBe(TEXT.slice(4, 8))
    // The covering range still underlines the whole span it reported, now as
    // the outer layer of the stack over the shared characters.
    const outer = container.querySelectorAll('[data-rule-id="outer"]')
    expect(Array.from(outer).map((el) => el.textContent).join("")).toBe(TEXT.slice(0, 16))
  })

  it("stacks the two underlines at different offsets", () => {
    const { container } = render(
      <HighlightedText
        text={TEXT}
        ranges={[r(0, 16, "outer"), r(4, 8, "inner", "violation-minor")]}
      />,
    )
    const inner = container.querySelector('[data-rule-id="inner"]')
    // Most severe sits innermost, closest to the text; the minor finding is
    // the layer outside it, so both wavy lines are visible.
    expect(inner).toHaveClass("decoration-amber-500", "underline-offset-[6px]")
    const major = Array.from(container.querySelectorAll('[data-rule-id="outer"]'))
      .find((el) => el.textContent === TEXT.slice(4, 8))
    expect(major).toHaveClass("decoration-red-500", "underline-offset-[3px]")
  })

  it("partially overlapping ranges each underline their whole reported span", () => {
    const { container } = render(
      <HighlightedText text={TEXT} ranges={[r(0, 10, "a"), r(5, 16, "b")]} />,
    )
    expect(container.textContent).toBe(TEXT)
    const spanText = (id: string) =>
      Array.from(container.querySelectorAll(`[data-rule-id="${id}"]`))
        .filter((el) => !el.parentElement?.closest(`[data-rule-id="${id}"]`))
        .map((el) => el.textContent)
        .join("")
    expect(spanText("a")).toBe(TEXT.slice(0, 10))
    expect(spanText("b")).toBe(TEXT.slice(5, 16))
  })

  it("keeps both findings on a shared span, most severe innermost", () => {
    const { container } = render(
      <HighlightedText
        text={TEXT}
        ranges={[r(0, 10, "minor-rule", "violation-minor"), r(0, 10, "major-rule", "violation-major")]}
      />,
    )
    expect(container.textContent).toBe(TEXT)
    const minor = container.querySelector('[data-rule-id="minor-rule"]')
    const major = container.querySelector('[data-rule-id="major-rule"]')
    expect(minor).not.toBeNull()
    expect(major).not.toBeNull()
    // The more severe finding owns the click on a fully shared span.
    expect(minor?.contains(major!)).toBe(true)
  })

  it("underlines a rule reported twice over the same run only once", () => {
    const { container } = render(
      <HighlightedText text={TEXT} ranges={[r(0, 10, "a"), r(0, 10, "a")]} />,
    )
    expect(container.textContent).toBe(TEXT)
    expect(container.querySelectorAll('[data-rule-id="a"]')).toHaveLength(1)
  })

  it("handles identical duplicate ranges without duplicating text", () => {
    const { container } = render(
      <HighlightedText text={TEXT} ranges={[r(3, 9, "a"), r(3, 9, "b")]} />,
    )
    expect(container.textContent).toBe(TEXT)
  })
})

describe("HighlightedText zero-width and clamped ranges", () => {
  it("does not render a clickable underline span for zero-width violation ranges", () => {
    const { container } = render(
      <HighlightedText
        text="missing punctuation"
        ranges={[{
          start: 19,
          end: 19,
          kind: "violation-minor",
          ruleId: "builtin:end-punctuation-mismatch",
        }]}
        onRangeClick={() => undefined}
      />,
    )

    expect(container.querySelector("[data-rule-id]")).toBeNull()
    expect(container.textContent).toBe("missing punctuation")
  })

  it("still renders non-empty violation ranges", () => {
    const { container } = render(
      <HighlightedText
        text="wrong."
        ranges={[{
          start: 5,
          end: 6,
          kind: "violation-minor",
          ruleId: "builtin:end-punctuation-mismatch",
        }]}
        onRangeClick={() => undefined}
      />,
    )

    const range = container.querySelector("[data-rule-id='builtin:end-punctuation-mismatch']")
    expect(range).not.toBeNull()
    expect(range?.textContent).toBe(".")
  })

  it("combines the blue term highlight with the severity blot", () => {
    const { container } = render(
      <HighlightedText
        text="managed term"
        ranges={[{
          start: 0,
          end: 7,
          kind: "violation-major",
          ruleId: "term:concept-1:approved",
        }]}
      />,
    )

    const range = container.querySelector('[data-rule-id="term:concept-1:approved"]')
    expect(range).toHaveClass("terminology-highlight")
    expect(range).toHaveClass(
      "underline",
      "decoration-wavy",
      "decoration-red-500",
    )
  })

  it("keeps severity underlines for non-terminology ranges", () => {
    const { container } = render(
      <HighlightedText
        text="generic rule"
        ranges={[{
          start: 0,
          end: 7,
          kind: "violation-major",
          ruleId: "rule-1",
        }]}
      />,
    )

    const range = container.querySelector('[data-rule-id="rule-1"]')
    expect(range).toHaveClass("underline", "decoration-wavy")
    expect(range).not.toHaveClass("terminology-highlight")
  })
})

describe("HighlightedText health spans (#946)", () => {
  it("paints supported and guessed spans without changing the text", () => {
    const { container } = render(
      <HighlightedText
        text="Espiritu Santo came"
        healthSpans={[
          { start: 0, end: 14, kind: "supported", title: "Holy Spirit → Espiritu Santo" },
          { start: 15, end: 19, kind: "guessed" },
        ]}
      />,
    )
    expect(container.textContent).toBe("Espiritu Santo came")
    expect(container.querySelector('[data-health-span="supported"]')?.textContent).toBe("Espiritu Santo")
    expect(container.querySelector('[data-health-span="supported"]')?.getAttribute("title")).toBe(
      "Holy Spirit → Espiritu Santo",
    )
    expect(container.querySelector('[data-health-span="guessed"]')?.textContent).toBe("came")
  })

  it("keeps a violation underline on top of a health wash", () => {
    const { container } = render(
      <HighlightedText
        text="Espiritu Santo"
        ranges={[r(0, 8, "rule-1")]}
        healthSpans={[{ start: 0, end: 14, kind: "supported" }]}
      />,
    )
    expect(container.textContent).toBe("Espiritu Santo")
    const health = container.querySelector('[data-health-span="supported"]')
    expect(health?.querySelector('[data-rule-id="rule-1"]')?.textContent).toBe("Espiritu")
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
