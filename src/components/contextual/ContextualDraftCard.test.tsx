// The in-cell draft card. WHY: this component is the entire visible surface of
// autopilot's output, and it sits on the boundary between "the agent proposes"
// and "a person commits". Three things must hold or the trust model breaks:
//
//   1. Accepting hands the text to the CALLER's commit path — never a private
//      write — so an accepted draft is subject to every guard a typed edit is.
//   2. A viewer (no edit rights) can see the work but cannot accept it.
//   3. The decision clears the card immediately; the server call is a report,
//      and a card that lingers after a click reads as a broken button.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { ContextualDraftCard } from "./ContextualDraftCard"
import {
  hydrateContextualDrafts,
  getContextualDraftsSummary,
  resetContextualDraftsStore,
} from "@/lib/contextual/drafts-store"

const reviewMock = vi.fn(async () => {})
vi.mock("@/lib/contextual/transport", () => ({
  reviewContextualDraft: (...args: unknown[]) => reviewMock(...(args as [])),
}))

beforeEach(() => {
  cleanup()
  resetContextualDraftsStore()
  reviewMock.mockClear()
  reviewMock.mockResolvedValue(undefined)
})

function seed(text = "En el principio era el Verbo") {
  hydrateContextualDrafts("file-1", [{ draftId: "d1", cellId: "c1", text }])
}

function renderCard(overrides: Partial<Parameters<typeof ContextualDraftCard>[0]> = {}) {
  const onAccept = vi.fn()
  render(
    <ContextualDraftCard
      cellId="c1"
      projectId="p1"
      editable
      onAccept={onAccept}
      {...overrides}
    />,
  )
  return { onAccept }
}

describe("ContextualDraftCard", () => {
  it("renders nothing when the cell has no pending draft", () => {
    hydrateContextualDrafts("file-1", [])
    renderCard()
    expect(screen.queryByTestId("contextual-draft-card")).toBeNull()
  })

  it("shows the drafted text for its own cell", () => {
    seed()
    renderCard()
    expect(screen.getByTestId("contextual-draft-text").textContent).toBe(
      "En el principio era el Verbo",
    )
  })

  it("hands accepted text to the caller's commit path, not a private write", () => {
    seed("texto aceptado")
    const { onAccept } = renderCard()
    fireEvent.click(screen.getByLabelText("Use this translation"))
    expect(onAccept).toHaveBeenCalledWith("texto aceptado")
  })

  it("clears the card immediately on accept and counts it", () => {
    seed()
    renderCard()
    fireEvent.click(screen.getByLabelText("Use this translation"))
    expect(screen.queryByTestId("contextual-draft-card")).toBeNull()
    expect(getContextualDraftsSummary()).toMatchObject({
      pending: 0,
      acceptedThisSession: 1,
    })
  })

  it("dismisses without committing anything", () => {
    seed()
    const { onAccept } = renderCard()
    fireEvent.click(screen.getByLabelText("Dismiss this suggestion"))
    expect(onAccept).not.toHaveBeenCalled()
    expect(getContextualDraftsSummary()).toMatchObject({
      pending: 0,
      rejectedThisSession: 1,
    })
  })

  it("reports the decision to the server as applied or rejected", () => {
    seed()
    renderCard()
    fireEvent.click(screen.getByLabelText("Use this translation"))
    expect(reviewMock).toHaveBeenCalledWith("p1", "d1", "applied")
  })

  it("keeps the user's edit even when the server report fails", async () => {
    reviewMock.mockRejectedValue(new Error("offline"))
    seed()
    const { onAccept } = renderCard()
    fireEvent.click(screen.getByLabelText("Use this translation"))
    // The commit already went through the outbox; bookkeeping is not a gate.
    expect(onAccept).toHaveBeenCalled()
    expect(screen.queryByTestId("contextual-draft-card")).toBeNull()
    await Promise.resolve()
  })

  it("lets a viewer see the draft but never accept it", () => {
    seed()
    renderCard({ editable: false })
    expect(screen.getByTestId("contextual-draft-text")).toBeTruthy()
    expect(screen.queryByLabelText("Use this translation")).toBeNull()
    // Dismissing a suggestion from your own view is not an edit.
    expect(screen.getByLabelText("Dismiss this suggestion")).toBeTruthy()
  })

  it("ignores a second click while the first decision is settling", () => {
    seed()
    const { onAccept } = renderCard()
    const button = screen.getByLabelText("Use this translation")
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onAccept).toHaveBeenCalledTimes(1)
  })
})
