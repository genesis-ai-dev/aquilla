/**
 * ValidationQueueCard — tier 2 "testimony" contract (agent-complete §3/§6):
 * each staged cell.validate needs its OWN human click; there is no
 * confirm-all; below the role floor the buttons are disabled.
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

import { ValidationQueueCard } from "./ValidationQueueCard"

const proposal: AgentProposal = {
  proposalId: "p1",
  runId: "r1",
  summary: "Validate 2 cells",
  events: [
    {
      kind: "cell.validate",
      fileId: "f1",
      cellId: "c1",
      payload: { editEventId: "e1" },
      display: { canonicalRef: "MRK 4:1", before: "Di nuovo insegnava" },
    },
    {
      kind: "cell.validate",
      fileId: "f1",
      cellId: "c2",
      payload: { editEventId: "e2" },
      display: { canonicalRef: "MRK 4:2", before: "E insegnava loro" },
    },
  ],
}

const ctx = { projectId: "p1", author: "alice" }

beforeEach(() => {
  applyStagedEvent.mockClear()
})

describe("ValidationQueueCard", () => {
  it("offers one Validate per row and NEVER a confirm-all", () => {
    render(<ValidationQueueCard proposal={proposal} applyContext={ctx} canValidate />)
    expect(screen.getAllByRole("button", { name: /^Validate / })).toHaveLength(2)
    expect(screen.queryByRole("button", { name: /all/i })).toBeNull()
    expect(screen.getByText(/confirm each line yourself/i)).toBeInTheDocument()
  })

  it("each click applies exactly that staged event and marks the row validated", async () => {
    const onApplied = vi.fn()
    render(<ValidationQueueCard proposal={proposal} applyContext={ctx} onApplied={onApplied} canValidate />)

    fireEvent.click(screen.getByRole("button", { name: "Validate MRK 4:1" }))
    await waitFor(() => expect(screen.getByText("validated")).toBeInTheDocument())

    expect(applyStagedEvent).toHaveBeenCalledTimes(1)
    expect(applyStagedEvent.mock.calls[0][0]).toMatchObject({ cellId: "c1", kind: "cell.validate" })
    expect(onApplied).toHaveBeenCalledWith(["applied-event-id"], ["c1"])
    // The second row still awaits its own click.
    expect(screen.getByRole("button", { name: "Validate MRK 4:2" })).toBeInTheDocument()
    expect(screen.getByText("1/2 confirmed")).toBeInTheDocument()
  })

  it("disables Validate below the role floor", () => {
    render(<ValidationQueueCard proposal={proposal} applyContext={ctx} canValidate={false} />)
    for (const btn of screen.getAllByRole("button", { name: /^Validate / })) {
      expect(btn).toBeDisabled()
    }
  })
})
