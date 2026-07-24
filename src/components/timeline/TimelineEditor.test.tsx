import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TimelineEditor } from "./TimelineEditor"
import type { CellData } from "@/hooks/useCells"
import type { QueueState, QueueProgress } from "@/lib/audio/play-queue"

// AQU-646: the editor subscribes to the play-queue (read-only) for playhead
// tracking. Mock the two hooks with mutable stubs so tests can simulate
// playback without any Audio element.
let mockQueueState: QueueState = { kind: "idle" }
let mockProgress: QueueProgress = { currentTime: 0, duration: 0, rate: 1, volume: 1 }
vi.mock("@/lib/audio/play-queue", () => ({
  useQueueState: () => mockQueueState,
  useQueueProgress: () => mockProgress,
}))
// The detail pane's audio components need session/query providers — out of
// scope here (covered by TimelineCellDetail.test.tsx with the same mocks).
vi.mock("@/components/CellTtsButton", () => ({
  CellTtsButton: () => <button type="button" data-testid="mock-tts" />,
}))
vi.mock("@/components/CellAudioUploadButton", () => ({
  CellAudioUploadButton: () => <button type="button" data-testid="mock-upload" />,
}))

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

  // ── AQU-646: playhead follows the audio queue; clicks navigate playback ──

  const mediaCells = [
    cell({ id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10 }),
    cell({ id: "m2", original: "Two", medium: "media", startTime: 10, endTime: 20 }),
  ]

  it("the playhead tracks queue progress for THIS file's cells", () => {
    mockQueueState = { kind: "playing", cellIndex: 1, cellId: "m2" }
    mockProgress = { currentTime: 12, duration: 20, rate: 1, volume: 1 }
    try {
      render(
        <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetime={() => {}} onCommitTarget={() => {}} />,
      )
      const playhead = screen.getByTestId("tl-playhead")
      // 12s at the default 38 px/s zoom.
      expect(parseFloat(playhead.style.left)).toBeCloseTo(12 * 38, 0)
    } finally {
      mockQueueState = { kind: "idle" }
      mockProgress = { currentTime: 0, duration: 0, rate: 1, volume: 1 }
    }
  })

  it("a queue playing ANOTHER file's cells does not move this playhead", () => {
    mockQueueState = { kind: "playing", cellIndex: 0, cellId: "other-file-cell" }
    mockProgress = { currentTime: 12, duration: 20, rate: 1, volume: 1 }
    try {
      render(
        <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetime={() => {}} onCommitTarget={() => {}} />,
      )
      expect(parseFloat(screen.getByTestId("tl-playhead").style.left)).toBe(0)
    } finally {
      mockQueueState = { kind: "idle" }
      mockProgress = { currentTime: 0, duration: 0, rate: 1, volume: 1 }
    }
  })

  it("a clean card click seeks playback to the clip start AND opens the detail pane", () => {
    const onSeekToTime = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetime={() => {}} onCommitTarget={() => {}} onSeekToTime={onSeekToTime}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-card-m2"))
    expect(onSeekToTime).toHaveBeenCalledWith(10)
    expect(screen.getByTestId("tl-detail-source")).toHaveTextContent("Two")
  })

  it("an untimed chip selects but never seeks", () => {
    const onSeekToTime = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={[...mediaCells, cell({ id: "u1", original: "Untimed", medium: "text" })]}
        onRetime={() => {}} onCommitTarget={() => {}} onSeekToTime={onSeekToTime}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-untimed-u1"))
    expect(onSeekToTime).not.toHaveBeenCalled()
    expect(screen.getByTestId("tl-detail-source")).toHaveTextContent("Untimed")
  })

  it("renders the follow toggle, pressed by default, and it toggles", () => {
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetime={() => {}} onCommitTarget={() => {}} />,
    )
    const btn = screen.getByLabelText("Follow playhead")
    expect(btn).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(btn)
    expect(btn).toHaveAttribute("aria-pressed", "false")
  })

  // ── AQU-646 round 3: text→media trace seed + media→text selection mirror ──

  it("initialSelectedCellId opens the detail pane and cues playback at the clip start", () => {
    const onSeekToTime = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetime={() => {}} onCommitTarget={() => {}}
        onSeekToTime={onSeekToTime} initialSelectedCellId="m2"
      />,
    )
    expect(screen.getByTestId("tl-detail-source")).toHaveTextContent("Two")
    expect(onSeekToTime).toHaveBeenCalledWith(10)
  })

  it("onSelectedCellChange mirrors the seed on mount and card clicks after", () => {
    const onSelectedCellChange = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetime={() => {}} onCommitTarget={() => {}}
        initialSelectedCellId="m1" onSelectedCellChange={onSelectedCellChange}
      />,
    )
    expect(onSelectedCellChange).toHaveBeenCalledWith("m1")
    fireEvent.click(screen.getByTestId("tl-card-m2"))
    expect(onSelectedCellChange).toHaveBeenLastCalledWith("m2")
  })

  it("passes detailActions through to the detail pane", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetime={() => {}} onCommitTarget={() => {}}
        initialSelectedCellId="m1"
        detailActions={{
          isCompletionConfigured: true, isCompletionAvailable: true, isAnonymous: false,
          completing: new Map(), previews: new Map(),
          onCompleteSingle: async () => {}, onAiSetupNeeded: () => {},
          onOpenComments: () => {}, onOpenHistory: () => {}, onOpenRecording: () => {},
          projectId: "p1", username: "tester",
        }}
      />,
    )
    expect(screen.getByTestId("tl-detail-actions")).toBeInTheDocument()
  })
})
