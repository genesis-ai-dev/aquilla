/**
 * RuleImportReview.test.tsx — AQU-892 spacing regression guard.
 *
 * The AI rule-suggestion card is rendered here (Rules surface → "Suggest from
 * edits", and the rule-import review). Its layout has a spacing contract that
 * is easy to regress by hand-tuning one element in isolation:
 *
 *  - the inline-editable name shares its left edge with the description and the
 *    check block beneath it (the name Input carries no horizontal padding, so
 *    the title does not appear indented relative to the rest of the card), and
 *  - the card body is stacked on one rhythm: the description hugs the name,
 *    while the check block and evidence line are separated from it.
 *
 * These are asserted at the class level because that is where the regression
 * escapes — happy-dom does not compute layout.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { RuleImportReview } from "./RuleImportReview"
import type { RuleSuggestion } from "@/lib/rules/rule-suggester"

const DRAFTS: RuleSuggestion[] = [
  {
    name: "Keep divine name capitalized",
    description: "Target must capitalize the rendering of the divine name.",
    severity: "major",
    check: { type: "source-requires-target", sourcePattern: "LORD", targetPattern: "SEÑOR" },
  },
  {
    name: "No bare numerals",
    description: "Spell out numbers under ten.",
    severity: "minor",
    check: { type: "target-forbids", targetPattern: "\\b[0-9]\\b" },
  },
]

function renderReview(evidence?: string[]) {
  return render(
    <RuleImportReview
      drafts={DRAFTS}
      evidence={evidence}
      onCommit={vi.fn()}
      onBack={vi.fn()}
    />,
  )
}

describe("RuleImportReview card spacing (AQU-892)", () => {
  it("renders the inline name field with no horizontal padding so it aligns with the body text", () => {
    renderReview()

    const nameField = screen.getByDisplayValue(DRAFTS[0].name)
    expect(nameField.className).toContain("px-0")
    // A non-zero horizontal inset is exactly the regression: it pushes the
    // title right of the description/check block below it.
    expect(nameField.className).not.toMatch(/(^|\s)px-[1-9]/)
  })

  it("separates the check block from the description it follows", () => {
    const { container } = renderReview()

    const checkBlocks = container.querySelectorAll("li .bg-muted\\/50")
    expect(checkBlocks).toHaveLength(DRAFTS.length)
    for (const block of checkBlocks) {
      expect(block.className).toContain("mt-2")
    }

    const description = screen.getByText(DRAFTS[0].description!)
    expect(description.className).toContain("mt-1")
  })

  it("keeps the evidence line on the same rhythm as the check block", () => {
    renderReview(["glossary.md", "style-guide.md"])

    const evidenceLine = screen.getByText("From doc: glossary.md")
    expect(evidenceLine.className).toContain("mt-2")
  })

  it("insets the scroll container so the scrollbar does not sit on the toggle buttons", () => {
    const { container } = renderReview()

    const list = container.querySelector("ul")
    expect(list?.className).toContain("overflow-auto")
    expect(list?.className).toContain("pr-1")
  })

  it("still renders every draft with its severity badge and toggle", () => {
    renderReview()

    expect(screen.getByDisplayValue(DRAFTS[0].name)).toBeTruthy()
    expect(screen.getByDisplayValue(DRAFTS[1].name)).toBeTruthy()
    expect(screen.getByText("major")).toBeTruthy()
    expect(screen.getByText("minor")).toBeTruthy()
    expect(screen.getByText("Add 2 rules")).toBeTruthy()
  })
})
