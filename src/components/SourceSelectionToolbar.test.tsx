import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SourceSelectionToolbar } from "./SourceSelectionToolbar"
import type { Concept } from "@/lib/terminology/types"

const noConcepts = { concepts: [] }

const MATCHING_CONCEPT: Concept = {
  id: "c1",
  sourceTerm: "grace",
  renderings: [
    { rendering: "gracia", status: "preferred" },
    { rendering: "favor", status: "admitted" },
    { rendering: "suerte", status: "forbidden" },
  ],
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

  // ── AQU-1102: the toolbar's term lookup is read-only ──────────────────────
  //
  // A source selection means the target cell has no selection, so an Apply
  // button here could only ever write the rendering into a target the
  // translator never touched. The affordance must not exist.

  it("opens the term lookup read-only — renderings listed, no Apply buttons", () => {
    render(
      <SourceSelectionToolbar
        sourceSelection="grace"
        concepts={[MATCHING_CONCEPT]}
        onAskAi={vi.fn()}
        onAddToTermbase={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /view term/i }))

    expect(screen.getByText("gracia")).toBeInTheDocument()
    expect(screen.getByText("favor")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Apply rendering/i })).not.toBeInTheDocument()
  })
})
