/**
 * ProposalReceipt tests — the workbench's compact proposal line: counts, the
 * ref span, the Review jump while rows are undecided, and the settled state.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { AgentProposal } from "@/lib/agent/protocol"
import { ProposalReceipt } from "./ProposalReceipt"

function proposal(refs: string[]): AgentProposal {
  return {
    proposalId: "p1",
    runId: "r1",
    summary: "Stage events",
    events: refs.map((ref, i) => ({
      kind: "target.cell.commit",
      cellId: `c${i}`,
      fileId: "f1",
      payload: { value: "x" },
      display: { canonicalRef: ref },
    })),
  }
}

describe("ProposalReceipt", () => {
  it("shows the draft count, ref span, live counters, and the Review jump", () => {
    const onReview = vi.fn()
    render(
      <ProposalReceipt
        proposal={proposal(["MRK 1:1", "MRK 1:2", "MRK 1:5"])}
        counts={{ accepted: 1, edited: 1, rejected: 0, undone: 0, pending: 1, checks: 2 }}
        onReview={onReview}
      />,
    )
    expect(screen.getByText("3 drafts staged")).toBeInTheDocument()
    expect(screen.getByText("MRK 1:1 – MRK 1:5")).toBeInTheDocument()
    expect(screen.getByText("1 accepted")).toBeInTheDocument()
    expect(screen.getByText("1 edited & accepted")).toBeInTheDocument()
    expect(screen.getByText("1 to review")).toBeInTheDocument()
    expect(screen.getByText("2 checks")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Review in working set/ }))
    expect(onReview).toHaveBeenCalled()
  })

  it("settles once every row is decided: no Review jump, a done marker", () => {
    render(
      <ProposalReceipt
        proposal={proposal(["MRK 1:1"])}
        counts={{ accepted: 1, edited: 0, rejected: 0, undone: 0, pending: 0, checks: 0 }}
        onReview={() => {}}
      />,
    )
    expect(screen.queryByRole("button", { name: /Review/ })).toBeNull()
    expect(screen.getByText("done")).toBeInTheDocument()
  })

  it("offers Undo while applied rows exist, then reports them undone", () => {
    const onUndo = vi.fn()
    const { rerender } = render(
      <ProposalReceipt
        proposal={proposal(["MRK 1:1", "MRK 1:2"])}
        counts={{ accepted: 2, edited: 0, rejected: 0, undone: 0, pending: 0, checks: 0 }}
        onUndo={onUndo}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Undo applied/ }))
    expect(onUndo).toHaveBeenCalled()

    // After the compensating events apply, the rows read "undone" and the
    // Undo affordance disappears (nothing applied is left to reverse).
    rerender(
      <ProposalReceipt
        proposal={proposal(["MRK 1:1", "MRK 1:2"])}
        counts={{ accepted: 0, edited: 0, rejected: 0, undone: 2, pending: 0, checks: 0 }}
        onUndo={onUndo}
      />,
    )
    expect(screen.getByText("2 undone")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Undo applied/ })).toBeNull()
  })

  it("never offers Undo before anything has been applied", () => {
    render(
      <ProposalReceipt
        proposal={proposal(["MRK 1:1"])}
        counts={{ accepted: 0, edited: 0, rejected: 0, undone: 0, pending: 1, checks: 0 }}
        onReview={() => {}}
        onUndo={() => {}}
      />,
    )
    expect(screen.queryByRole("button", { name: /Undo applied/ })).toBeNull()
  })
})
