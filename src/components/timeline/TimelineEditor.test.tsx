import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"
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
  // The timeline is the innermost shortcut claimant unless a test says otherwise.
  beforeEach(() => { topOwner.value = 1 })

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
        onRetimeSubtitle={() => {}}
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
      <TimelineEditor fileId="f2" coreMediaUrl={null} editable cells={[]} onRetimeSubtitle={() => {}} onCommitTarget={() => {}} />,
    )
    expect(screen.queryByTestId("tl-video")).toBeNull()
    rerender(
      <TimelineEditor
        fileId="f2"
        coreMediaUrl="https://cdn/v.mp4"
        editable
        cells={[]}
        onRetimeSubtitle={() => {}}
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
        <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} onCommitTarget={() => {}} />,
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
        <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} onCommitTarget={() => {}} />,
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
        onRetimeSubtitle={() => {}} onCommitTarget={() => {}} onSeekToTime={onSeekToTime}
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
        onRetimeSubtitle={() => {}} onCommitTarget={() => {}} onSeekToTime={onSeekToTime}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-untimed-u1"))
    expect(onSeekToTime).not.toHaveBeenCalled()
    expect(screen.getByTestId("tl-detail-source")).toHaveTextContent("Untimed")
  })

  // ── Round 7 (SUB-44): transport keys ──

  it("Space toggles queue playback; typing is never hijacked", () => {
    const onTogglePlay = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetimeSubtitle={() => {}} onCommitTarget={() => {}} onTogglePlay={onTogglePlay}
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
        onRetimeSubtitle={() => {}} onCommitTarget={() => {}} onTogglePlay={onTogglePlay}
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
        onRetimeSubtitle={() => {}} onCommitTarget={() => {}} onSeekToTime={onSeekToTime}
      />,
    )
    fireEvent.keyDown(document.body, { key: "Enter", metaKey: true })
    expect(onSeekToTime).toHaveBeenCalledWith(0)
  })

  it("claims the app-wide audio shortcut for its lifetime", () => {
    pushOverride.mockClear()
    releaseOverride.mockClear()
    const { unmount } = render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} onCommitTarget={() => {}} />,
    )
    expect(pushOverride).toHaveBeenCalled()
    unmount()
    expect(releaseOverride).toHaveBeenCalled()
  })

  it("round 6: the snap magnet is on by default, toggles, and persists globally", () => {
    localStorage.removeItem("codex:timelineSnap")
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} onCommitTarget={() => {}} />,
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
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} onCommitTarget={() => {}} />,
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
        onRetimeSubtitle={() => {}} onCommitTarget={() => {}}
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
        onRetimeSubtitle={() => {}} onCommitTarget={() => {}}
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
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} onCommitTarget={() => {}} />,
    )
    expect(screen.queryByText("Untimed")).toBeNull()
    rerender(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={[...mediaCells, cell({ id: "u9", original: "Loose line", medium: "text" })]}
        onRetimeSubtitle={() => {}} onCommitTarget={() => {}}
      />,
    )
    expect(screen.getByText("Untimed")).toBeInTheDocument()
    expect(screen.getByTestId("tl-untimed-u9")).toBeInTheDocument()
  })

  it("renames the lane headers to Subtitles / Source audio / Target audio", () => {
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} onCommitTarget={() => {}} />,
    )
    expect(screen.getByText("Subtitles")).toBeInTheDocument()
    expect(screen.getByText("Source audio")).toBeInTheDocument()
    expect(screen.getByText("Target audio")).toBeInTheDocument()
  })

  it("shows a Target-track chip only for sections with dub audio, kinded and positioned at the section", () => {
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={dubbedCells} onRetimeSubtitle={() => {}} onCommitTarget={() => {}} />,
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
        onRetimeSubtitle={() => {}} onCommitTarget={() => {}} onSeekToTime={onSeekToTime}
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
      <TimelineEditor fileId="spkfile" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} onCommitTarget={() => {}} />,
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
      <TimelineEditor fileId="persistfile" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} onCommitTarget={() => {}} />,
    )
    expect(screen.getByTestId("tl-speaker-source")).toHaveAttribute("aria-pressed", "false")
    expect(lastAudibility).toEqual({ source: false, target: true })
  })

  it("passes detailActions through to the detail pane", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={mediaCells}
        onRetimeSubtitle={() => {}} onCommitTarget={() => {}}
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
        onRetimeSubtitle={() => {}} onCommitTarget={() => {}}
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

  it("hides the snap toggle and shows the mode, switchable only when allowed", () => {
    const onChange = vi.fn()
    const { unmount } = renderAt("audioFirst")
    expect(screen.queryByTestId("tl-snap-toggle")).toBeNull()
    // Read-only without a change handler…
    expect(screen.getByTestId("tl-timing-mode")).toHaveAttribute("data-mode", "audioFirst")
    expect(screen.getByTestId("tl-timing-mode-audioFirst").tagName).toBe("SPAN")
    expect(screen.queryByTestId("tl-timing-mode-dubbing")).toBeNull()
    unmount()

    // …a control when it is there.
    renderAt("audioFirst", { onChangeTimingMode: onChange })
    fireEvent.click(screen.getByTestId("tl-timing-mode-dubbing"))
    expect(onChange).toHaveBeenCalledWith("dubbing")
  })

  it("hides a linked video and says why — it runs on the original's timing", () => {
    render(
      <TimelineEditor
        fileId="af2" coreMediaUrl="http://v.test/a.mp4" editable cells={verses}
        timingMode="audioFirst" onRetimeSubtitle={() => {}} onCommitTarget={() => {}}
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
