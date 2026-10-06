// DecisionCard (seam design §4.3, §4.6).
// WHY these tests: the card's whole job is to be worth interrupting for. It
// must state WHY it exists (not "review this") and it must show blast radius,
// because "this affects six later passages" is what makes the question
// answerable rather than merely annoying. Dismiss must be as easy as answer —
// dismissal rate is a designed signal, so the UI must not discourage it.

import { render as rtlRender, screen } from "@testing-library/react"
import type { ReactElement } from "react"
import { MemoryRouter } from "react-router-dom"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi } from "vitest"
import { DecisionCard } from "./DecisionCard"
import type { ContextualDecisionView } from "@/lib/contextual/transport"

vi.mock("@/lib/contextual/transport", async (orig) => ({
  ...(await orig<typeof import("@/lib/contextual/transport")>()),
  actOnContextualDecision: vi.fn().mockResolvedValue(undefined),
}))

// The card now carries a "where does this apply" line that reads cells; these
// tests are about the question itself, so that read is stubbed out.
vi.mock("@/lib/contextual/decision-context", () => ({
  loadDecisionPlace: vi.fn(() => new Promise(() => {})),
  loadDecisionSurroundings: vi.fn(),
}))

const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>)

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

  it("disables Answer on an empty or whitespace-only textarea, and enables it once text is entered", async () => {
    render(<DecisionCard decision={decision} projectId="p1" onResolved={() => {}} />)
    const answerButton = screen.getByRole("button", { name: /answer/i })
    expect(answerButton).toBeDisabled()

    await userEvent.type(screen.getByRole("textbox"), "   ")
    expect(answerButton).toBeDisabled()

    await userEvent.type(screen.getByRole("textbox"), "Use 'council'")
    expect(answerButton).not.toBeDisabled()

    // Dismiss must never be gated the same way — it always has something to do.
    expect(screen.getByRole("button", { name: /not needed/i })).not.toBeDisabled()
  })

  it("offers dismiss as a first-class action", async () => {
    const { actOnContextualDecision } = await import("@/lib/contextual/transport")
    vi.mocked(actOnContextualDecision).mockClear()
    render(<DecisionCard decision={decision} projectId="p1" onResolved={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: /not needed/i }))
    expect(actOnContextualDecision).toHaveBeenCalledWith("p1", "d1", "dismiss", {})
  })

  it("shows an error and re-enables the buttons when the submit fails — a silent failure would look like a recorded answer", async () => {
    const { actOnContextualDecision } = await import("@/lib/contextual/transport")
    vi.mocked(actOnContextualDecision).mockClear()
    vi.mocked(actOnContextualDecision).mockRejectedValueOnce(new Error("network error"))
    const onResolved = vi.fn()
    render(<DecisionCard decision={decision} projectId="p1" onResolved={onResolved} />)

    await userEvent.type(screen.getByRole("textbox"), "Use 'council'")
    await userEvent.click(screen.getByRole("button", { name: /answer/i }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t be saved/i)
    expect(onResolved).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: /answer/i })).not.toBeDisabled()
    expect(screen.getByRole("button", { name: /not needed/i })).not.toBeDisabled()
  })
})

// AQU-1691: a fact question's answer is kept as a project decision. The card
// must make answering one click when the question offers options, must not
// invent a "where" line for a question that belongs to no file, and must say
// WHY an answer was refused instead of a generic failure.
describe("DecisionCard — fact questions", () => {
  const kin: ContextualDecisionView = {
    ...decision,
    id: "d2",
    fileId: null,
    cellIds: [],
    reason: "Is Andrew older or younger than Peter?",
    readinessItem: "bible-fact",
    blastRadius: 0,
    factKey: "kin.andrew-peter.relative-age",
    options: [{ value: "younger", label: "Andrew is younger" }, { value: "older" }],
  }
  const measures: ContextualDecisionView = {
    ...kin,
    id: "d3",
    reason: "How should measures be rendered?",
    factKey: "measures",
    options: [{ value: "convert" }, { value: "transliterate" }],
  }

  it("answers with one click on an option, and says the answer is kept", async () => {
    const { actOnContextualDecision } = await import("@/lib/contextual/transport")
    vi.mocked(actOnContextualDecision).mockClear()
    const onResolved = vi.fn()
    render(<DecisionCard decision={kin} projectId="p1" onResolved={onResolved} />)
    expect(screen.getByText(/becomes a project decision/)).toBeInTheDocument()
    expect(screen.queryByTestId("decision-context")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Andrew is younger" }))
    expect(actOnContextualDecision).toHaveBeenCalledWith("p1", "d2", "answer", { answer: "younger" })
    expect(onResolved).toHaveBeenCalled()
  })

  it("keeps a free-text answer for a free-form fact", () => {
    render(<DecisionCard decision={kin} projectId="p1" onResolved={() => {}} />)
    expect(screen.getByPlaceholderText("Or write your own answer")).toBeInTheDocument()
  })

  it("offers only the options for a Language-profile slot, labelled in the reader's language", () => {
    render(<DecisionCard decision={measures} projectId="p1" onResolved={() => {}} />)
    expect(screen.getByRole("button", { name: "Convert to local units" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Keep the original unit" })).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("explains a 403 on a profile question as the maintainer floor", async () => {
    const transport = await import("@/lib/contextual/transport")
    vi.mocked(transport.actOnContextualDecision).mockRejectedValueOnce(new transport.ContextualApiError("denied", 403))
    render(<DecisionCard decision={measures} projectId="p1" onResolved={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: "Convert to local units" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/Only a maintainer can answer this question/)
  })

  it("explains a refused answer by its reason code, and stays answerable", async () => {
    const transport = await import("@/lib/contextual/transport")
    vi.mocked(transport.actOnContextualDecision).mockRejectedValueOnce(
      new transport.ContextualApiError("bad", 400, "profile-value-invalid"),
    )
    render(<DecisionCard decision={measures} projectId="p1" onResolved={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: "Keep the original unit" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/doesn.t fit the Language profile/)
    expect(screen.getByRole("button", { name: "Keep the original unit" })).not.toBeDisabled()
  })
})
