import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TimelineEditor } from "./TimelineEditor"
import type { CellData } from "@/hooks/useCells"

const cell = (o: Partial<CellData>): CellData =>
  ({ fileId: "f1", original: "", translated: "", ...o }) as unknown as CellData

describe("TimelineEditor", () => {
  it("renders subtitle + dialogue lanes and an untimed chip; selecting a card fills the detail pane", () => {
    render(
      <TimelineEditor
        fileId="f1"
        coreMediaUrl={null}
        editable
        cells={[
          cell({ id: "s1", original: "Sub line", medium: "text", startTime: 0, endTime: 2 }),
          cell({ id: "d1", original: "Dia line", medium: "media", startTime: 1, endTime: 4 }),
          cell({ id: "u1", original: "Untimed line", medium: "text" }), // no timing
        ]}
        onRetime={() => {}}
        onCommitTarget={() => {}}
      />,
    )
    expect(document.querySelector('[data-variant="subtitle"]')).toBeTruthy()
    expect(document.querySelector('[data-variant="dialogue"]')).toBeTruthy()
    expect(screen.getByTestId("tl-untimed-u1")).toBeInTheDocument()

    // Detail pane is empty until something is selected.
    expect(screen.getByTestId("tl-detail-empty")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("tl-card-d1"))
    expect(screen.getByTestId("tl-detail-source")).toHaveTextContent("Dia line")
  })

  it("zoom-in widens the cards", () => {
    render(
      <TimelineEditor
        fileId="zoomfile"
        coreMediaUrl={null}
        editable
        cells={[cell({ id: "d1", original: "x", medium: "media", startTime: 0, endTime: 2 })]}
        onRetime={() => {}}
        onCommitTarget={() => {}}
      />,
    )
    const before = parseFloat(screen.getByTestId("tl-card-d1").style.width)
    fireEvent.click(screen.getByLabelText("Zoom in"))
    const after = parseFloat(screen.getByTestId("tl-card-d1").style.width)
    expect(after).toBeGreaterThan(before)
  })

  it("shows the video preview only when a core media url is linked", () => {
    const { rerender } = render(
      <TimelineEditor fileId="f2" coreMediaUrl={null} editable cells={[]} onRetime={() => {}} onCommitTarget={() => {}} />,
    )
    expect(screen.queryByTestId("tl-video")).toBeNull()
    rerender(
      <TimelineEditor
        fileId="f2"
        coreMediaUrl="https://cdn/v.mp4"
        editable
        cells={[]}
        onRetime={() => {}}
        onCommitTarget={() => {}}
      />,
    )
    expect(screen.getByTestId("tl-video")).toBeInTheDocument()
  })
})
