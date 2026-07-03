/**
 * WorkingSetPanel tests — the pending-diff rendering rule: the strikethrough
 * line is "the value being replaced", so it must NOT appear for empty cells
 * or when the current value already equals the proposal (both read as the new
 * text shown twice — the bug this pins against).
 */

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import type { WorkingSetRow } from "@/lib/agent/working-set"
import { WorkingSetPanel } from "./WorkingSetPanel"

function row(overrides: Partial<WorkingSetRow>): WorkingSetRow {
  return {
    cellId: "c1",
    fileId: "f1",
    ref: "MRK 1:1",
    source: "The beginning of the good news",
    target: "",
    stagedEvent: {
      kind: "target.cell.commit",
      cellId: "c1",
      fileId: "f1",
      payload: { value: "nuevo" },
      display: { canonicalRef: "MRK 1:1" },
    },
    proposalId: "p1",
    proposed: "nuevo",
    ...overrides,
  }
}

const strikethroughs = (container: HTMLElement) => container.querySelectorAll(".line-through")

describe("WorkingSetPanel pending rows", () => {
  it("shows only the proposed text for an empty cell — no crossed-out copy", () => {
    const { container } = render(<WorkingSetPanel rows={[row({ target: "" })]} />)
    expect(screen.getAllByText("nuevo")).toHaveLength(1)
    expect(strikethroughs(container)).toHaveLength(0)
  })

  it("suppresses the strikethrough when the current value equals the proposal", () => {
    const { container } = render(<WorkingSetPanel rows={[row({ target: "nuevo" })]} />)
    expect(screen.getAllByText("nuevo")).toHaveLength(1)
    expect(strikethroughs(container)).toHaveLength(0)
  })

  it("shows old-crossed-out above new when the cell has a different current value", () => {
    const { container } = render(<WorkingSetPanel rows={[row({ target: "viejo" })]} />)
    expect(strikethroughs(container)).toHaveLength(1)
    expect(screen.getByText("viejo")).toHaveClass("line-through")
    expect(screen.getByText("nuevo")).not.toHaveClass("line-through")
  })
})
