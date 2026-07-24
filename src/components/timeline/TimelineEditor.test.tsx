import { describe, it, expect } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
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

  // ── SUB-12: ⌘/ctrl-wheel zoom on the scroll container ─────────────────────

  it("ctrl+wheel zooms in/out and clamps; plain wheel does not zoom", async () => {
    render(
      <TimelineEditor
        fileId="wheelfile"
        coreMediaUrl={null}
        editable
        cells={[cell({ id: "d1", original: "x", medium: "media", startTime: 0, endTime: 2 })]}
        onRetime={() => {}}
        onCommitTarget={() => {}}
      />,
    )
    const scroll = screen.getByTestId("tl-scroll")
    const width = () => parseFloat(screen.getByTestId("tl-card-d1").style.width)
    // happy-dom's synthesized WheelEvent doesn't carry modifier keys, so build
    // the event by hand — same shape the native listener sees in a browser.
    const sendWheel = (init: { deltaY: number; ctrlKey?: boolean; metaKey?: boolean }) => {
      const ev = new Event("wheel", { bubbles: true, cancelable: true })
      Object.assign(ev, { clientX: 0, ...init })
      fireEvent(scroll, ev)
    }

    const before = width()
    // Plain wheel: scroll, not zoom.
    sendWheel({ deltaY: -100 })
    expect(width()).toBe(before)

    // ctrl+wheel up = zoom in (cards widen). The zoom eases toward its target
    // over rAF frames, so assertions wait for the glide to make progress.
    sendWheel({ deltaY: -100, ctrlKey: true })
    const zoomedIn = width()
    expect(zoomedIn).toBeGreaterThan(before)

    // meta+wheel down = zoom out (applied by the glide loop).
    sendWheel({ deltaY: 100, metaKey: true })
    await waitFor(() => expect(width()).toBeLessThan(zoomedIn))

    // Clamp: hammering zoom-out bottoms out at ZOOM_MIN instead of vanishing.
    for (let i = 0; i < 40; i++) sendWheel({ deltaY: 100, ctrlKey: true })
    await waitFor(() => expect(width()).toBeGreaterThan(0))
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
