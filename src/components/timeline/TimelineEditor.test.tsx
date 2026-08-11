import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"
import { TimelineEditor } from "./TimelineEditor"
import type { CellData } from "@/hooks/useCells"
import type { QueueState, QueueProgress } from "@/lib/audio/play-queue"
import { selectQueueForFile } from "@/lib/audio/queue-scope"
import { sourceClipAudioForCell } from "@/lib/audio/track-audio"
import { resetVideoDurationsForTests, setVideoDurationSec } from "@/lib/timeline/video-duration"

// AQU-646: the editor subscribes to the play-queue (read-only) for playhead
// tracking. Mock the two hooks with mutable stubs so tests can simulate
// playback without any Audio element.
let mockQueueState: QueueState = { kind: "idle" }
let mockProgress: QueueProgress = { currentTime: 0, duration: 0, rate: 1, volume: 1 }
// Round 5: the speaker buttons push audibility straight into the queue.
let lastAudibility: { source: boolean; target: boolean } | null = null
// Decision 2026-08-05: chips badge definitively-missing dubs.
const mockMissingCells: ReadonlySet<string> = new Set()
vi.mock("@/lib/audio/play-queue", () => ({
  useQueueState: () => mockQueueState,
  useQueueProgress: () => mockProgress,
  // Uses the REAL scoping rule (a side-effect-free module) so this stub cannot
  // drift from the guard that keeps one file's queue out of another's timeline.
  useQueueForFile: (cellIds: ReadonlySet<string>) =>
    selectQueueForFile(mockQueueState, mockProgress, cellIds),
  useMissingClipCells: () => mockMissingCells,
  MISSING_AUDIO_MESSAGE: "This clip's audio is missing.",
  // 2026-08-11: the editor gates its clock write on this. Built over the REAL
  // sourceClipAudioForCell (side-effect-free) for the same reason as
  // selectQueueForFile above — the part that decides whether a position is a
  // file position cannot be allowed to drift from the real rule.
  queueClockIsFileTime: (cell: CellData | undefined | null) =>
    cell?.medium === "media" && sourceClipAudioForCell(cell) != null,
  setQueueAudibility: (a: { source: boolean; target: boolean }) => {
    lastAudibility = a
  },
}))
// Round 7: the editor claims the app-wide audio shortcut while mounted.
const pushOverride = vi.fn()
const releaseOverride = vi.fn()
// SUB-52: the override is an ownership STACK now — the timeline stands down
// whenever something (the recording modal) has claimed on top of it. The mock
// mirrors that so the transport tests exercise the real guard.
const topOwner = vi.hoisted(() => ({ value: 1 as number | null }))
vi.mock("@/lib/audio/audio-coordinator", () => ({
  pushAudioShortcutOverride: () => {
    pushOverride()
    return Object.assign(releaseOverride, { owner: 1 })
  },
  isTopAudioShortcutOwner: (owner: number) => topOwner.value === owner,
  isInEditableContext: (target: EventTarget | null) => {
    const el = target as HTMLElement | null
    return Boolean(el && typeof el.tagName === "string" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"))
  },
}))
const cell = (o: Partial<CellData>): CellData =>
  ({ fileId: "f1", original: "", translated: "", ...o }) as unknown as CellData

describe("TimelineEditor", () => {
  // The timeline is the innermost shortcut claimant unless a test says otherwise.
  beforeEach(() => { topOwner.value = 1 })

  it("renders subtitle + dialogue lanes and an untimed chip; selecting a card fills the chip strip", () => {
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
        onRetimeSubtitle={() => {}}
       
      />,
    )
    expect(document.querySelector('[data-variant="subtitle"]')).toBeTruthy()
    expect(document.querySelector('[data-variant="dialogue"]')).toBeTruthy()
    expect(screen.getByTestId("tl-untimed-u1")).toBeInTheDocument()

    // The chip strip is empty until something is selected.
    expect(screen.getByTestId("tl-detail-empty")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("tl-card-d1"))
    expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "d1")
  })

  it("zoom-in widens the cards", () => {
    // Hermetic: zoom persists per file — under a persistent localStorage
    // (NODE_OPTIONS --localstorage-file) each run would ratchet 1.3× until
    // ZOOM_MAX and the assertion goes flat.
    localStorage.removeItem("codex:timelineZoom:zoomfile")
    render(
      <TimelineEditor
        fileId="zoomfile"
        coreMediaUrl={null}
        editable
        cells={[cell({ id: "d1", original: "x", medium: "media", startTime: 0, endTime: 2 })]}
        onRetimeSubtitle={() => {}}
       
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
        onRetimeSubtitle={() => {}}
       
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

  it("no longer renders the video itself — the pane beside the table owns it", () => {
    // AQU-646: the old preview band lived here, wrote the same clock the queue
    // wrote, and played its own soundtrack over the dub. It is now MediaVideoPane,
    // mounted next to the text table. A linked url must add nothing here.
    render(
      <TimelineEditor
        fileId="f2"
        coreMediaUrl="https://cdn/v.mp4"
        editable
        cells={[]}
        onRetimeSubtitle={() => {}}
      />,
    )
    expect(screen.queryByTestId("tl-video")).toBeNull()
    expect(document.querySelector("video")).toBeNull()
  })

  it("offers the link-video control, and disables it below contributor", () => {
    const onRequestLinkVideo = vi.fn()
    const { rerender } = render(
      <TimelineEditor
        fileId="f2"
        coreMediaUrl={null}
        editable
        cells={[]}
        onRetimeSubtitle={() => {}}
        onRequestLinkVideo={onRequestLinkVideo}
      />,
    )
    const button = screen.getByTestId("tl-link-video")
    expect(button).toHaveTextContent("Link video")
    fireEvent.click(button)
    expect(onRequestLinkVideo).toHaveBeenCalledTimes(1)

    rerender(
      <TimelineEditor
        fileId="f2"
        coreMediaUrl="https://cdn/v.mp4"
        editable
        cells={[]}
        onRetimeSubtitle={() => {}}
        onRequestLinkVideo={onRequestLinkVideo}
        canLinkVideo={false}
      />,
    )
    const gated = screen.getByTestId("tl-link-video")
    expect(gated).toHaveTextContent("Change video")
    expect(gated).toBeDisabled()
  })

  // ── AQU-646: playhead follows the audio queue; clicks navigate playback ──

  // The shared imported clip, seeded with the FILE id — that seeding is what
  // makes the queue's progress a FILE position (sourceClipAudioForCell). Real
  // imported media always carries it; without it these cells were a media file
  // that had somehow lost its audio, and the playhead assertions below were
  // passing on a case that cannot occur.
  const SOURCE_CLIP = "audio-f1-1690000000-shared.mp3"
  const withClip = (o: Partial<CellData>): CellData =>
    cell({ ...o, attachments: { [SOURCE_CLIP]: { type: "audio", url: "frontier-audio://src" } } } as Partial<CellData>)

  const mediaCells = [
    withClip({ id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10 }),
    withClip({ id: "m2", original: "Two", medium: "media", startTime: 10, endTime: 20 }),
  ]

  it("the playhead tracks queue progress for THIS file's cells", () => {
    mockQueueState = { kind: "playing", cellIndex: 1, cellId: "m2" }
    mockProgress = { currentTime: 12, duration: 20, rate: 1, volume: 1 }
    try {
      render(
        <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
      )
      const playhead = screen.getByTestId("tl-playhead")
      // 12s at the default 38 px/s zoom.
      expect(parseFloat(playhead.style.left)).toBeCloseTo(12 * 38, 0)
    } finally {
      mockQueueState = { kind: "idle" }
      mockProgress = { currentTime: 0, duration: 0, rate: 1, volume: 1 }
    }
  })

  // 2026-08-11 regression guard. A take's clock restarts at 0 and means
  // nothing on the file timeline (play-queue says so outright). Writing it into
  // the timeline clock yanked the playhead to the far left the moment anyone
  // played a take from a row's rail — on a file whose cells sit at 10-20s, the
  // playhead jumped to 0 and stayed there.
  it("a take's own clock does NOT move the playhead", () => {
    const takeOnly = [
      cell({
        id: "t1", original: "Take only", medium: "media", startTime: 10, endTime: 20,
        selectedAudioId: "audio-t1-1700000000-take.webm",
        attachments: { "audio-t1-1700000000-take.webm": { type: "audio", url: "frontier-audio://take" } },
      } as Partial<CellData>),
    ]
    mockQueueState = { kind: "playing", cellIndex: 0, cellId: "t1" }
    // 3s INTO THE TAKE — not 3s into the file.
    mockProgress = { currentTime: 3, duration: 8, rate: 1, volume: 1 }
    try {
      render(
        <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={takeOnly} onRetimeSubtitle={() => {}} />,
      )
      expect(parseFloat(screen.getByTestId("tl-playhead").style.left)).toBe(0)
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
        <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
      )
      expect(parseFloat(screen.getByTestId("tl-playhead").style.left)).toBe(0)
      // …and the strip never fills from a foreign file's queue either.
      expect(screen.getByTestId("tl-detail-empty")).toBeInTheDocument()
    } finally {
      mockQueueState = { kind: "idle" }
      mockProgress = { currentTime: 0, duration: 0, rate: 1, volume: 1 }
    }
  })

  it("a clean card click seeks playback to the clip start AND fills the chip strip", () => {
    const onSeekToTime = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetimeSubtitle={() => {}} onSeekToTime={onSeekToTime}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-card-m2"))
    expect(onSeekToTime).toHaveBeenCalledWith(10)
    expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "m2")
  })

  it("an untimed chip selects but never seeks", () => {
    const onSeekToTime = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={[...mediaCells, cell({ id: "u1", original: "Untimed", medium: "text" })]}
        onRetimeSubtitle={() => {}} onSeekToTime={onSeekToTime}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-untimed-u1"))
    expect(onSeekToTime).not.toHaveBeenCalled()
    expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "u1")
  })

  // ── Round 7 (SUB-44): transport keys ──

  it("Space toggles queue playback; typing is never hijacked", () => {
    const onTogglePlay = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetimeSubtitle={() => {}} onTogglePlay={onTogglePlay}
      />,
    )
    fireEvent.keyDown(document.body, { key: " " })
    expect(onTogglePlay).toHaveBeenCalledTimes(1)
    const input = document.createElement("input")
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: " " })
    expect(onTogglePlay).toHaveBeenCalledTimes(1)
    input.remove()
  })

  it("Space stops toggling playback while something claims it on top (SUB-52)", () => {
    // The recording modal opens ON TOP of the timeline without unmounting it,
    // so one Space press was both starting the recording and starting queue
    // playback underneath. The timeline now stands down while it isn't the
    // innermost claimant.
    const onTogglePlay = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetimeSubtitle={() => {}} onTogglePlay={onTogglePlay}
      />,
    )
    fireEvent.keyDown(document.body, { key: " " })
    expect(onTogglePlay).toHaveBeenCalledTimes(1)

    topOwner.value = 2 // the modal claims on top
    fireEvent.keyDown(document.body, { key: " " })
    expect(onTogglePlay).toHaveBeenCalledTimes(1) // silence underneath

    topOwner.value = 1 // modal closes, the claim comes back
    fireEvent.keyDown(document.body, { key: " " })
    expect(onTogglePlay).toHaveBeenCalledTimes(2)
  })

  it("Cmd/Ctrl+Enter returns playback to the very beginning", () => {
    const onSeekToTime = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetimeSubtitle={() => {}} onSeekToTime={onSeekToTime}
      />,
    )
    fireEvent.keyDown(document.body, { key: "Enter", metaKey: true })
    expect(onSeekToTime).toHaveBeenCalledWith(0)
  })

  it("claims the app-wide audio shortcut for its lifetime", () => {
    pushOverride.mockClear()
    releaseOverride.mockClear()
    const { unmount } = render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
    )
    expect(pushOverride).toHaveBeenCalled()
    unmount()
    expect(releaseOverride).toHaveBeenCalled()
  })

  it("round 6: the snap magnet is on by default, toggles, and persists globally", () => {
    localStorage.removeItem("codex:timelineSnap")
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
    )
    const btn = screen.getByTestId("tl-snap-toggle")
    expect(btn).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(btn)
    expect(btn).toHaveAttribute("aria-pressed", "false")
    expect(localStorage.getItem("codex:timelineSnap")).toBe("off")
    localStorage.removeItem("codex:timelineSnap")
  })

  it("renders the follow toggle, pressed by default, and it toggles", () => {
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
    )
    const btn = screen.getByLabelText("Follow playhead")
    expect(btn).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(btn)
    expect(btn).toHaveAttribute("aria-pressed", "false")
  })

  // ── AQU-646 round 3: text→media trace seed + media→text selection mirror ──

  it("initialSelectedCellId fills the chip strip and cues playback at the clip start", () => {
    const onSeekToTime = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetimeSubtitle={() => {}}
        onSeekToTime={onSeekToTime} initialSelectedCellId="m2"
      />,
    )
    expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "m2")
    expect(onSeekToTime).toHaveBeenCalledWith(10)
  })

  it("onSelectedCellChange mirrors the seed on mount and card clicks after", () => {
    const onSelectedCellChange = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetimeSubtitle={() => {}}
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

  it("SUB-37: the Untimed row exists only when something is untimed", () => {
    const { rerender } = render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
    )
    expect(screen.queryByText("Untimed")).toBeNull()
    rerender(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={[...mediaCells, cell({ id: "u9", original: "Loose line", medium: "text" })]}
        onRetimeSubtitle={() => {}}
      />,
    )
    expect(screen.getByText("Untimed")).toBeInTheDocument()
    expect(screen.getByTestId("tl-untimed-u9")).toBeInTheDocument()
  })

  it("renames the lane headers to Subtitles / Source audio / Target audio", () => {
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
    )
    expect(screen.getByText("Subtitles")).toBeInTheDocument()
    expect(screen.getByText("Source audio")).toBeInTheDocument()
    expect(screen.getByText("Target audio")).toBeInTheDocument()
  })

  it("shows a Target-track chip only for sections with dub audio, kinded and positioned at the section", () => {
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={dubbedCells} onRetimeSubtitle={() => {}} />,
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
        onRetimeSubtitle={() => {}} onSeekToTime={onSeekToTime}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-target-m2"))
    expect(onSeekToTime).toHaveBeenCalledWith(10)
    expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "m2")
  })

  it("speaker buttons start audible, push audibility into the queue, toggle, and persist per file", () => {
    localStorage.removeItem("codex:timelineAudibility:spkfile")
    lastAudibility = null
    render(
      <TimelineEditor fileId="spkfile" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
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
      <TimelineEditor fileId="persistfile" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
    )
    expect(screen.getByTestId("tl-speaker-source")).toHaveAttribute("aria-pressed", "false")
    expect(lastAudibility).toEqual({ source: false, target: true })
  })

  // ── 2026-08-07: the chip strip follows the CURRENT chip, not just clicks ──

  it("with nothing selected, the strip follows the cell the queue is sounding", () => {
    mockQueueState = { kind: "playing", cellIndex: 1, cellId: "m2" }
    try {
      render(
        <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
      )
      expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "m2")
    } finally {
      mockQueueState = { kind: "idle" }
    }
  })

  it("an explicit selection beats the sounding cell", () => {
    mockQueueState = { kind: "playing", cellIndex: 1, cellId: "m2" }
    try {
      render(
        <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
      )
      fireEvent.click(screen.getByTestId("tl-card-m1"))
      expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "m1")
    } finally {
      mockQueueState = { kind: "idle" }
    }
  })

  it("after the queue goes idle the strip keeps the last cell it showed", () => {
    mockQueueState = { kind: "playing", cellIndex: 1, cellId: "m2" }
    try {
      const { rerender } = render(
        <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
      )
      expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "m2")
      mockQueueState = { kind: "idle" }
      rerender(
        <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
      )
      expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "m2")
    } finally {
      mockQueueState = { kind: "idle" }
    }
  })
  // ── 2026-08-08: duration Diff + split overlap, end to end through the memo ──

  it("a dub spilling at BOTH ends reports its full length difference and two overlaps", () => {
    // Verse 10–20 (10.0s) whose dub is anchored at 9.0 and runs 12.0s, so it
    // starts 1.0s inside the previous verse's dub and ends 1.0s inside the
    // next one's — the case the old end-only Diff was blind to.
    const dub = (id: string, start: number, end: number, durationMs: number, anchorMs?: number): CellData => {
      const takeId = `audio-${id}-1700000000-take.webm`
      return cell({
        id, medium: "media", startTime: start, endTime: end, original: id,
        selectedAudioId: takeId,
        ...(anchorMs != null ? { metadata: { target_start_ms: anchorMs } } : {}),
        attachments: {
          [takeId]: { type: "audio", url: "frontier-audio://take", durationMs },
          [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
        },
      } as unknown as Partial<CellData>)
    }
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={[dub("v1", 0, 10, 10_000), dub("v2", 10, 20, 12_000, 9_000), dub("v3", 20, 30, 10_000)]}
        onRetimeSubtitle={() => {}} initialSelectedCellId="v2"
      />,
    )
    // Source 10.0s − target 12.0s = −2.0s (start −1.0 + end −1.0).
    expect(screen.getByTestId("tl-detail-diff")).toHaveTextContent("Diff: −2.0s")
    expect(screen.getByTestId("tl-detail-overlap-start")).toHaveTextContent("Start overlap: −1.0s")
    expect(screen.getByTestId("tl-detail-overlap-end")).toHaveTextContent("End overlap: −1.0s")
    expect(screen.queryByTestId("tl-detail-overlap")).toBeNull()
  })

  // ── 2026-08-08: an automatic playback advance clears the selection ──

  const editorAt = (onSelectCell: (id: string | null) => void) => (
    <TimelineEditor
      fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
      onRetimeSubtitle={() => {}} onSelectCell={onSelectCell}
    />
  )

  it("playback walking past the selected cell drops the selection", () => {
    const onSelectCell = vi.fn()
    mockQueueState = { kind: "playing", cellIndex: 0, cellId: "m1" }
    try {
      const { rerender } = render(editorAt(onSelectCell))
      fireEvent.click(screen.getByTestId("tl-card-m1"))
      expect(onSelectCell).toHaveBeenLastCalledWith("m1")
      mockQueueState = { kind: "playing", cellIndex: 1, cellId: "m2" }
      rerender(editorAt(onSelectCell))
      expect(onSelectCell).toHaveBeenLastCalledWith(null)
      // The strip falls back to the sounding cell — follows playback.
      expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "m2")
    } finally {
      mockQueueState = { kind: "idle" }
    }
  })

  it("a selection made DURING playback survives its own seek landing", () => {
    const onSelectCell = vi.fn()
    mockQueueState = { kind: "playing", cellIndex: 0, cellId: "m1" }
    try {
      const { rerender } = render(editorAt(onSelectCell))
      fireEvent.click(screen.getByTestId("tl-card-m2")) // click-then-jump
      expect(onSelectCell).toHaveBeenLastCalledWith("m2")
      // The queue lands on the clicked cell — m1→m2 departs m1, not m2.
      mockQueueState = { kind: "playing", cellIndex: 1, cellId: "m2" }
      rerender(editorAt(onSelectCell))
      expect(onSelectCell).toHaveBeenLastCalledWith("m2")
      // Only the NEXT automatic advance clears.
      mockQueueState = { kind: "playing", cellIndex: 0, cellId: "m1" }
      rerender(editorAt(onSelectCell))
      expect(onSelectCell).toHaveBeenLastCalledWith(null)
    } finally {
      mockQueueState = { kind: "idle" }
    }
  })

  it("an untimed selection survives playback advances", () => {
    const onSelectCell = vi.fn()
    const cells = [...mediaCells, cell({ id: "u1", original: "Untimed", medium: "text" })]
    const ui = () => (
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={cells}
        onRetimeSubtitle={() => {}} onSelectCell={onSelectCell}
      />
    )
    mockQueueState = { kind: "playing", cellIndex: 0, cellId: "m1" }
    try {
      const { rerender } = render(ui())
      fireEvent.click(screen.getByTestId("tl-untimed-u1"))
      expect(onSelectCell).toHaveBeenLastCalledWith("u1")
      mockQueueState = { kind: "playing", cellIndex: 1, cellId: "m2" }
      rerender(ui())
      expect(onSelectCell).toHaveBeenLastCalledWith("u1")
    } finally {
      mockQueueState = { kind: "idle" }
    }
  })

  it("pausing or stopping never clears the selection", () => {
    const onSelectCell = vi.fn()
    mockQueueState = { kind: "playing", cellIndex: 1, cellId: "m2" }
    try {
      const { rerender } = render(editorAt(onSelectCell))
      fireEvent.click(screen.getByTestId("tl-card-m2"))
      expect(onSelectCell).toHaveBeenLastCalledWith("m2")
      mockQueueState = { kind: "paused", cellIndex: 1, cellId: "m2" }
      rerender(editorAt(onSelectCell))
      expect(onSelectCell).toHaveBeenLastCalledWith("m2")
      mockQueueState = { kind: "idle" }
      rerender(editorAt(onSelectCell))
      expect(onSelectCell).toHaveBeenLastCalledWith("m2")
    } finally {
      mockQueueState = { kind: "idle" }
    }
  })

  // ── 2026-08-07: chip↔row sync wires ──

  it("wire a: a USER chip click fires onChipActivated with the cell id", () => {
    const onChipActivated = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetimeSubtitle={() => {}} onChipActivated={onChipActivated}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-card-m2"))
    expect(onChipActivated).toHaveBeenCalledWith("m2")
  })

  it("wire b: an activateRequest selects + cues WITHOUT echoing onChipActivated", () => {
    const onChipActivated = vi.fn()
    const onSeekToTime = vi.fn()
    const { rerender } = render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetimeSubtitle={() => {}} onChipActivated={onChipActivated}
        onSeekToTime={onSeekToTime} activateRequest={null}
      />,
    )
    rerender(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetimeSubtitle={() => {}} onChipActivated={onChipActivated}
        onSeekToTime={onSeekToTime} activateRequest={{ cellId: "m2", nonce: 1 }}
      />,
    )
    expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "m2")
    expect(onSeekToTime).toHaveBeenCalledWith(10)
    expect(onChipActivated).not.toHaveBeenCalled()
  })

  it("wire b: the same cell re-requested (new nonce) re-cues", () => {
    const onSeekToTime = vi.fn()
    const { rerender } = render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetimeSubtitle={() => {}} onSeekToTime={onSeekToTime}
        activateRequest={{ cellId: "m2", nonce: 1 }}
      />,
    )
    onSeekToTime.mockClear()
    rerender(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetimeSubtitle={() => {}} onSeekToTime={onSeekToTime}
        activateRequest={{ cellId: "m2", nonce: 2 }}
      />,
    )
    expect(onSeekToTime).toHaveBeenCalledWith(10)
  })
})

// ── SUB-53: audio-first ─────────────────────────────────────────────────────
// A translated verse routinely runs much longer than its original. Drawn
// against the imported file's clock the error accumulates, so by the fourth
// verse the translation sits under a completely different one. Audio-first
// gives every verse as much room as its longer side, laid end to end.

describe("TimelineEditor — audio-first mode", () => {
  beforeEach(() => { topOwner.value = 1 })

  const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
  const dubbed = (id: string, start: number, end: number, takeMs?: number): CellData => {
    const takeId = `audio-${id}-1700000000-take.webm`
    return cell({
      id, medium: "media", startTime: start, endTime: end, original: id,
      ...(takeMs != null ? { selectedAudioId: takeId } : {}),
      attachments: {
        ...(takeMs != null
          ? { [takeId]: { type: "audio", url: "frontier-audio://take", durationMs: takeMs } }
          : {}),
        [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
      },
    } as unknown as Partial<CellData>)
  }
  // v1: original 6s, translation 11s. v2: original 10s, translation 4s.
  const verses = [dubbed("v1", 0, 6, 11_000), dubbed("v2", 6, 16, 4_000)]

  const px = (el: Element, key: "left" | "width") => parseFloat((el as HTMLElement).style[key])

  // Tooltip provider included: chip hover text lives on AppTooltip now.
  const renderAt = (mode: "dubbing" | "audioFirst", extra: Record<string, unknown> = {}) =>
    renderWithTooltips(
      <TimelineEditor
        fileId="af1" coreMediaUrl={null} editable cells={verses}
        timingMode={mode}
        onRetimeSubtitle={() => {}}
        onRetimeTarget={() => {}} onTrimTarget={() => {}}
        {...extra}
      />,
    )

  it("spaces the originals out so a verse begins only after the last one has finished", () => {
    const { container } = renderAt("audioFirst")
    const lane = container.querySelector('[data-variant="dialogue"]')!
    const v1 = lane.querySelector('[data-testid="tl-card-v1"]')!
    const v2 = lane.querySelector('[data-testid="tl-card-v2"]')!
    const chip1 = screen.getByTestId("tl-target-v1")
    // v2's original waits for v1's TRANSLATION, not v1's original.
    expect(px(v2, "left")).toBeGreaterThanOrEqual(px(chip1, "left") + px(chip1, "width") - 0.5)
    // …and each original keeps its own real length.
    expect(px(v1, "width") / px(v2, "width")).toBeCloseTo(6 / 10, 5)
  })

  it("a verse's two sides share a left edge", () => {
    const { container } = renderAt("audioFirst")
    for (const id of ["v1", "v2"]) {
      const card = container.querySelector(`[data-variant="dialogue"] [data-testid="tl-card-${id}"]`)!
      expect(px(screen.getByTestId(`tl-target-${id}`), "left")).toBeCloseTo(px(card, "left"), 5)
    }
  })

  it("the detail readout shows DURATIONS only — file-clock ranges lie against the re-flowed track (2026-08-06)", () => {
    renderAt("audioFirst", { initialSelectedCellId: "v1" })
    // v1: original 6s, translation 11s.
    expect(screen.getByTestId("tl-detail-src-duration")).toHaveTextContent("Source: 6.0s")
    expect(screen.getByTestId("tl-detail-tgt-duration")).toHaveTextContent("Target: 11.0s")
    expect(screen.queryByTestId("tl-detail-dub-range")).toBeNull()
  })

  it("running long stops being a warning, and says how it compares instead", async () => {
    renderAt("audioFirst")
    const chip = screen.getByTestId("tl-target-v1")
    expect(chip).toHaveAttribute("data-overflow", "none")
    expect(chip).toHaveAttribute("data-ratio", (11 / 6).toFixed(2))
    await expectTooltip(chip, /11\.0s — 1\.8× the original/)
    // The same take in dubbing mode is still flagged for running past its verse.
    renderAt("dubbing")
    expect(screen.getAllByTestId("tl-target-v1")[1]).toHaveAttribute("data-overflow", "overlap")
  })

  it("chips can still be trimmed but no longer dragged sideways", () => {
    renderAt("audioFirst")
    expect(screen.getByTestId("tl-target-v1-handle-l")).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByTestId("tl-target-v1"), { clientX: 10 })
    fireEvent.pointerMove(window, { clientX: 200 })
    fireEvent.pointerUp(window, { clientX: 200 })
    // Nothing to retime to — position is computed, so the drag is inert.
    expect(px(screen.getByTestId("tl-target-v1"), "left")).toBe(0)
  })

  it("hides the snap toggle, and below the floor shows the mode as a plain label", () => {
    // Pre-merge round: the mode is FILE-level and its control is back in the
    // toolbar. Without `onChangeTimingMode` (below the maintainer floor) only
    // the ACTIVE mode renders, as a span — same testid, so browser passes
    // read the mode identically either way.
    renderAt("audioFirst")
    expect(screen.queryByTestId("tl-snap-toggle")).toBeNull()
    expect(screen.getByTestId("tl-timing-mode")).toHaveAttribute("data-mode", "audioFirst")
    const label = screen.getByTestId("tl-timing-mode-audioFirst")
    expect(label.tagName).toBe("SPAN")
    expect(label).toHaveTextContent("Free timing")
    expect(label).toHaveAttribute("title", expect.stringContaining("Only a maintainer can change this."))
    // The inactive mode renders nothing at all below the floor.
    expect(screen.queryByTestId("tl-timing-mode-dubbing")).toBeNull()
  })

  it("above the floor the mode is a two-button control that changes THIS file", () => {
    const onChange = vi.fn()
    renderAt("audioFirst", { onChangeTimingMode: onChange })
    const active = screen.getByTestId("tl-timing-mode-audioFirst")
    const other = screen.getByTestId("tl-timing-mode-dubbing")
    expect(active).toHaveAttribute("aria-pressed", "true")
    expect(other).toHaveAttribute("aria-pressed", "false")
    // Clicking the active mode is a no-op; clicking the other requests it.
    fireEvent.click(active)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(other)
    expect(onChange).toHaveBeenCalledWith("dubbing")
  })

  it("hides a linked video and says why — it runs on the original's timing", () => {
    render(
      <TimelineEditor
        fileId="af2" coreMediaUrl="http://v.test/a.mp4" editable cells={verses}
        timingMode="audioFirst" onRetimeSubtitle={() => {}}
      />,
    )
    expect(screen.queryByTestId("tl-video")).toBeNull()
    expect(screen.getByTestId("tl-video-hidden-note")).toBeInTheDocument()
  })

  it("clicking a verse seeks to it on the ASSEMBLED clock, not the file's", () => {
    const onSeekToTime = vi.fn()
    const { container } = renderAt("audioFirst", { onSeekToTime })
    fireEvent.click(container.querySelector('[data-variant="dialogue"] [data-testid="tl-card-v2"]')!)
    // v2 sits at 11s in the assembled passage; in the file it starts at 6s.
    expect(onSeekToTime).toHaveBeenCalledWith(11)
  })

  it("dubbing mode is untouched — cards stay where they are in the file", () => {
    const { container } = renderAt("dubbing")
    const v2 = container.querySelector('[data-variant="dialogue"] [data-testid="tl-card-v2"]')!
    expect(px(v2, "left")).toBeCloseTo(px(container.querySelector('[data-variant="dialogue"] [data-testid="tl-card-v1"]')!, "width"), 5)
    expect(screen.getByTestId("tl-snap-toggle")).toBeInTheDocument()
  })
})

// AQU-646: the Source row has two possible tenants. For an imported recording
// it is the dialogue lane, as before. For a subtitle file timed against footage
// — which produces no media cells at all, which is why that row is simply blank
// today — it is the band: the video's own audio, divided at the subtitle
// timestamps, silences included.
describe("TimelineEditor — the source-audio band", () => {
  const VIDEO = "https://cdn/episode.m3u8"
  const subtitleCells = [
    cell({ id: "s1", original: "One", medium: "text", startTime: 41.792, endTime: 43.043 }),
    cell({ id: "s2", original: "Two", medium: "text", startTime: 50, endTime: 52 }),
  ]
  // An imported recording: media cells backed by the shared file-seeded clip.
  const importedMedia = [
    cell({
      id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10,
      attachments: { "audio-f1-1690000000-shared.mp3": { type: "audio", url: "frontier-audio://src" } },
    } as Partial<CellData>),
  ]

  beforeEach(() => resetVideoDurationsForTests())

  it("draws the band for a subtitle file with footage linked, in place of the dialogue lane", () => {
    setVideoDurationSec(VIDEO, 120)
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={VIDEO} editable cells={subtitleCells} onRetimeSubtitle={() => {}} />,
    )
    expect(screen.getByTestId("tl-source-regions")).toBeInTheDocument()
    // The subtitle lane is still there; the DIALOGUE lane is what the band replaced.
    expect(screen.queryByTestId("tl-lane")).toBeInTheDocument()
    expect(screen.queryAllByTestId("tl-lane")).toHaveLength(1)
  })

  it("reaches past the last subtitle to the end of the footage", () => {
    setVideoDurationSec(VIDEO, 120)
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={VIDEO} editable cells={subtitleCells} onRetimeSubtitle={() => {}} />,
    )
    // The trailing silence — 52s to 120s — is a real, reachable stretch.
    const gaps = screen.getAllByTestId("tl-source-region-gap")
    const last = gaps[gaps.length - 1]
    expect(Number(last.getAttribute("data-region-end"))).toBe(120)
  })

  it("still draws the band before the footage's length is known", () => {
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={VIDEO} editable cells={subtitleCells} onRetimeSubtitle={() => {}} />,
    )
    // Spans the cues, exactly as the row did before — no crash, no empty row.
    expect(screen.getByTestId("tl-source-regions")).toBeInTheDocument()
    expect(screen.getByTestId("tl-source-band").style.width).not.toBe("")
  })

  it("hides the source speaker button, which cannot mute a video it does not own", () => {
    setVideoDurationSec(VIDEO, 120)
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={VIDEO} editable cells={subtitleCells} onRetimeSubtitle={() => {}} />,
    )
    expect(screen.queryByTestId("tl-speaker-source")).not.toBeInTheDocument()
    // The target row's button is untouched — the queue really does own that one.
    expect(screen.getByTestId("tl-speaker-target")).toBeInTheDocument()
  })

  it("leaves an imported recording alone even when it also has a video linked", () => {
    setVideoDurationSec(VIDEO, 120)
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={VIDEO} editable cells={importedMedia} onRetimeSubtitle={() => {}} />,
    )
    expect(screen.queryByTestId("tl-source-regions")).not.toBeInTheDocument()
    expect(screen.getAllByTestId("tl-lane")).toHaveLength(2)
    expect(screen.getByTestId("tl-speaker-source")).toBeInTheDocument()
  })

  it("does not draw the band with no video linked", () => {
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={subtitleCells} onRetimeSubtitle={() => {}} />,
    )
    expect(screen.queryByTestId("tl-source-regions")).not.toBeInTheDocument()
  })
})
