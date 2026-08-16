// DecisionCard (seam design §4.3, §4.6).
// WHY these tests: the card's whole job is to be worth interrupting for. It
// must state WHY it exists (not "review this") and it must show blast radius,
// because "this affects six later passages" is what makes the question
// answerable rather than merely annoying. Dismiss must be as easy as answer —
// dismissal rate is a designed signal, so the UI must not discourage it.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi } from "vitest"
import { DecisionCard } from "./DecisionCard"
import type { ContextualDecisionView } from "@/lib/contextual/transport"

vi.mock("@/lib/contextual/transport", async (orig) => ({
  ...(await orig<typeof import("@/lib/contextual/transport")>()),
  actOnContextualDecision: vi.fn().mockResolvedValue(undefined),
}))

const decision: ContextualDecisionView = {
  id: "d1",
  fileId: "f1",
  cellIds: ["c1"],
  reason: "Two prior renderings of this name conflict.",
  readinessItem: "terminology",
  blastRadius: 6,
  status: "open",
  assignedUserId: null,
}

describe("DecisionCard", () => {
  it("shows the reason and the blast radius", () => {
    render(<DecisionCard decision={decision} projectId="p1" onResolved={() => {}} />)
    expect(screen.getByText(/Two prior renderings/)).toBeInTheDocument()
    expect(screen.getByText(/6/)).toBeInTheDocument()
  })

  it("submits an answer and notifies the parent", async () => {
    const { actOnContextualDecision } = await import("@/lib/contextual/transport")
    const onResolved = vi.fn()
    render(<DecisionCard decision={decision} projectId="p1" onResolved={onResolved} />)

    await userEvent.type(screen.getByRole("textbox"), "Use 'council'")
    await userEvent.click(screen.getByRole("button", { name: /answer/i }))

    expect(actOnContextualDecision).toHaveBeenCalledWith("p1", "d1", "answer", {
      answer: "Use 'council'",
    })
    expect(onResolved).toHaveBeenCalled()
  })

  it("will not submit an empty answer", async () => {
    const { actOnContextualDecision } = await import("@/lib/contextual/transport")
    vi.mocked(actOnContextualDecision).mockClear()
    render(<DecisionCard decision={decision} projectId="p1" onResolved={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: /answer/i }))
    expect(actOnContextualDecision).not.toHaveBeenCalled()
  })

  it("offers dismiss as a first-class action", async () => {
    const { actOnContextualDecision } = await import("@/lib/contextual/transport")
    vi.mocked(actOnContextualDecision).mockClear()
    render(<DecisionCard decision={decision} projectId="p1" onResolved={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: /not needed/i }))
    expect(actOnContextualDecision).toHaveBeenCalledWith("p1", "d1", "dismiss", {})
  })
})
