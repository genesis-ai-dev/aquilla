/**
 * AlternativesCard (AQU-2398) — the pick-one contract.
 *
 * The thing this card exists to prevent is an apply-all over several wordings
 * of one cell: applyStagedEvents CHAINS commits to the same cell, so "apply"
 * would write every option and leave the last. So the tests that matter are
 * about what is NOT written — exactly one event reaches the write path, and
 * rejecting the card writes nothing at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { AgentProposal, StagedEvent } from "@/lib/agent/protocol"
import type { ApplyContext } from "@/lib/agent/apply"

const applyStagedEvent = vi.fn(async (_ev: StagedEvent, _ctx: ApplyContext) => "applied-event-id")
vi.mock("@/lib/agent/apply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/apply")>()),
  applyStagedEvent: (ev: StagedEvent, ctx: ApplyContext) => applyStagedEvent(ev, ctx),
}))

import { AlternativesCard } from "./AlternativesCard"
import { isAlternativesProposal, isValidationProposal } from "./registry"

function option(value: string, index: number, of: number): StagedEvent {
  return {
    kind: "target.cell.commit",
    fileId: "f1",
    cellId: "c1",
    parentId: "head-1",
    payload: {
      value,
      ai_suggestion: true,
      ai_draft: { mode: "agent", alternative: { index, of } },
    },
    display: { canonicalRef: "MRK 4:3", fileName: "Mark", before: "Oid", after: value },
  }
}

const proposal: AgentProposal = {
  proposalId: "p1",
  runId: "r1",
  summary: "3 wordings of MRK 4:3",
  alternatives: true,
  events: [
    option("¡Escuchad! Un sembrador salió a sembrar", 1, 3),
    option("¡Oíd! He aquí, el sembrador salió a sembrar", 2, 3),
    option("Presten atención: un sembrador fue a sembrar", 3, 3),
  ],
}

const ctx = { projectId: "p1", author: "alice" }

beforeEach(() => {
  applyStagedEvent.mockClear()
})

describe("AlternativesCard", () => {
  it("shows every wording together, with the cell's current text for comparison", () => {
    render(<AlternativesCard proposal={proposal} rules={[]} applyContext={ctx} />)
    for (const ev of proposal.events) {
      expect(screen.getByText(ev.display.after!)).toBeInTheDocument()
    }
    expect(screen.getByText("Oid")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /^Use option / })).toHaveLength(3)
    // There is no apply-all: that is the whole point of this card.
    expect(screen.queryByRole("button", { name: /^Apply$/i })).toBeNull()
  })

  it("writes ONLY the chosen wording — the others never reach the write path", async () => {
    const onApplied = vi.fn()
    render(<AlternativesCard proposal={proposal} rules={[]} applyContext={ctx} onApplied={onApplied} />)

    fireEvent.click(screen.getByRole("button", { name: "Use option 2" }))

    await waitFor(() => expect(applyStagedEvent).toHaveBeenCalledTimes(1))
    expect(applyStagedEvent.mock.calls[0][0]).toBe(proposal.events[1])
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(["applied-event-id"], ["c1"]))

    // Chosen is marked used, the rest are explicitly NOT used, and no further
    // pick is offered.
    expect(screen.getByText("Used")).toBeInTheDocument()
    expect(screen.getAllByText("Not used")).toHaveLength(2)
    expect(screen.queryByRole("button", { name: /^Use option / })).toBeNull()
    expect(screen.getByText(/did not pick were thrown away/i)).toBeInTheDocument()
  })

  it("stages no cell.validate — choosing a wording asserts nothing about quality", async () => {
    render(<AlternativesCard proposal={proposal} rules={[]} applyContext={ctx} />)
    fireEvent.click(screen.getByRole("button", { name: "Use option 1" }))
    await waitFor(() => expect(applyStagedEvent).toHaveBeenCalledTimes(1))
    expect(applyStagedEvent.mock.calls[0][0].kind).toBe("target.cell.commit")
  })

  it("writes nothing when the reader keeps none", () => {
    render(<AlternativesCard proposal={proposal} rules={[]} applyContext={ctx} />)
    fireEvent.click(screen.getByRole("button", { name: "Keep none" }))
    expect(applyStagedEvent).not.toHaveBeenCalled()
    expect(screen.getByText(/all of them were thrown away/i)).toBeInTheDocument()
  })

  it("offers no pick below the role floor, and says why", () => {
    render(
      <AlternativesCard
        proposal={proposal}
        rules={[]}
        applyContext={ctx}
        blockedReason="Requires Translator role or higher"
      />,
    )
    for (const btn of screen.getAllByRole("button", { name: /^Use option / })) {
      expect(btn).toBeDisabled()
    }
    expect(screen.getAllByText("Requires Translator role or higher").length).toBeGreaterThan(0)
  })

  it("keeps the card usable when the write fails, so another wording can be picked", async () => {
    applyStagedEvent.mockRejectedValueOnce(new Error("offline"))
    render(<AlternativesCard proposal={proposal} rules={[]} applyContext={ctx} />)
    fireEvent.click(screen.getByRole("button", { name: "Use option 3" }))
    // InlineAiError categorizes the raw message, so assert the failure is
    // announced and named, not the provider's own words.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Apply failed/i))
    expect(screen.getAllByRole("button", { name: /^Use option / })).toHaveLength(3)
    expect(screen.queryByText("Used")).toBeNull()
  })
})

describe("isAlternativesProposal", () => {
  it("accepts a flagged multi-wording proposal for one cell", () => {
    expect(isAlternativesProposal(proposal)).toBe(true)
    expect(isValidationProposal(proposal)).toBe(false)
  })

  it("never infers the shape without the server flag — several commits to one cell CHAIN", () => {
    expect(isAlternativesProposal({ ...proposal, alternatives: undefined })).toBe(false)
  })

  it("rejects a flagged proposal that is not in fact one cell's wordings", () => {
    // A mislabelled frame must not lose the other changes to the pick-one card.
    expect(
      isAlternativesProposal({
        ...proposal,
        events: [proposal.events[0], { ...proposal.events[1], cellId: "c2" }],
      }),
    ).toBe(false)
    expect(
      isAlternativesProposal({
        ...proposal,
        events: [proposal.events[0], { ...proposal.events[1], kind: "cell.validate" }],
      }),
    ).toBe(false)
    // One wording is not a choice.
    expect(isAlternativesProposal({ ...proposal, events: [proposal.events[0]] })).toBe(false)
  })
})
