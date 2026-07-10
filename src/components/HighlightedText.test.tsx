import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { HighlightedText } from "./HighlightedText"

describe("HighlightedText", () => {
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
})
