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
import { render, screen, fireEvent } from "@testing-library/react"
import {
  CheckFindingsDrawer,
  checkScopeSummary,
  termFindingHeadline,
  findingCellLabel,
} from "./CheckFindingsDrawer"
import type { CheckRunResult, TermConsistencyFinding } from "@/lib/check/deterministic-check"
import type { CellData } from "@/hooks/useCells"

function makeCell(id: string, cellLabel: string, translated: string): CellData {
  return {
    id, fileId: "f1", cellLabel,
    original: "src", translated,
    context: "", group: "g", type: "text",
    status: "unvalidated", validationStatus: { validated: false },
  } as unknown as CellData
}

const baseResult: CheckRunResult = {
  ranAt: "2026-06-11T20:00:00.000Z",
  fileId: "f1",
  checkedCellCount: 32,
  checkedRuleCount: 12,
  checkedTermCount: 8,
  ruleFindings: [],
  termFindings: [],
  totalFindingCount: 0,
}

describe("checkScopeSummary", () => {
  it("names exactly what was checked", () => {
    expect(checkScopeSummary(baseResult)).toBe("32 cells · 12 rules · 8 terms")
    expect(checkScopeSummary({ ...baseResult, checkedCellCount: 1, checkedRuleCount: 1, checkedTermCount: 1 }))
      .toBe("1 cell · 1 rule · 1 term")
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
    expect(termFindingHeadline(finding)).toBe(
      '14 of 18 occurrences use "Kristo" (14), 4 use something else',
    )
  })

  it("handles the zero-consistent case without a bogus usage list", () => {
    expect(
      termFindingHeadline({ ...finding, consistentCount: 0, renderingUsage: [] }),
    ).toBe("none of 18 occurrences use an approved rendering")
  })
})

describe("CheckFindingsDrawer", () => {
  it("empty state names what was checked and says no issues found", () => {
    render(
      <CheckFindingsDrawer
        result={baseResult} running={false} cells={[]}
        onClose={() => {}} onNavigateToCell={() => {}}
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
          message: '"No double bang": target contains forbidden pattern',
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
        onClose={() => {}} onNavigateToCell={onNavigateToCell}
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
        onClose={() => {}} onNavigateToCell={() => {}} onOpenComments={onOpenComments}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Comment on MAT 1:16" }))
    expect(onOpenComments).toHaveBeenCalledWith("c2")
  })

  it("shows a running state while the check executes", () => {
    render(
      <CheckFindingsDrawer
        result={null} running cells={[]}
        onClose={() => {}} onNavigateToCell={() => {}}
      />,
    )
    expect(screen.getByText(/Checking…/)).toBeInTheDocument()
  })
})

// ── SUB-5: human titles for finding cards (never a raw UUID when avoidable) ──

describe("findingCellLabel", () => {
  const mk = (o: Partial<CellData>): CellData => ({ id: "x", context: "", ...o }) as unknown as CellData

  it("prefers the cell's label when present", () => {
    expect(findingCellLabel(mk({ cellLabel: "MAT 1:1" }), "uuid-1")).toBe("MAT 1:1")
  })

  it("falls back to the cue timestamp range for subtitle cells", () => {
    const cell = mk({ context: "00:36:01.995 --> 00:36:05.374" })
    expect(findingCellLabel(cell, "uuid-1")).toBe("36:02.0–36:05.4")
  })

  it("keeps hours when nonzero", () => {
    const cell = mk({ context: "01:02:03.000 --> 01:02:04.500" })
    expect(findingCellLabel(cell, "uuid-1")).toBe("1:02:03.0–1:02:04.5")
  })

  it("falls back to the id only when the cell is unknown or untimed", () => {
    expect(findingCellLabel(undefined, "uuid-1")).toBe("uuid-1")
    expect(findingCellLabel(mk({ context: "GEN 1:1" }), "uuid-2")).toBe("uuid-2")
  })
})
