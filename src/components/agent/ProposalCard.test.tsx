/**
 * ProposalCard tests — the staged-proposal review surface must (1) show the
 * human what will change (canonicalRef, before → after), (2) re-run the
 * deterministic lint on the AFTER text so a rule-violating draft is flagged
 * BEFORE apply, (3) honor the server's role floors on the Apply button, and
 * (4) push applies through the existing write path with the ai provenance
 * payload intact.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { TranslationRule } from "@/lib/parsers/types"
import type { AgentProposal } from "@/lib/agent/protocol"
import { ROLE } from "@/lib/agent/role-floors"
import { ProposalCard } from "./ProposalCard"

vi.mock("@/lib/agent/apply", () => ({
  applyStagedEvents: vi.fn(async () => ["evt-1"]),
}))

import { applyStagedEvents } from "@/lib/agent/apply"

const mockApply = vi.mocked(applyStagedEvents)

const FORBID_RULE: TranslationRule = {
  id: "rule-forbid",
  name: "No Latin loanwords",
  description: "",
  severity: "major",
  source: "user",
  scope: "project",
  check: { type: "target-forbids", targetPattern: "gloria" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
}

function makeProposal(overrides: Partial<AgentProposal> = {}): AgentProposal {
  return {
    proposalId: "p-1",
    runId: "run-1",
    summary: "Draft 1 cell in MRK 4",
    events: [
      {
        kind: "target.cell.commit",
        fileId: "f-1",
        cellId: "c-1",
        parentId: "evt-parent",
        payload: {
          value: "drafted gloria text",
          ai_suggestion: true,
          agent_run_id: "run-1",
        },
        display: {
          canonicalRef: "MRK 4:1",
          before: "old translation",
          after: "drafted gloria text",
        },
      },
    ],
    ...overrides,
  }
}

const BASE_PROPS = {
  roleLevel: ROLE.CONTRIBUTOR as number | null,
  rules: [] as TranslationRule[],
  applyContext: { projectId: "proj-1", author: "anna" },
}

beforeEach(() => {
  mockApply.mockClear()
  mockApply.mockResolvedValue(["evt-1"])
})

describe("rendering", () => {
  it("shows the summary, canonicalRef, and before → after texts", () => {
    render(<ProposalCard {...BASE_PROPS} proposal={makeProposal()} />)
    expect(screen.getByText("Draft 1 cell in MRK 4")).toBeInTheDocument()
    expect(screen.getByText("MRK 4:1")).toBeInTheDocument()
    expect(screen.getByText("old translation")).toBeInTheDocument()
    expect(screen.getByText("drafted gloria text")).toBeInTheDocument()
  })

  it("renders a lint badge when the after-text violates an active rule", () => {
    render(<ProposalCard {...BASE_PROPS} proposal={makeProposal()} rules={[FORBID_RULE]} />)
    expect(
      screen.getByText(/"No Latin loanwords": target contains forbidden pattern/),
    ).toBeInTheDocument()
  })

  it("does not lint with disabled rules", () => {
    render(
      <ProposalCard
        {...BASE_PROPS}
        proposal={makeProposal()}
        rules={[{ ...FORBID_RULE, enabled: false }]}
      />,
    )
    expect(screen.queryByText(/forbidden pattern/)).not.toBeInTheDocument()
  })

  it("renders unknown kinds as raw JSON with Apply disabled", () => {
    const proposal = makeProposal({
      events: [
        {
          kind: "assignment.create",
          payload: { assigneeId: 42 },
          display: {},
        },
      ],
    })
    render(<ProposalCard {...BASE_PROPS} proposal={proposal} roleLevel={ROLE.OWNER} />)
    expect(screen.getByText(/not supported yet/)).toBeInTheDocument()
    expect(screen.getByText(/"assigneeId": 42/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled()
  })
})

describe("role gate", () => {
  it("disables Apply with a reason when the role is below the kind's floor", () => {
    render(<ProposalCard {...BASE_PROPS} proposal={makeProposal()} roleLevel={ROLE.REVIEWER} />)
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled()
    expect(screen.getByText("Requires Contributor role or higher")).toBeInTheDocument()
  })

  it("enables Apply at the floor and fails open when the role is unknown", () => {
    const { unmount } = render(
      <ProposalCard {...BASE_PROPS} proposal={makeProposal()} roleLevel={ROLE.CONTRIBUTOR} />,
    )
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled()
    unmount()
    render(<ProposalCard {...BASE_PROPS} proposal={makeProposal()} roleLevel={null} />)
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled()
  })
})

describe("apply / discard", () => {
  it("Apply pushes the staged events through the write path with the ai payload intact, then shows applied", async () => {
    const onApplied = vi.fn()
    const proposal = makeProposal()
    render(<ProposalCard {...BASE_PROPS} proposal={proposal} onApplied={onApplied} />)

    fireEvent.click(screen.getByRole("button", { name: "Apply" }))

    await waitFor(() => expect(screen.getByText("Applied")).toBeInTheDocument())
    expect(mockApply).toHaveBeenCalledTimes(1)
    const [events, ctx] = mockApply.mock.calls[0]
    expect(events).toBe(proposal.events)
    expect(events[0].payload).toEqual({
      value: "drafted gloria text",
      ai_suggestion: true,
      agent_run_id: "run-1",
    })
    expect(ctx.projectId).toBe("proj-1")
    expect(ctx.author).toBe("anna")
    expect(onApplied).toHaveBeenCalledWith(["evt-1"], ["c-1"])
    // Action buttons are gone in the applied state.
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument()
  })

  it("a failed apply surfaces the error and returns to idle (retryable)", async () => {
    mockApply.mockRejectedValueOnce(new Error("role 300 below required 400"))
    render(<ProposalCard {...BASE_PROPS} proposal={makeProposal()} />)
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() =>
      expect(screen.getByText(/Apply failed: role 300 below required 400/)).toBeInTheDocument(),
    )
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled()
  })

  it("Discard collapses the card without touching the write path", () => {
    render(<ProposalCard {...BASE_PROPS} proposal={makeProposal()} />)
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(screen.getByText(/Discarded: Draft 1 cell in MRK 4/)).toBeInTheDocument()
    expect(mockApply).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument()
  })
})
