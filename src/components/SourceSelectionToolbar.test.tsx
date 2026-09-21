import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SourceSelectionToolbar } from "./SourceSelectionToolbar"
import type { Concept } from "@/lib/terminology/types"
import {
  SOURCE_CELL_LAYERS,
  SOURCE_CELL_MENU_Z,
  SOURCE_SELECTION_RAIL_Z,
} from "@/lib/editor/source-cell-layers"

const noConcepts = { concepts: [] }

const MATCHING_CONCEPT: Concept = {
  id: "concept-grace",
  sourceTerm: "grace",
  renderings: [{ rendering: "gracia", status: "preferred" }],
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
}

describe("SourceSelectionToolbar", () => {
  it("renders Ask AI and Add to terminology with labels", () => {
    render(
      <SourceSelectionToolbar
        sourceSelection="grace"
        onAskAi={vi.fn()}
        onAddToTermbase={vi.fn()}
        {...noConcepts}
      />,
    )
    expect(screen.getByRole("button", { name: /ask ai/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /add to terminology/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /termbase/i })).not.toBeInTheDocument()
  })

  it("fires onAskAi on click", () => {
    const onAskAi = vi.fn()
    render(
      <SourceSelectionToolbar sourceSelection="grace" onAskAi={onAskAi} onAddToTermbase={vi.fn()} {...noConcepts} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /ask ai/i }))
    expect(onAskAi).toHaveBeenCalledOnce()
  })

  it("hides Add to terminology when no callback is wired but always shows Ask AI", () => {
    render(<SourceSelectionToolbar sourceSelection="grace" onAskAi={vi.fn()} {...noConcepts} />)
    expect(screen.queryByRole("button", { name: /add to terminology/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /ask ai/i })).toBeInTheDocument()
  })

  it("opens a popover pre-filled with the selected source term and a rendering field", async () => {
    render(
      <SourceSelectionToolbar
        sourceSelection="Holy Spirit"
        onAskAi={vi.fn()}
        onAddToTermbase={vi.fn()}
        {...noConcepts}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /add to terminology/i }))
    const sourceInput = await screen.findByLabelText(/source term for new concept/i)
    expect((sourceInput as HTMLInputElement).value).toBe("Holy Spirit")
    expect(screen.getByLabelText(/rendering for new concept/i)).toBeInTheDocument()
    // AQU-1271: case sensitivity moved into the collapsed "Matching options"
    // disclosure, stated positively — unchecked = the case-insensitive default.
    fireEvent.click(screen.getByRole("button", { name: /matching options/i }))
    expect(screen.getByRole("checkbox", { name: /match case exactly/i })).not.toBeChecked()
    expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull()
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

    const viewTerm = screen.getByRole("button", { name: /^View term$/i })
    fireEvent.mouseDown(viewTerm)
    fireEvent.mouseUp(viewTerm)
    fireEvent.click(viewTerm)
    fireEvent.click(
      screen.getByRole("button", { name: /Go to Terminology page.*grace/i }),
    )

    expect(onViewConcept).toHaveBeenCalledWith("concept-grace")
  })

  it("keeps View term a native button when Base UI composes the trigger", () => {
    render(
      <SourceSelectionToolbar
        sourceSelection="grace"
        concepts={[MATCHING_CONCEPT]}
        onAskAi={vi.fn()}
        onViewConcept={vi.fn()}
      />,
    )

    const viewTerm = screen.getByRole("button", { name: /^View term$/i })
    expect(viewTerm).not.toHaveAttribute("role")
  })

  // AQU-1134: the rail and the source cell menu trigger overlap in the source
  // cell's corner. Assert against the shared layer contract rather than a
  // literal class, so bumping one side without the other fails here.
  it("renders in front of the source edit control", () => {
    const { container } = render(
      <SourceSelectionToolbar
        sourceSelection="grace"
        concepts={[MATCHING_CONCEPT]}
        onAskAi={vi.fn()}
      />,
    )

    expect(container.firstElementChild).toHaveClass(SOURCE_SELECTION_RAIL_Z)
    expect(container.firstElementChild).not.toHaveClass(SOURCE_CELL_MENU_Z)
    expect(SOURCE_CELL_LAYERS.selectionRail).toBeGreaterThan(SOURCE_CELL_LAYERS.cellMenu)
  })
})
