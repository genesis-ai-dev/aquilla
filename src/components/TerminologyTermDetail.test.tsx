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
