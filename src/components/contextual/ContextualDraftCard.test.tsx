// The in-cell draft card. WHY: this component is the entire visible surface of
// autopilot's output, and it sits on the boundary between "the agent proposes"
// and "a person commits". Three things must hold or the trust model breaks:
//
//   1. Accepting hands the text to the CALLER's commit path — never a private
//      write — so an accepted draft is subject to every guard a typed edit is.
//   2. A viewer (no edit rights) can see the work but cannot accept it.
//   3. Acceptance is resolved only by the winning target projection; an IDB
//      enqueue never calls `/review(applied)` prematurely. Rejection remains
//      route-backed and retryable.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react"
import { ContextualDraftCard } from "./ContextualDraftCard"
import {
  applyContextualDraftsFrame,
  attachContextualDrafts,
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
  const scope = attachContextualDrafts("p1", "file-1", "")
  hydrateContextualDrafts(scope, [
    { draftId: "d1", cellId: "c1", text },
  ])
  return scope
}

function renderCard(overrides: Partial<Parameters<typeof ContextualDraftCard>[0]> = {}) {
  const onAccept = vi.fn(async () => true)
  render(
    <ContextualDraftCard
      cellId="c1"
      projectId="p1"
      fileId="file-1"
      targetLang=""
      editable
      onAccept={onAccept}
      {...overrides}
    />,
  )
  return { onAccept }
}

describe("ContextualDraftCard", () => {
  it("renders nothing when the cell has no pending draft", () => {
    hydrateContextualDrafts(attachContextualDrafts("p1", "file-1", ""), [])
    renderCard()
    expect(screen.queryByTestId("contextual-draft-card")).toBeNull()
  })

  it("never exposes cropped live text while authoritative draft truth is refetched", () => {
    attachContextualDrafts("p1", "file-1", "")
    const result = applyContextualDraftsFrame("p1", {
      type: "contextual.drafts",
      runId: "run-current",
      fileId: "file-1",
      targetLang: "",
      spanLabel: "LUK 1:1",
      drafts: [{ draftId: "d-long", cellId: "c1", text: "cropped…" }],
      truncated: true,
    }, "run-current")

    renderCard()

    expect(result.needsRefetch).toBe(true)
    expect(screen.queryByText("cropped…")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Use this translation" })).not.toBeInTheDocument()
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

  it("keeps acceptance projection-authoritative until the applied-event refresh", async () => {
    const scope = seed()
    const { onAccept } = renderCard()
    fireEvent.click(screen.getByLabelText("Use this translation"))

    await vi.waitFor(() => expect(onAccept).toHaveBeenCalledOnce())
    expect(reviewMock).not.toHaveBeenCalled()
    expect(screen.getByTestId("contextual-draft-card")).toBeInTheDocument()
    expect(getContextualDraftsSummary()).toMatchObject({
      pending: 1,
      acceptedThisSession: 0,
    })

    // ProjectWorkspace performs this authoritative hydrate only after the
    // server broadcasts event.applied for the winning target projection.
    act(() => { hydrateContextualDrafts(scope, []) })
    expect(screen.queryByTestId("contextual-draft-card")).toBeNull()
    expect(getContextualDraftsSummary()).toMatchObject({ pending: 0 })
  })

  it("dismisses without committing anything", async () => {
    seed()
    const { onAccept } = renderCard()
    fireEvent.click(screen.getByLabelText("Dismiss this suggestion"))
    expect(onAccept).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(screen.queryByTestId("contextual-draft-card")).toBeNull())
    expect(getContextualDraftsSummary()).toMatchObject({
      pending: 0,
      rejectedThisSession: 1,
    })
  })

  it("never reports an enqueue as applied, while rejection remains route-backed", async () => {
    seed()
    const { onAccept } = renderCard()
    fireEvent.click(screen.getByLabelText("Use this translation"))
    await vi.waitFor(() => expect(onAccept).toHaveBeenCalledOnce())
    expect(reviewMock).not.toHaveBeenCalled()

    cleanup()
    seed()
    renderCard()
    fireEvent.click(screen.getByLabelText("Dismiss this suggestion"))
    await vi.waitFor(() => expect(reviewMock).toHaveBeenCalledWith("p1", "d1", "rejected"))
  })

  it("does not make acceptance depend on the review endpoint", async () => {
    reviewMock.mockRejectedValue(new Error("offline"))
    seed()
    const { onAccept } = renderCard()
    fireEvent.click(screen.getByLabelText("Use this translation"))

    await vi.waitFor(() => expect(onAccept).toHaveBeenCalledOnce())
    expect(reviewMock).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByTestId("contextual-draft-card")).toBeInTheDocument()
  })

  it("keeps a failed rejection visible until the server acknowledges it", async () => {
    reviewMock.mockRejectedValueOnce(new Error("offline"))
    seed()
    const { onAccept } = renderCard()
    fireEvent.click(screen.getByLabelText("Dismiss this suggestion"))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This suggestion couldn’t be dismissed. Retry.",
    )
    expect(getContextualDraftsSummary()).toMatchObject({ pending: 1, rejectedThisSession: 0 })
    expect(onAccept).not.toHaveBeenCalled()

    reviewMock.mockResolvedValue(undefined)
    fireEvent.click(screen.getByLabelText("Dismiss this suggestion"))
    await vi.waitFor(() => expect(screen.queryByTestId("contextual-draft-card")).toBeNull())
    expect(getContextualDraftsSummary()).toMatchObject({ pending: 0, rejectedThisSession: 1 })
  })

  it("lets a viewer see the draft but never accept it", () => {
    seed()
    renderCard({ editable: false })
    expect(screen.getByTestId("contextual-draft-text")).toBeTruthy()
    expect(screen.queryByLabelText("Use this translation")).toBeNull()
    expect(screen.queryByLabelText("Dismiss this suggestion")).toBeNull()
  })

  it("ignores a second click while the first decision is settling", async () => {
    let confirmCommit!: (saved: boolean) => void
    const onAccept = vi.fn(() => new Promise<boolean>((resolve) => { confirmCommit = resolve }))
    seed()
    renderCard({ onAccept })
    const button = screen.getByLabelText("Use this translation")
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onAccept).toHaveBeenCalledTimes(1)
    await act(async () => { confirmCommit(false) })
  })

  it("keeps the proposal and never reports applied when the normal commit path refuses it", async () => {
    seed("must remain reviewable")
    const onAccept = vi.fn(async () => false)
    renderCard({ onAccept })

    fireEvent.click(screen.getByLabelText("Use this translation"))

    await vi.waitFor(() => expect(screen.getByLabelText("Use this translation")).not.toBeDisabled())
    expect(screen.getByText("must remain reviewable")).toBeInTheDocument()
    expect(getContextualDraftsSummary()).toMatchObject({ pending: 1, acceptedThisSession: 0 })
    expect(reviewMock).not.toHaveBeenCalled()
  })

  it("leaves replacement draft B for the authoritative projection after a delayed save", async () => {
    let confirmCommit!: (saved: boolean) => void
    const onAccept = vi.fn(() => new Promise<boolean>((resolve) => { confirmCommit = resolve }))
    seed("draft A")
    renderCard({ onAccept })
    fireEvent.click(screen.getByLabelText("Use this translation"))

    hydrateContextualDrafts(attachContextualDrafts("p1", "file-1", ""), [
      { draftId: "draft-b", cellId: "c1", text: "draft B" },
    ])
    await act(async () => { confirmCommit(true) })

    expect(await screen.findByText("draft B")).toBeInTheDocument()
    expect(screen.getByLabelText("Use this translation")).not.toBeDisabled()
    expect(reviewMock).not.toHaveBeenCalled()
    expect(getContextualDraftsSummary()).toMatchObject({ pending: 1, acceptedThisSession: 0 })
  })

  it("never reports captured draft A after a successful save races a project scope switch", async () => {
    let confirmCommit!: (saved: boolean) => void
    const onAccept = vi.fn(() => new Promise<boolean>((resolve) => { confirmCommit = resolve }))
    seed("project A draft")
    renderCard({ onAccept })
    fireEvent.click(screen.getByLabelText("Use this translation"))

    attachContextualDrafts("p2", "file-1", "")
    await act(async () => { confirmCommit(true) })

    expect(screen.queryByTestId("contextual-draft-card")).toBeNull()
    expect(reviewMock).not.toHaveBeenCalled()
    expect(getContextualDraftsSummary()).toMatchObject({ projectId: "p2", pending: 0 })
  })

  it("never exposes or applies another project, file, or lane's draft", () => {
    seed("project A default text")

    const otherProject = renderCard({ projectId: "p2" })
    expect(screen.queryByTestId("contextual-draft-card")).toBeNull()
    expect(otherProject.onAccept).not.toHaveBeenCalled()
    cleanup()

    const otherFile = renderCard({ fileId: "file-2" })
    expect(screen.queryByTestId("contextual-draft-card")).toBeNull()
    expect(otherFile.onAccept).not.toHaveBeenCalled()
    cleanup()

    const multilingualLane = renderCard({ targetLang: "fr" })
    expect(screen.queryByTestId("contextual-draft-card")).toBeNull()
    expect(screen.queryByLabelText("Use this translation")).toBeNull()
    expect(multilingualLane.onAccept).not.toHaveBeenCalled()
    expect(reviewMock).not.toHaveBeenCalled()
  })

  it("shows and applies a draft that belongs to the open language lane", () => {
    hydrateContextualDrafts(attachContextualDrafts("p1", "file-1", "fr"), [
      { draftId: "d-fr", cellId: "c1", text: "Au commencement était la Parole" },
    ])
    const { onAccept } = renderCard({ targetLang: "fr" })

    expect(screen.getByTestId("contextual-draft-card")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Use this translation"))
    expect(onAccept).toHaveBeenCalledWith("Au commencement était la Parole")
  })
})
