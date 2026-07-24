import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TimelineEditor } from "./TimelineEditor"
import type { CellData } from "@/hooks/useCells"
import type { QueueState, QueueProgress } from "@/lib/audio/play-queue"

// AQU-646: the editor subscribes to the play-queue (read-only) for playhead
// tracking. Mock the two hooks with mutable stubs so tests can simulate
// playback without any Audio element.
let mockQueueState: QueueState = { kind: "idle" }
let mockProgress: QueueProgress = { currentTime: 0, duration: 0, rate: 1, volume: 1 }
// Round 5: the speaker buttons push audibility straight into the queue.
let lastAudibility: { source: boolean; target: boolean } | null = null
vi.mock("@/lib/audio/play-queue", () => ({
  useQueueState: () => mockQueueState,
  useQueueProgress: () => mockProgress,
  setQueueAudibility: (a: { source: boolean; target: boolean }) => {
    lastAudibility = a
  },
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

  // ── Round 5: Source/Target audio tracks + per-track speaker buttons ──

  const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
  const dubbedCells = [
    cell({
      id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10,
      selectedAudioId: SOURCE_ID,
      attachments: { [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" } },
    }),
    cell({
      id: "m2", original: "Two", medium: "media", startTime: 10, endTime: 20,
      selectedAudioId: "audio-m2-1700000000-take.webm",
      attachments: {
        "audio-m2-1700000000-take.webm": { type: "audio", url: "frontier-audio://take" },
        [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
      },
    }),
    cell({
      id: "m3", original: "Three", medium: "media", startTime: 20, endTime: 30,
      selectedAudioId: SOURCE_ID,
      selectedGeneratedVoiceAudioId: "audio-m3-1700000001-gen.wav",
      attachments: {
        [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
        "audio-m3-1700000001-gen.wav": { type: "audio", url: "frontier-audio://gen" },
      },
    }),
  ]

  it("renames the lane headers to Subtitles / Source audio / Target audio", () => {
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetime={() => {}} onCommitTarget={() => {}} />,
    )
    expect(screen.getByText("Subtitles")).toBeInTheDocument()
    expect(screen.getByText("Source audio")).toBeInTheDocument()
    expect(screen.getByText("Target audio")).toBeInTheDocument()
  })

  it("shows a Target-track chip only for sections with dub audio, kinded and positioned at the section", () => {
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={dubbedCells} onRetime={() => {}} onCommitTarget={() => {}} />,
    )
    // m1 has only the source clip — no chip.
    expect(screen.queryByTestId("tl-target-m1")).toBeNull()
    // m2 has a recorded take.
    const take = screen.getByTestId("tl-target-m2")
    expect(take).toHaveAttribute("data-kind", "take")
    expect(parseFloat(take.style.left)).toBeCloseTo(10 * 38, 0)
    expect(parseFloat(take.style.width)).toBeCloseTo(10 * 38, 0)
    // m3 has a generated voice.
    expect(screen.getByTestId("tl-target-m3")).toHaveAttribute("data-kind", "generated")
  })

  it("clicking a Target-track chip selects the section and seeks playback to it", () => {
    const onSeekToTime = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={dubbedCells}
        onRetime={() => {}} onCommitTarget={() => {}} onSeekToTime={onSeekToTime}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-target-m2"))
    expect(onSeekToTime).toHaveBeenCalledWith(10)
    expect(screen.getByTestId("tl-detail-source")).toHaveTextContent("Two")
  })

  it("speaker buttons start audible, push audibility into the queue, toggle, and persist per file", () => {
    localStorage.removeItem("codex:timelineAudibility:spkfile")
    lastAudibility = null
    render(
      <TimelineEditor fileId="spkfile" coreMediaUrl={null} editable cells={mediaCells} onRetime={() => {}} onCommitTarget={() => {}} />,
    )
    // Mount pushes the default (both audible).
    expect(lastAudibility).toEqual({ source: true, target: true })
    const src = screen.getByTestId("tl-speaker-source")
    const tgt = screen.getByTestId("tl-speaker-target")
    expect(src).toHaveAttribute("aria-pressed", "true")
    expect(tgt).toHaveAttribute("aria-pressed", "true")

    fireEvent.click(src)
    expect(src).toHaveAttribute("aria-pressed", "false")
    expect(lastAudibility).toEqual({ source: false, target: true })
    expect(JSON.parse(localStorage.getItem("codex:timelineAudibility:spkfile")!)).toEqual({ source: false, target: true })

    fireEvent.click(tgt)
    expect(lastAudibility).toEqual({ source: false, target: false })
  })

  it("a muted-source preference persists across mounts", () => {
    localStorage.setItem("codex:timelineAudibility:persistfile", JSON.stringify({ source: false, target: true }))
    lastAudibility = null
    render(
      <TimelineEditor fileId="persistfile" coreMediaUrl={null} editable cells={mediaCells} onRetime={() => {}} onCommitTarget={() => {}} />,
    )
    expect(screen.getByTestId("tl-speaker-source")).toHaveAttribute("aria-pressed", "false")
    expect(lastAudibility).toEqual({ source: false, target: true })
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
