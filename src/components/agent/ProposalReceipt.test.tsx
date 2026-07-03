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
        counts={{ accepted: 1, edited: 1, rejected: 0, pending: 1, checks: 2 }}
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
        counts={{ accepted: 1, edited: 0, rejected: 0, pending: 0, checks: 0 }}
        onReview={() => {}}
      />,
    )
    expect(screen.queryByRole("button", { name: /Review/ })).toBeNull()
    expect(screen.getByText("done")).toBeInTheDocument()
  })
})
