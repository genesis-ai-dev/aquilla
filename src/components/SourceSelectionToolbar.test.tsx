import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SourceSelectionToolbar } from "./SourceSelectionToolbar"

const noConcepts = { concepts: [], onTermApply: vi.fn() }

describe("SourceSelectionToolbar", () => {
  it("renders Ask AI and Add to terms with labels", () => {
    render(
      <SourceSelectionToolbar
        sourceSelection="grace"
        onAskAi={vi.fn()}
        onAddToTermbase={vi.fn()}
        {...noConcepts}
      />,
    )
    expect(screen.getByRole("button", { name: /ask ai/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /add to terms/i })).toBeInTheDocument()
  })

  it("fires onAskAi on click", () => {
    const onAskAi = vi.fn()
    render(
      <SourceSelectionToolbar sourceSelection="grace" onAskAi={onAskAi} onAddToTermbase={vi.fn()} {...noConcepts} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /ask ai/i }))
    expect(onAskAi).toHaveBeenCalledOnce()
  })

  it("hides Add to terms when no callback is wired but always shows Ask AI", () => {
    render(<SourceSelectionToolbar sourceSelection="grace" onAskAi={vi.fn()} {...noConcepts} />)
    expect(screen.queryByRole("button", { name: /add to terms/i })).not.toBeInTheDocument()
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
})
