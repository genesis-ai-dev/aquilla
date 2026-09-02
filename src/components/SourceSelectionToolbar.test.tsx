import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SourceSelectionToolbar } from "./SourceSelectionToolbar"
import type { Concept } from "@/lib/terminology/types"

const noConcepts = { concepts: [] }

const MATCHING_CONCEPT: Concept = {
  id: "concept-grace",
  sourceTerm: "grace",
  renderings: [{ rendering: "gracia", status: "preferred" }],
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
}

describe("SourceSelectionToolbar", () => {
  it("renders Ask AI and Add to termbase with labels", () => {
    render(
      <SourceSelectionToolbar
        sourceSelection="grace"
        onAskAi={vi.fn()}
        onAddToTermbase={vi.fn()}
        {...noConcepts}
      />,
    )
    expect(screen.getByRole("button", { name: /ask ai/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /add to termbase/i })).toBeInTheDocument()
  })

  it("fires onAskAi on click", () => {
    const onAskAi = vi.fn()
    render(
      <SourceSelectionToolbar sourceSelection="grace" onAskAi={onAskAi} onAddToTermbase={vi.fn()} {...noConcepts} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /ask ai/i }))
    expect(onAskAi).toHaveBeenCalledOnce()
  })

  it("hides Add to termbase when no callback is wired but always shows Ask AI", () => {
    render(<SourceSelectionToolbar sourceSelection="grace" onAskAi={vi.fn()} {...noConcepts} />)
    expect(screen.queryByRole("button", { name: /add to termbase/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /ask ai/i })).toBeInTheDocument()
  })

  it("calls the selection guard on button mousedown", () => {
    const onToolbarMouseDown = vi.fn()
    render(
      <SourceSelectionToolbar
        sourceSelection="grace" onAskAi={vi.fn()} onAddToTermbase={vi.fn()}
        onToolbarMouseDown={onToolbarMouseDown} {...noConcepts}
      />,
    )
    fireEvent.mouseDown(screen.getByRole("button", { name: /ask ai/i }))
    expect(onToolbarMouseDown).toHaveBeenCalled()
  })

  it("opens the matching terminology entry from the term lookup", () => {
    const onViewConcept = vi.fn()
    render(
      <SourceSelectionToolbar
        sourceSelection="grace"
        concepts={[MATCHING_CONCEPT]}
        onAskAi={vi.fn()}
        onViewConcept={onViewConcept}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /^View term$/i }))
    fireEvent.click(
      screen.getByRole("button", { name: /Go to Terminology page.*grace/i }),
    )

    expect(onViewConcept).toHaveBeenCalledWith("concept-grace")
  })
})
