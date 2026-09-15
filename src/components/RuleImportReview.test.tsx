/**
 * RuleImportReview — AQU-198
 *
 * Regression guard: the review screen offers an inline name edit, and the
 * accepted drafts it hands back must carry that edit. Before this, `onCommit`
 * passed bare indices and both consumers re-read `drafts[i].name`, so a rename
 * typed here was silently discarded on commit.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { RuleImportReview } from "./RuleImportReview"
import type { RuleSuggestion } from "@/lib/rules/rule-suggester"

const DRAFTS: RuleSuggestion[] = [
  {
    name: "Preserve numbers",
    description: "Numbers must survive the translation.",
    severity: "major",
    check: { type: "source-target-match", pattern: "\\d+" },
  },
  {
    name: "No ellipsis",
    description: "Target must not end with an ellipsis.",
    severity: "minor",
    check: { type: "target-forbids", targetPattern: "\\.\\.\\." },
  },
]

/** The "Add N rule(s)" commit button. */
function commitButton() {
  return screen.getByRole("button", { name: /^Add \d+ rules?$/ })
}

describe("RuleImportReview", () => {
  it("commits the drafts unchanged when nothing is edited", () => {
    const onCommit = vi.fn()
    render(<RuleImportReview drafts={DRAFTS} onCommit={onCommit} onBack={vi.fn()} />)

    fireEvent.click(commitButton())

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0][0]).toEqual(DRAFTS)
  })

  it("carries an inline name edit through to the committed draft", () => {
    const onCommit = vi.fn()
    render(<RuleImportReview drafts={DRAFTS} onCommit={onCommit} onBack={vi.fn()} />)

    fireEvent.change(screen.getByDisplayValue("Preserve numbers"), {
      target: { value: "Keep every digit" },
    })
    fireEvent.click(commitButton())

    const committed: RuleSuggestion[] = onCommit.mock.calls[0][0]
    expect(committed[0].name).toBe("Keep every digit")
    // The rest of the draft is untouched by the rename.
    expect(committed[0].check).toEqual(DRAFTS[0].check)
    expect(committed[0].severity).toBe("major")
    // The un-renamed draft keeps its own name.
    expect(committed[1].name).toBe("No ellipsis")
  })

  it("falls back to the draft's own name when the edit is blanked out", () => {
    const onCommit = vi.fn()
    render(<RuleImportReview drafts={DRAFTS} onCommit={onCommit} onBack={vi.fn()} />)

    fireEvent.change(screen.getByDisplayValue("No ellipsis"), {
      target: { value: "   " },
    })
    fireEvent.click(commitButton())

    const committed: RuleSuggestion[] = onCommit.mock.calls[0][0]
    expect(committed[1].name).toBe("No ellipsis")
  })

  it("excludes rejected drafts and keeps the survivor's edit", () => {
    const onCommit = vi.fn()
    render(<RuleImportReview drafts={DRAFTS} onCommit={onCommit} onBack={vi.fn()} />)

    fireEvent.change(screen.getByDisplayValue("Preserve numbers"), {
      target: { value: "Keep every digit" },
    })
    // Toggle the second draft off — its accept/reject button is the second one.
    const toggles = screen
      .getAllByRole("button")
      .filter((b) => !/^Add \d+ rules?$/.test(b.textContent ?? "") && b.textContent === "")
    fireEvent.click(toggles[1])
    fireEvent.click(commitButton())

    const committed: RuleSuggestion[] = onCommit.mock.calls[0][0]
    expect(committed).toHaveLength(1)
    expect(committed[0].name).toBe("Keep every digit")
  })
})
