import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SourceSelectionToolbar } from "./SourceSelectionToolbar"

const noConcepts = { concepts: [], onTermApply: vi.fn() }

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
    expect(screen.getByRole("checkbox", { name: /case insensitive/i })).toBeChecked()
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
})
