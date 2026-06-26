import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TimelineCellDetail } from "./TimelineCellDetail"
import type { CellData } from "@/hooks/useCells"

const cell = (o: Partial<CellData>): CellData =>
  ({ id: "c1", fileId: "f1", original: "", translated: "", medium: "media", ...o }) as unknown as CellData

describe("TimelineCellDetail", () => {
  it("shows the selected clip's source text", () => {
    render(
      <TimelineCellDetail
        cell={cell({ original: "Go get the man", startTime: 1, endTime: 3 })}
        editable
        onCommitTarget={() => {}}
      />,
    )
    expect(screen.getByTestId("tl-detail-source")).toHaveTextContent("Go get the man")
  })

  it("commits the target on blur when it changed", () => {
    const onCommit = vi.fn()
    render(<TimelineCellDetail cell={cell({ id: "x9", translated: "" })} editable onCommitTarget={onCommit} />)
    const ta = screen.getByTestId("tl-detail-target")
    fireEvent.change(ta, { target: { value: "Hola" } })
    fireEvent.blur(ta)
    expect(onCommit).toHaveBeenCalledWith("x9", "Hola")
  })

  it("does not commit when unchanged", () => {
    const onCommit = vi.fn()
    render(<TimelineCellDetail cell={cell({ translated: "same" })} editable onCommitTarget={onCommit} />)
    fireEvent.blur(screen.getByTestId("tl-detail-target"))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("renders an empty state with no selection", () => {
    render(<TimelineCellDetail cell={null} editable onCommitTarget={() => {}} />)
    expect(screen.getByTestId("tl-detail-empty")).toBeInTheDocument()
  })
})
