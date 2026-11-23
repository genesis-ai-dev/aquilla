/**
 * CheckFindingsDrawer tests — findings UI v0 for the Phase 0.5 deterministic
 * check.
 *
 * WHY: the spec (§8) requires the panel to state exactly WHAT was checked in
 * both the summary and the empty state, and every finding must cite evidence
 * the user can click through to the cell. These tests pin those contracts so
 * a refactor can't silently turn the empty state into a bare "all good" or
 * break click-to-cell navigation.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  CheckFindingsDrawer,
  checkScopeSummary,
  termFindingHeadline,
  findingCellLabel,
} from "./CheckFindingsDrawer"
import type { CheckRunResult, TermConsistencyFinding } from "@/lib/check/deterministic-check"
import type { CellData } from "@/hooks/useCells"
import { t as en } from "@/lib/i18n/standalone"
import { DEFAULT_LOCALE } from "@/lib/i18n/locales"

function makeCell(id: string, cellLabel: string, translated: string): CellData {
  return {
    id, fileId: "f1", cellLabel,
    original: "src", translated,
    context: "", group: "g", type: "text",
    status: "unvalidated", validationStatus: { validated: false },
  } as unknown as CellData
}

/** One "No double bang" rule group flagging each of `cellIds`. */
function ruleGroup(cellIds: string[]): CheckRunResult["ruleFindings"][number] {
  return {
    rule: {
      id: "r1", name: "No double bang", description: "", severity: "minor",
      source: "user", scope: "project", enabled: true, createdAt: "2026-01-01",
      check: { type: "target-forbids", targetPattern: "!!" },
    },
    infractions: cellIds.map((cellId) => ({
      ruleId: "r1", cellId, fileId: "f1",
      reason: "target-forbids",
      spans: [{ side: "target" as const, start: 0, end: 2, matchedText: "!!" }],
    })),
  }
}

const baseResult: CheckRunResult = {
  ranAt: "2026-06-11T20:00:00.000Z",
  fileId: "f1",
  checkedCellCount: 32,
  checkedRuleCount: 12,
  checkedTermCount: 8,
  ruleFindings: [],
  termFindings: [],
  capitalizationFindings: [],
  caseExceptions: [],
  spellingFindings: [],
  approvedSpellings: [],
  wordlistSize: 0,
  totalFindingCount: 0,
}

describe("checkScopeSummary", () => {
  it("names exactly what was checked", () => {
    expect(checkScopeSummary(baseResult, en, DEFAULT_LOCALE)).toBe("32 cells · 12 rules · 8 terms")
    expect(
      checkScopeSummary(
        { ...baseResult, checkedCellCount: 1, checkedRuleCount: 1, checkedTermCount: 1 },
        en,
        DEFAULT_LOCALE,
      ),
    ).toBe("1 cell · 1 rule · 1 term")
  })
})

describe("termFindingHeadline", () => {
  const finding: TermConsistencyFinding = {
    conceptId: "k1",
    sourceTerm: "Χριστός",
    approvedRenderings: ["Kristo"],
    totalOccurrences: 18,
    consistentCount: 14,
    renderingUsage: [{ rendering: "Kristo", cellIds: Array.from({ length: 14 }, (_, i) => `c${i}`) }],
    flaggedCells: Array.from({ length: 4 }, (_, i) => ({ cellId: `x${i}` })),
  }

  it("reads as 'N of M occurrences use X, K use something else'", () => {
    expect(termFindingHeadline(finding, en, DEFAULT_LOCALE)).toBe(
      '14 of 18 occurrences use "Kristo" (14), 4 use something else',
    )
  })

  it("handles the zero-consistent case without a bogus usage list", () => {
    expect(
      termFindingHeadline({ ...finding, consistentCount: 0, renderingUsage: [] }, en, DEFAULT_LOCALE),
    ).toBe("none of 18 occurrences use an approved rendering")
  })
})

describe("CheckFindingsDrawer", () => {
  it("empty state names what was checked and says no issues found", () => {
    render(
      <CheckFindingsDrawer
        result={baseResult} running={false} cells={[]}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}}
      />,
    )
    expect(
      screen.getByText(/Checked 32 cells · 12 rules · 8 terms — no issues found/),
    ).toBeInTheDocument()
  })

  it("renders rule and term findings with evidence, and clicking a cell reference navigates", () => {
    const onNavigateToCell = vi.fn()
    const cells = [makeCell("c1", "MAT 1:1", "Kristo!!"), makeCell("c2", "MAT 1:16", "Masihi")]
    const result: CheckRunResult = {
      ...baseResult,
      ruleFindings: [{
        rule: {
          id: "r1", name: "No double bang", description: "", severity: "minor",
          source: "user", scope: "project", enabled: true, createdAt: "2026-01-01",
          check: { type: "target-forbids", targetPattern: "!!" },
        },
        infractions: [{
          ruleId: "r1", cellId: "c1", fileId: "f1",
          reason: "target-forbids",
          spans: [{ side: "target", start: 6, end: 8, matchedText: "!!" }],
        }],
      }],
      termFindings: [{
        conceptId: "k1", sourceTerm: "Χριστός", approvedRenderings: ["Kristo"],
        totalOccurrences: 2, consistentCount: 1,
        renderingUsage: [{ rendering: "Kristo", cellIds: ["c1"] }],
        flaggedCells: [{ cellId: "c2", cellLabel: "MAT 1:16" }],
      }],
      totalFindingCount: 2,
    }

    render(
      <CheckFindingsDrawer
        result={result} running={false} cells={cells}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={onNavigateToCell}
      />,
    )

    // Severity-ish grouping headers with counts.
    expect(screen.getByText("Rule violations (1)")).toBeInTheDocument()
    expect(screen.getByText("Term consistency (1)")).toBeInTheDocument()
    // Evidence: rule name, concept name, occurrence sentence.
    expect(screen.getByText("No double bang")).toBeInTheDocument()
    expect(screen.getByText("Χριστός")).toBeInTheDocument()
    expect(screen.getByText(/1 of 2 occurrences use "Kristo" \(1\), 1 use something else/)).toBeInTheDocument()
    // Run summary header.
    expect(screen.getByText(/Checked 32 cells · 12 rules · 8 terms ·/)).toBeInTheDocument()

    // Click-to-cell: term finding's flagged cell reference navigates.
    fireEvent.click(screen.getByText("MAT 1:16"))
    expect(onNavigateToCell).toHaveBeenCalledWith("c2")
    // Rule finding's cell reference navigates too.
    fireEvent.click(screen.getByText("MAT 1:1"))
    expect(onNavigateToCell).toHaveBeenCalledWith("c1")
  })

  it("accounts for learned capitalization exceptions even on a clean result (AQU-1734)", () => {
    render(
      <CheckFindingsDrawer
        result={{ ...baseResult, caseExceptions: [{ form: "ki-", occurrences: 40 }] }}
        running={false} cells={[]}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}}
      />,
    )
    expect(screen.getByText(/no issues found/)).toBeInTheDocument()
    expect(screen.getByText(/Not flagged .* ki-/)).toBeInTheDocument()
  })

  it("renders capitalization findings and names the exceptions it learned (AQU-1734)", () => {
    const onNavigateToCell = vi.fn()
    const cells = [makeCell("c1", "MAT 1:1", "Alisema tHe neno"), makeCell("c2", "MRK 1:16", "mwito wa Simoni")]
    const result: CheckRunResult = {
      ...baseResult,
      capitalizationFindings: [
        { code: "mixed-case", form: "tHe", cells: [{ cellId: "c1", cellLabel: "MAT 1:1" }] },
        { code: "lowercase-heading-start", form: "", cells: [{ cellId: "c2", cellLabel: "MRK 1:16" }] },
      ],
      caseExceptions: [{ form: "ki-", occurrences: 40, examples: ["kiNgozi", "kiSwahili"] }],
      totalFindingCount: 2,
    }

    render(
      <CheckFindingsDrawer
        result={result} running={false} cells={cells}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={onNavigateToCell}
      />,
    )

    expect(screen.getByText("Capitalization (2)")).toBeInTheDocument()
    // The offending form is raw cell content — rendered verbatim, not translated.
    expect(screen.getByText("tHe")).toBeInTheDocument()
    expect(screen.getByText("1 cell writes a capital inside this word")).toBeInTheDocument()
    expect(screen.getByText("Heading starts with a lowercase letter")).toBeInTheDocument()
    // What was let through is visible rather than silent.
    expect(screen.getByText(/Not flagged .* ki-/)).toBeInTheDocument()

    fireEvent.click(screen.getByText("MAT 1:1"))
    expect(onNavigateToCell).toHaveBeenCalledWith("c1")
  })

  it("offers the existing comment affordance per flagged cell", () => {
    const onOpenComments = vi.fn()
    const result: CheckRunResult = {
      ...baseResult,
      termFindings: [{
        conceptId: "k1", sourceTerm: "Χριστός", approvedRenderings: ["Kristo"],
        totalOccurrences: 1, consistentCount: 0, renderingUsage: [],
        flaggedCells: [{ cellId: "c2", cellLabel: "MAT 1:16" }],
      }],
      totalFindingCount: 1,
    }
    render(
      <CheckFindingsDrawer
        result={result} running={false} cells={[]}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}} onOpenComments={onOpenComments}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Comment on MAT 1:16" }))
    expect(onOpenComments).toHaveBeenCalledWith("c2")
  })

  it("shows a running state while the check executes", () => {
    render(
      <CheckFindingsDrawer
        result={null} running cells={[]}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}}
      />,
    )
    expect(screen.getByText(/Checking…/)).toBeInTheDocument()
  })

  it("puts a retry control immediately left of close and re-runs the check", () => {
    const onRetry = vi.fn()
    render(
      <CheckFindingsDrawer
        result={baseResult} running={false} cells={[]}
        onClose={() => {}} onRetry={onRetry} onNavigateToCell={() => {}}
      />,
    )
    const retry = screen.getByRole("button", { name: "Re-run file check" })
    const close = screen.getByRole("button", { name: "Close file check" })
    expect(retry.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("disables retry while the check is running", () => {
    render(
      <CheckFindingsDrawer
        result={null} running cells={[]}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}}
      />,
    )
    expect(screen.getByRole("button", { name: "Re-run file check" })).toBeDisabled()
  })
})

// ── SUB-5: human titles for finding cards — never a raw id ──
// A reviewer can do nothing with a UUID; a card they cannot place in the
// text is a card they skip. So the label falls back to the cell's place in
// the file, never to its id.

const UUID = "0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b"

describe("findingCellLabel", () => {
  const mk = (o: Partial<CellData>): CellData => ({ id: "x", context: "", ...o }) as unknown as CellData

  it("prefers the cell's label when present", () => {
    expect(findingCellLabel(mk({ cellLabel: "MAT 1:1" }), "Cell 4")).toBe("MAT 1:1")
  })

  it("falls back to the cue timestamp range for subtitle cells", () => {
    const cell = mk({ context: "00:36:01.995 --> 00:36:05.374" })
    expect(findingCellLabel(cell, "Cell 4")).toBe("36:02.0–36:05.4")
  })

  it("keeps hours when nonzero", () => {
    const cell = mk({ context: "01:02:03.000 --> 01:02:04.500" })
    expect(findingCellLabel(cell, "Cell 4")).toBe("1:02:03.0–1:02:04.5")
  })

  it("uses the fallback, never the id, when the cell is unknown or untimed", () => {
    expect(findingCellLabel(undefined, "Cell 4")).toBe("Cell 4")
    expect(findingCellLabel(mk({ context: "GEN 1:1" }), "Cell 4")).toBe("Cell 4")
  })

  it("ignores a label that is itself an id", () => {
    expect(findingCellLabel(mk({ cellLabel: UUID }), "Cell 4")).toBe("Cell 4")
    expect(findingCellLabel(mk({}), "Cell 4", UUID)).toBe("Cell 4")
  })
})

describe("CheckFindingsDrawer — cells without a reference", () => {
  it("names an unlabelled cell by its place in the file, not its id", () => {
    const cells = [makeCell("a", "", "one"), makeCell(UUID, "", "two")]
    const result: CheckRunResult = {
      ...baseResult,
      ruleFindings: [ruleGroup([UUID])],
      totalFindingCount: 1,
    }
    render(
      <CheckFindingsDrawer result={result} running={false} cells={cells}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}} />,
    )
    expect(screen.getByText("Cell 2")).toBeInTheDocument()
    expect(screen.queryByText(UUID)).toBeNull()
  })
})

// AQU-2260 (Sam, Oct 29): a hover may only NAME an icon-only button. A
// finding's card shows what it is and is the way to it, so it has no hover.
describe("CheckFindingsDrawer — a finding's card has no hover", () => {
  it("shows nothing on hover over a finding's card", async () => {
    const cells = [makeCell("c2", "MAT 1:16", "Masihi")]
    const result: CheckRunResult = {
      ...baseResult,
      termFindings: [{
        conceptId: "k1", sourceTerm: "Χριστός", approvedRenderings: ["Kristo"],
        totalOccurrences: 2, consistentCount: 1,
        renderingUsage: [{ rendering: "Kristo", cellIds: ["c1"] }],
        flaggedCells: [{ cellId: "c2", cellLabel: "MAT 1:16" }],
      }],
      totalFindingCount: 1,
    }
    render(
      <TooltipProvider delay={0}>
        <CheckFindingsDrawer result={result} running={false} cells={cells}
          onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}} />
      </TooltipProvider>,
    )
    await userEvent.setup().hover(screen.getByText("MAT 1:16"))
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(screen.queryByRole("tooltip")).toBeNull()
  })
})

// AQU-1737: the spelling section is the one place in this panel a reviewer
// makes a decision, so what is pinned here is that the decision is per FORM
// and takes every occurrence with it — and that nothing was let through
// silently.
describe("CheckFindingsDrawer — spelling (AQU-1737)", () => {
  const spellingResult = (): CheckRunResult => ({
    ...baseResult,
    spellingFindings: [
      {
        form: "Yeesu",
        occurrences: 2,
        suggestion: "Yesu",
        suggestionOccurrences: 14,
        reason: "sound-alike",
        cells: [
          { cellId: "c1", cellLabel: "MRK 1:1" },
          { cellId: "c2", cellLabel: "MRK 1:5" },
        ],
      },
    ],
    approvedSpellings: [{ form: "Yesu", occurrences: 140 }],
    wordlistSize: 320,
    totalFindingCount: 1,
  })

  it("names the suspected form, the usual spelling and how often it is written", () => {
    render(
      <CheckFindingsDrawer
        result={spellingResult()} running={false}
        cells={[makeCell("c1", "MRK 1:1", "Yeesu akasema")]}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}}
      />,
    )
    expect(screen.getByText("Spelling (1)")).toBeInTheDocument()
    // Both forms are raw cell content — rendered verbatim, never translated.
    expect(screen.getByText("Yeesu")).toBeInTheDocument()
    expect(screen.getByText(/Sounds like "Yesu", which this text writes 14 times/)).toBeInTheDocument()
  })

  it("approving a spelling clears every occurrence at once, not one cell of it", async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider delay={0}>
        <CheckFindingsDrawer
          result={spellingResult()} running={false}
          cells={[makeCell("c1", "MRK 1:1", "Yeesu akasema"), makeCell("c2", "MRK 1:5", "Yeesu alijibu")]}
          onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}}
        />
      </TooltipProvider>,
    )
    // Both occurrences are on the one card.
    expect(screen.getByText("MRK 1:1")).toBeInTheDocument()
    expect(screen.getByText("MRK 1:5")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Approve the spelling "Yeesu"/ }))

    expect(screen.queryByText("Yeesu")).toBeNull()
    expect(screen.queryByText("MRK 1:1")).toBeNull()
    expect(screen.queryByText("MRK 1:5")).toBeNull()
    expect(screen.getByText("Spelling (0)")).toBeInTheDocument()
    expect(screen.getByText(/1 spelling approved — every occurrence cleared/)).toBeInTheDocument()
  })

  it("keeps an approved spelling cleared when the check runs again", async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <TooltipProvider delay={0}>
        <CheckFindingsDrawer
          result={spellingResult()} running={false}
          cells={[makeCell("c1", "MRK 1:1", "Yeesu akasema")]}
          onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}}
        />
      </TooltipProvider>,
    )
    await user.click(screen.getByRole("button", { name: /Approve the spelling "Yeesu"/ }))

    // A fresh run returns the same finding; the reviewer's decision stands.
    rerender(
      <TooltipProvider delay={0}>
        <CheckFindingsDrawer
          result={{ ...spellingResult(), ranAt: "2026-06-11T21:00:00.000Z" }} running={false}
          cells={[makeCell("c1", "MRK 1:1", "Yeesu akasema")]}
          onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}}
        />
      </TooltipProvider>,
    )
    expect(screen.queryByText("Yeesu")).toBeNull()
    expect(screen.getByText("Spelling (0)")).toBeInTheDocument()
  })

  it("names what frequency let through, and the size of the wordlist it built", () => {
    render(
      <CheckFindingsDrawer
        result={spellingResult()} running={false}
        cells={[makeCell("c1", "MRK 1:1", "Yeesu akasema")]}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}}
      />,
    )
    expect(screen.getByText(/written often enough in this text to be treated as correct: Yesu/))
      .toBeInTheDocument()
    expect(screen.getByText(/Wordlist: 320 word forms/)).toBeInTheDocument()
  })

  it("a spelling finding's cell reference navigates to the cell", () => {
    const onNavigateToCell = vi.fn()
    render(
      <CheckFindingsDrawer
        result={spellingResult()} running={false}
        cells={[makeCell("c1", "MRK 1:1", "Yeesu akasema")]}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={onNavigateToCell}
      />,
    )
    fireEvent.click(screen.getByText("MRK 1:1"))
    expect(onNavigateToCell).toHaveBeenCalledWith("c1")
  })
})

// The comment button leaves a note in place: a reviewer working down the
// findings must not lose the list to the comments drawer for every note.
describe("CheckFindingsDrawer — commenting from a finding", () => {
  const result: CheckRunResult = {
    ...baseResult,
    termFindings: [{
      conceptId: "k1", sourceTerm: "Χριστός", approvedRenderings: ["Kristo"],
      totalOccurrences: 1, consistentCount: 0, renderingUsage: [],
      flaggedCells: [{ cellId: "c2", cellLabel: "MAT 1:16" }],
    }],
    totalFindingCount: 1,
  }

  it("posts a comment on the cell without opening the comments drawer", async () => {
    const user = userEvent.setup()
    const onAddComment = vi.fn(async () => {})
    const onOpenComments = vi.fn()
    render(
      <CheckFindingsDrawer
        result={result} running={false} cells={[]}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}}
        onOpenComments={onOpenComments} onAddComment={onAddComment}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Comment on MAT 1:16" }))
    await user.type(await screen.findByRole("textbox", { name: "New thread" }), "Should this be Kristo?{Enter}")
    expect(onAddComment).toHaveBeenCalledWith("c2", "Should this be Kristo?")
    expect(onOpenComments).not.toHaveBeenCalled()
    // The findings are still there to carry on with.
    expect(screen.getByText("Χριστός")).toBeInTheDocument()
  })

  it("keeps the way to the full thread", async () => {
    const user = userEvent.setup()
    const onOpenComments = vi.fn()
    render(
      <CheckFindingsDrawer
        result={result} running={false} cells={[]}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}}
        onOpenComments={onOpenComments} onAddComment={async () => {}}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Comment on MAT 1:16" }))
    await user.click(await screen.findByRole("button", { name: "Open this cell's comments" }))
    expect(onOpenComments).toHaveBeenCalledWith("c2")
  })

  it("says so when the comment did not post, and keeps the text", async () => {
    const user = userEvent.setup()
    render(
      <CheckFindingsDrawer
        result={result} running={false} cells={[]}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}}
        onAddComment={async () => { throw new Error("offline") }}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Comment on MAT 1:16" }))
    const box = await screen.findByRole("textbox", { name: "New thread" })
    await user.type(box, "note{Enter}")
    expect(await screen.findByRole("alert")).toHaveTextContent(/did not post/)
    expect(box).toHaveValue("note")
  })
})

// One noisy rule must not push every other finding off the panel.
describe("CheckFindingsDrawer — folding", () => {
  const cells = ["a", "b", "c", "d", "e"].map((id, i) => makeCell(id, `MAT 1:${i + 1}`, "x!!"))
  const render5 = () =>
    render(
      <CheckFindingsDrawer
        result={{ ...baseResult, ruleFindings: [ruleGroup(["a", "b", "c", "d", "e"])], totalFindingCount: 5 }}
        running={false} cells={cells}
        onClose={() => {}} onRetry={() => {}} onNavigateToCell={() => {}}
      />,
    )

  it("shows the first few cells of a card and the rest on request", async () => {
    const user = userEvent.setup()
    render5()
    expect(screen.getByText("MAT 1:3")).toBeInTheDocument()
    expect(screen.queryByText("MAT 1:4")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Show 2 more cells" }))
    expect(screen.getByText("MAT 1:5")).toBeInTheDocument()
  })

  it("folds a card and a whole section from their headers", async () => {
    const user = userEvent.setup()
    render5()
    await user.click(screen.getByRole("button", { name: /No double bang/ }))
    expect(screen.queryByText("MAT 1:1")).toBeNull()
    await user.click(screen.getByRole("button", { name: /No double bang/ }))
    expect(screen.getByText("MAT 1:1")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Rule violations (5)" }))
    expect(screen.queryByText("No double bang")).toBeNull()
  })

  it("opens on the sections that have findings, with the empty ones folded", () => {
    render5()
    expect(screen.getByRole("button", { name: "Rule violations (5)" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("button", { name: "Spelling (0)" })).toHaveAttribute("aria-expanded", "false")
  })
})
