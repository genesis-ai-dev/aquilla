import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TerminologyTermDetail } from "./TerminologyTermDetail"
import type { Concept } from "@/lib/terminology/types"
import type { CellData } from "@/hooks/useCells"

const CONCEPT: Concept = {
  id: "c1",
  sourceTerm: "grace",
  renderings: [{ rendering: "favor", status: "preferred" }],
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
}

function cell(over: Partial<CellData> = {}): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: "by grace alone",
    translated: "por favor solo",
    context: "ROM 3:24",
    group: "ROM 3",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...over,
  }
}

function renderDetail(props: Partial<React.ComponentProps<typeof TerminologyTermDetail>> = {}) {
  return render(
    <TerminologyTermDetail
      concept={CONCEPT}
      cells={[]}
      canEdit
      projectId="p1"
      username="tester"
      onClose={vi.fn()}
      onCellCommitted={vi.fn()}
      onOptimisticEdit={vi.fn()}
      {...props}
    />,
  )
}

describe("TerminologyTermDetail", () => {
  it("renders the concept even while examples are still loading", () => {
    renderDetail({ examplesLoading: true })
    expect(screen.getByText("grace")).toBeInTheDocument()
    expect(screen.getAllByText("favor").length).toBeGreaterThan(0)
    expect(screen.getByText(/loading examples/i)).toBeInTheDocument()
    expect(screen.queryByText(/no occurrences/i)).not.toBeInTheDocument()
  })

  it("offers a jump control on each occurrence", () => {
    const onJumpToCell = vi.fn()
    renderDetail({ cells: [cell()], onJumpToCell })
    fireEvent.click(screen.getByRole("button", { name: /go to rom 3:24/i }))
    expect(onJumpToCell).toHaveBeenCalledWith({ cellId: "cell-1", fileId: "file-1" })
  })
})

// ── AQU-1006 follow-up: editable renderings ─────────────────────────────────
//
// The detail page could previously only ADD a rendering, and only by promoting
// a predicted equivalent. There was no way to remove one, and no way to change
// a rendering from required to forbidden without leaving for the edit dialog —
// which is why the termbase felt read-only in the 2026-09-04 walkthrough.
//
// Every edit hands back the WHOLE list, because that is what a `term.update`
// carries: renderings have no per-item id to merge on, so the projection
// replaces them wholesale.
describe("TerminologyTermDetail — editable renderings", () => {
  const TWO: Concept = {
    ...CONCEPT,
    renderings: [
      { rendering: "favor", status: "preferred" },
      { rendering: "gracia", status: "admitted" },
    ],
  }

  it("cycles a rendering's status and reports the full list", () => {
    const onRenderingsChange = vi.fn()
    renderDetail({ concept: TWO, canManageTermbase: true, onRenderingsChange })

    fireEvent.click(screen.getByRole("button", { name: /favor is .* change status/i }))

    expect(onRenderingsChange).toHaveBeenCalledWith("c1", [
      { rendering: "favor", status: "admitted" },
      // The untouched rendering must come back unchanged — a whole-list write
      // that dropped its siblings would be the very bug this work removed.
      { rendering: "gracia", status: "admitted" },
    ])
  })

  it("removes only the rendering asked for", () => {
    const onRenderingsChange = vi.fn()
    renderDetail({ concept: TWO, canManageTermbase: true, onRenderingsChange })

    fireEvent.click(screen.getByRole("button", { name: /remove rendering favor/i }))

    expect(onRenderingsChange).toHaveBeenCalledWith("c1", [
      { rendering: "gracia", status: "admitted" },
    ])
  })

  it("adds a new rendering as admitted, never demoting the agreed preferred one", () => {
    const onRenderingsChange = vi.fn()
    renderDetail({ concept: TWO, canManageTermbase: true, onRenderingsChange })

    fireEvent.change(screen.getByLabelText(/add a rendering to this term/i), {
      target: { value: "merced" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))

    expect(onRenderingsChange).toHaveBeenCalledWith("c1", [
      { rendering: "favor", status: "preferred" },
      { rendering: "gracia", status: "admitted" },
      { rendering: "merced", status: "admitted" },
    ])
  })

  it("ignores a duplicate rendering rather than writing it twice", () => {
    const onRenderingsChange = vi.fn()
    renderDetail({ concept: TWO, canManageTermbase: true, onRenderingsChange })

    fireEvent.change(screen.getByLabelText(/add a rendering to this term/i), {
      target: { value: "  GRACIA  " },
    })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))

    expect(onRenderingsChange).not.toHaveBeenCalled()
  })

  it("shows no editing affordances without termbase permission", () => {
    // Read-only is the default: the controls appear only for someone who may
    // actually manage the termbase, so nobody is offered an edit the server
    // would refuse.
    renderDetail({ concept: TWO, canManageTermbase: false, onRenderingsChange: vi.fn() })

    expect(screen.queryByLabelText(/add a rendering to this term/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /remove rendering/i })).not.toBeInTheDocument()
    // The renderings themselves are still shown (in the chip row, and again
    // in the EquivalentsPanel's managed list — hence getAllByText).
    expect(screen.getAllByText("favor").length).toBeGreaterThan(0)
  })
})
