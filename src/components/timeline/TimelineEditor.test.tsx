import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"
import { TimelineEditor } from "./TimelineEditor"
import type { CellData } from "@/hooks/useCells"
import type { QueueState, QueueProgress } from "@/lib/audio/play-queue"
import { selectQueueForFile } from "@/lib/audio/queue-scope"
import { sourceClipAudioForCell } from "@/lib/audio/track-audio"
import { resetVideoDurationsForTests, setVideoDurationSec } from "@/lib/timeline/video-duration"
import { deriveTracksForFile } from "@/lib/timeline/tracks"
import { buildCueLinkIndex } from "@/lib/sync/cell-links-read"
import { ZOOM_DEFAULT, ZOOM_MAX } from "@/lib/timeline/scale"

// AQU-646: the editor subscribes to the play-queue (read-only) for playhead
// tracking. Mock the two hooks with mutable stubs so tests can simulate
// playback without any Audio element.
// AQU-646: the output latency the editor sees. Zero by default, so every test
// in this file behaves exactly as it did before compensation existed; the
// compensation block below dials it up to prove the shift actually applies.
let mockOutputLatencySec = 0
vi.mock("./useOutputLatency", () => ({ useOutputLatency: () => mockOutputLatencySec }))

let mockQueueState: QueueState = { kind: "idle" }
let mockProgress: QueueProgress = { currentTime: 0, duration: 0, rate: 1, volume: 1 }
// Round 5: the speaker buttons push audibility straight into the queue.
let lastAudibility: { source: boolean; target: boolean; bySlot?: Record<string, boolean> } | null = null
// Stage 2: audibility is a STORE now — lib/audio/audibility merges every toggle
// against `getQueueAudibility()` rather than against component state, precisely
// so the editor's button and the video pane's cannot clobber each other. So the
// stub has to BE a store (value + getter + subscription), not just a recorder;
// a stub that only remembered the last write would let the editor's button read
// a stale value and the clobbering bug back in through the test suite.
// It carries `bySlot` THROUGH, which is not incidental: an added track's
// speaker addresses its own slot in that map, so a store that flattened it away
// would make every per-track mute read back as "audible" inside this suite —
// the same blindness that let stage 6A's bug reach Sam.
const audibilityStore = vi.hoisted(() => {
  let value: { source: boolean; target: boolean; bySlot?: Record<string, boolean> } = {
    source: true,
    target: true,
  }
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next: { source: boolean; target: boolean; bySlot?: Record<string, boolean> }) => {
      value = {
        source: next.source,
        target: next.target,
        ...(next.bySlot ? { bySlot: { ...next.bySlot } } : {}),
      }
      for (const l of listeners) l()
    },
    subscribe: (l: () => void) => {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
})
// Decision 2026-08-05: chips badge definitively-missing dubs.
const mockMissingCells: ReadonlySet<string> = new Set()
vi.mock("@/lib/audio/play-queue", async () => {
  // Subscribed with React's own hook, exactly as the real one is.
  const { useSyncExternalStore } = await import("react")
  return {
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
    setQueueAudibility: (a: { source: boolean; target: boolean; bySlot?: Record<string, boolean> }) => {
      lastAudibility = a
      audibilityStore.set(a)
    },
    getQueueAudibility: () => audibilityStore.get(),
    useQueueAudibility: () =>
      useSyncExternalStore(audibilityStore.subscribe, audibilityStore.get, audibilityStore.get),
  }
})
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

/** Arm linking mode. It used to be its own toolbar button; since 2026-08-18 it
 *  is an item in the Check menu, which importing and reviewing no longer share. */
function armLinking() {
  fireEvent.click(screen.getByTestId("tl-check-menu"))
  fireEvent.click(screen.getByText("Check links"))
}

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
    localStorage.removeItem("aquilla:timelineZoom:zoomfile")
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

    // ctrl+wheel down = zoom out (applied by the glide loop).
    sendWheel({ deltaY: 100, ctrlKey: true })
    await waitFor(() => expect(width()).toBeLessThan(zoomedIn))

    // Clamp: hammering zoom-out bottoms out at ZOOM_MIN instead of vanishing.
    for (let i = 0; i < 40; i++) sendWheel({ deltaY: 100, ctrlKey: true })
    await waitFor(() => expect(width()).toBeGreaterThan(0))
  })

  it("⌘ + scroll zooms the rows, and leaves the seconds alone", async () => {
    // 2026-08-13. A SCROLL, not a pinch: macOS synthesizes a pinch as a
    // ctrlKey wheel and drops every other modifier, so ⌘ + pinch is
    // indistinguishable from a bare pinch and no modifier+pinch binding is
    // implementable at all. A real two-finger scroll reports its modifiers.
    // Its own render because the horizontal zoom eases over rAF frames, so a
    // width read taken while the test above is still gliding is a race.
    localStorage.removeItem("aquilla:timelineRowHeight:metafile")
    render(
      <TimelineEditor
        fileId="metafile"
        coreMediaUrl={null}
        editable
        cells={[cell({ id: "d1", original: "x", medium: "media", startTime: 0, endTime: 2 })]}
        onRetimeSubtitle={() => {}}
      />,
    )
    const scroll = screen.getByTestId("tl-scroll")
    const rowH = () => screen.getByTestId("tl-editor").style.getPropertyValue("--tl-row-h")
    const width = () => parseFloat(screen.getByTestId("tl-card-d1").style.width)
    const sendWheel = (init: { deltaY: number; ctrlKey?: boolean; metaKey?: boolean }) => {
      const ev = new Event("wheel", { bubbles: true, cancelable: true })
      Object.assign(ev, { clientX: 0, ...init })
      fireEvent(scroll, ev)
    }

    const rowsBefore = rowH()
    const widthBefore = width()
    // metaKey WITHOUT ctrlKey — the shape a real ⌘ + two-finger scroll has.
    sendWheel({ deltaY: 100, metaKey: true })
    await waitFor(() => expect(rowH()).not.toBe(rowsBefore))
    expect(width()).toBe(widthBefore)
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

  it("offers the film row in Sources, with its state, and disables it below contributor", () => {
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
    // REWRITTEN 2026-08-15: the standalone Link-video button folded into the
    // Sources menu, along with the audio-VTT and character imports — all three
    // attach material to the file already open, as distinct from Import, which
    // mints a new one. The row carries the file's STATE, which is the gain: a
    // button label had to choose between "Link" and "Change" and told you
    // nothing about audio cues or characters at all.
    fireEvent.click(screen.getByTestId("tl-sources-menu"))
    const film = screen.getByRole("menuitem", { name: /Film/ })
    expect(film).toHaveTextContent("not linked")
    fireEvent.click(film)
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
        // A second, usable row keeps the menu on screen — without one it now
        // hides entirely (see "the Sources menu disappears when nothing in it
        // is yours" below). Permission is still per ROW, not per button.
        onRequestImportCharacters={() => {}}
        canImportCharacters
      />,
    )
    fireEvent.click(screen.getByTestId("tl-sources-menu"))
    const gated = screen.getByRole("menuitem", { name: /Film/ })
    expect(gated).toHaveTextContent("linked")
    expect(gated).toHaveAttribute("data-disabled")
    // …and the row they CAN use is not greyed out beside it.
    expect(screen.getByRole("menuitem", { name: /Characters/ })).not.toHaveAttribute("data-disabled")
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

  // AQU-646. The playhead is drawn where the SOUND is, not where the clock is:
  // a media element's currentTime is what has been handed to the audio
  // pipeline, and on Bluetooth the speaker is up to ~200ms behind that. These
  // pin the rule that decides WHEN that shift applies, which is the part that
  // went wrong in the first design.
  describe("output-latency compensation", () => {
    const playheadPx = () => parseFloat(screen.getByTestId("tl-playhead").style.left)

    function playing(at: number) {
      mockQueueState = { kind: "playing", cellIndex: 1, cellId: "m2" }
      mockProgress = { currentTime: at, duration: 20, rate: 1, volume: 1 }
    }
    function coldGate(at: number) {
      // A verse whose audio has not arrived yet. `transportPlaying` goes FALSE
      // here even though the transport has not stopped — which is exactly the
      // trap: gating compensation on that flag would switch it off mid-run.
      mockQueueState = { kind: "loading", cellIndex: 1, cellId: "m2" }
      mockProgress = { currentTime: at, duration: 20, rate: 1, volume: 1 }
    }
    const reset = () => {
      mockQueueState = { kind: "idle" }
      mockProgress = { currentTime: 0, duration: 0, rate: 1, volume: 1 }
      mockOutputLatencySec = 0
    }

    it("does not flicker across a cold verse gate", () => {
      // THE REGRESSION TEST FOR THE FLAW THE PLAN HAD. Compensation is a latch
      // armed when playback starts, not a gate on the sounding flag, so a gate
      // must not move the head at all. If someone re-gates it on
      // `transportPlaying`, the head jumps forward into the gate and this fails.
      mockOutputLatencySec = 0.178 // a Bluetooth-sized delay
      playing(12)
      try {
        const { rerender } = render(
          <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
        )
        const before = playheadPx()

        coldGate(12)
        rerender(
          <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
        )
        const during = playheadPx()

        playing(12)
        rerender(
          <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
        )
        const after = playheadPx()

        // The shift really is applied — otherwise this test would pass on a
        // build that compensates by nothing at all, and prove nothing.
        expect(before).toBeCloseTo((12 - 0.178) * 38, 0)
        expect(during).toBeCloseTo(before, 1)
        expect(after).toBeCloseTo(before, 1)
      } finally {
        reset()
      }
    })

    it("compensates by nothing when the platform cannot measure the latency", () => {
      // happy-dom has no AudioContext, so the store reads 0 and the head sits
      // exactly on the clock. This is also WHY the exact-pixel test below can
      // assert 12 * 38 while playing — see output-latency.test.ts, which pins
      // the same invariant from the other side.
      playing(12)
      try {
        render(
          <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
        )
        expect(playheadPx()).toBeCloseTo(12 * 38, 0)
      } finally {
        reset()
      }
    })
  })

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
    localStorage.removeItem("aquilla:timelineSnap")
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
    )
    const btn = screen.getByTestId("tl-snap-toggle")
    expect(btn).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(btn)
    expect(btn).toHaveAttribute("aria-pressed", "false")
    expect(localStorage.getItem("aquilla:timelineSnap")).toBe("off")
    localStorage.removeItem("aquilla:timelineSnap")
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

  it("renames the lane headers to Source text / Source audio / Target audio", () => {
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={mediaCells} onRetimeSubtitle={() => {}} />,
    )
    expect(screen.getByText("Source text")).toBeInTheDocument()
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
    localStorage.removeItem("aquilla:timelineAudibility:spkfile")
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
    expect(JSON.parse(localStorage.getItem("aquilla:timelineAudibility:spkfile")!)).toEqual({ source: false, target: true })

    fireEvent.click(tgt)
    expect(lastAudibility).toEqual({ source: false, target: false })
    // STAGE 6A — THE ASSERTION THIS TEST WAS MISSING. It checked that the click
    // reached the store and never that the button reported it back, so a reader
    // that classified `"target"` differently from the writer passed here and
    // shipped: the row really did mute while the icon stayed on, and the second
    // click people naturally gave it turned the sound back on (Sam, 2026-08-27).
    expect(tgt).toHaveAttribute("aria-pressed", "false")

    fireEvent.click(tgt)
    expect(tgt).toHaveAttribute("aria-pressed", "true")
    expect(lastAudibility).toEqual({ source: false, target: true })
  })

  it("a muted-source preference persists across mounts", () => {
    localStorage.setItem("aquilla:timelineAudibility:persistfile", JSON.stringify({ source: false, target: true }))
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

// AQU-928: transcribing a section used to mean finding a Transcribe button
// inside one clip's expanded audio panel in the table below — so the only
// discoverable action was "transcribe everything". The timeline now carries a
// visible, selection-scoped transcribe row, and a chip click can build that
// selection with a modifier.
describe("TimelineEditor — section-scoped transcription (AQU-928)", () => {
  beforeEach(() => { topOwner.value = 1 })

  // Three media sections, each with its own source clip, plus one section with
  // no recording at all (nothing to transcribe).
  const sections = () => [
    cell({ id: "d1", original: "one", medium: "media", startTime: 0, endTime: 2, selectedAudioId: "f1-a1" }),
    cell({ id: "d2", original: "two", medium: "media", startTime: 2, endTime: 4, selectedAudioId: "f1-a2" }),
    cell({ id: "d3", original: "three", medium: "media", startTime: 4, endTime: 6, selectedAudioId: "f1-a3" }),
    cell({ id: "d4", original: "four", medium: "media", startTime: 6, endTime: 8 }),
  ]

  const renderBar = (over: Partial<React.ComponentProps<typeof TimelineEditor>> = {}) => {
    const onTranscribeSections = vi.fn()
    const view = render(
      <TimelineEditor
        fileId="f1"
        coreMediaUrl={null}
        editable
        cells={sections()}
        onRetimeSubtitle={() => {}}
        onTranscribeSections={onTranscribeSections}
        {...over}
      />,
    )
    return { ...view, onTranscribeSections }
  }

  const dialogueCard = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-variant="dialogue"] [data-testid="tl-card-${id}"]`)! as HTMLElement

  // STAGE 3e: THERE IS NO PERMANENT ROW ANY MORE. It used to sit under the
  // lanes whether or not anything was selected, saying "No section selected"
  // beside a greyed-out button — Sam, 2026-08-25: "a whole separate vertical
  // section of the screen dedicated to one little button." The controls live in
  // the text header now and appear only when there is something to act on.
  it("shows nothing until a section is selected", () => {
    const { container } = renderBar()
    expect(screen.queryByTestId("tl-transcribe-controls")).toBeNull()
    expect(screen.queryByTestId("tl-transcribe-count")).toBeNull()
    // …and the moment one is, they are there — inside the text header, not in a
    // row of their own.
    fireEvent.click(dialogueCard(container, "d2"))
    const controls = screen.getByTestId("tl-transcribe-controls")
    expect(controls).toBeInTheDocument()
    expect(controls.closest('[data-testid="tl-dialogue-header"]')).not.toBeNull()
  })

  // The gate is "don't pass the callback" — a read-only user is not offered a
  // run whose events the server would reject.
  it("omits the controls entirely when transcription is not offered", () => {
    const { container } = render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={sections()} onRetimeSubtitle={() => {}}
      />,
    )
    fireEvent.click(dialogueCard(container, "d2"))
    expect(screen.queryByTestId("tl-transcribe-controls")).toBeNull()
  })

  it("a plain chip click arms the row for exactly that one section", () => {
    const { container, onTranscribeSections } = renderBar()
    fireEvent.click(dialogueCard(container, "d2"))
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("1 section selected")
    expect(screen.getByTestId("tl-transcribe-selection")).toHaveTextContent("Transcribe section")
    fireEvent.click(screen.getByTestId("tl-transcribe-selection"))
    expect(onTranscribeSections).toHaveBeenCalledWith(["d2"])
  })

  it("⌘-click adds sections, and transcribes exactly those — not the whole file", () => {
    const { container, onTranscribeSections } = renderBar()
    fireEvent.click(dialogueCard(container, "d1"))
    fireEvent.click(dialogueCard(container, "d3"), { metaKey: true })
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("2 sections selected")
    expect(screen.getByTestId("tl-transcribe-selection")).toHaveTextContent("Transcribe 2 sections")
    fireEvent.click(screen.getByTestId("tl-transcribe-selection"))
    expect(onTranscribeSections).toHaveBeenCalledWith(["d1", "d3"])
  })

  it("Shift-click selects the range between the anchor and the clicked chip", () => {
    const { container, onTranscribeSections } = renderBar()
    fireEvent.click(dialogueCard(container, "d1"))
    fireEvent.click(dialogueCard(container, "d3"), { shiftKey: true })
    fireEvent.click(screen.getByTestId("tl-transcribe-selection"))
    expect(onTranscribeSections).toHaveBeenCalledWith(["d1", "d2", "d3"])
  })

  it("a ⌘-click builds the selection WITHOUT yanking playback or the text table", () => {
    const onSeekToTime = vi.fn()
    const onChipActivated = vi.fn()
    const { container } = renderBar({ onSeekToTime, onChipActivated })
    fireEvent.click(dialogueCard(container, "d1"))
    expect(onChipActivated).toHaveBeenCalledTimes(1)
    onSeekToTime.mockClear()
    onChipActivated.mockClear()
    fireEvent.click(dialogueCard(container, "d3"), { metaKey: true })
    expect(onChipActivated).not.toHaveBeenCalled()
    expect(onSeekToTime).not.toHaveBeenCalled()
  })

  it("rings the extra sections distinctly from the primary chip", () => {
    const { container } = renderBar()
    fireEvent.click(dialogueCard(container, "d1"))
    fireEvent.click(dialogueCard(container, "d3"), { metaKey: true })
    expect(dialogueCard(container, "d1")).not.toHaveAttribute("data-multi-selected")
    expect(dialogueCard(container, "d3")).toHaveAttribute("data-multi-selected")
  })

  it("counts a section with no recording as selected but not transcribable", () => {
    const { container, onTranscribeSections } = renderBar()
    fireEvent.click(dialogueCard(container, "d1"))
    fireEvent.click(dialogueCard(container, "d4"), { metaKey: true })
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("2 sections selected")
    // The button promises only the work that can actually run.
    expect(screen.getByTestId("tl-transcribe-selection")).toHaveTextContent("Transcribe section")
    fireEvent.click(screen.getByTestId("tl-transcribe-selection"))
    expect(onTranscribeSections).toHaveBeenCalledWith(["d1"])
  })

  it("⌘-clicking the primary chip hands the strip to the next selected section", () => {
    const { container } = renderBar()
    fireEvent.click(dialogueCard(container, "d1"))
    fireEvent.click(dialogueCard(container, "d3"), { metaKey: true })
    fireEvent.click(dialogueCard(container, "d1"), { metaKey: true })
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("1 section selected")
    expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "d3")
  })

  // Clearing now takes the whole group off screen with it, rather than leaving
  // a disabled button behind — which is the same change read from the other end.
  it("Clear selection empties the scope and takes the controls with it", () => {
    const { container } = renderBar()
    fireEvent.click(dialogueCard(container, "d1"))
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("1 section selected")
    fireEvent.click(screen.getByTestId("tl-transcribe-clear"))
    expect(screen.queryByTestId("tl-transcribe-controls")).toBeNull()
  })
})

// AQU-646 stage 2: the Source-audio row has two possible tenants, and the CELLS
// decide which. An imported recording gets its dialogue lane, as always. A
// subtitle file — no media cells at all — gets the AUDIO VTT's cues: a hidden
// sibling file transcribing the film's own speech, drawn as chips with a dashed
// empty chip over each stretch where nobody talks. The stage-1 "band" (the
// film's audio, notionally split at the SUBTITLE timestamps) is gone; the film's
// soundtrack gets no row, ever.
describe("TimelineEditor — the Source-audio row (the audio VTT's cues)", () => {
  const VIDEO = "https://cdn/episode.m3u8"
  const subtitleCells = [
    cell({ id: "s1", original: "One", medium: "text", startTime: 41.792, endTime: 43.043 }),
    cell({ id: "s2", original: "Two", medium: "text", startTime: 50, endTime: 52 }),
  ]
  // The sibling's cells: transcript in `original`, seconds, and NO medium —
  // they are neither this file's text nor anybody's media.
  const audioCues = [
    cell({ id: "c1", original: "Whoa there", startTime: 10, endTime: 20 }),
    cell({ id: "c2", original: "Easy now", startTime: 30, endTime: 40 }),
  ]
  // An imported recording: media cells backed by the shared file-seeded clip.
  const importedMedia = [
    cell({
      id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10,
      attachments: { "audio-f1-1690000000-shared.mp3": { type: "audio", url: "frontier-audio://src" } },
    } as Partial<CellData>),
  ]

  // The rows a subtitle file derives, with and without an audio VTT imported.
  const subtitleTracks = (hasAudioCues: boolean) =>
    deriveTracksForFile(null, { isSubtitleImport: true, hasMediaCells: false, hasAudioCues })

  beforeEach(() => resetVideoDurationsForTests())

  it("draws each audio cue as the SAME card an mp3 import's source row uses", () => {
    setVideoDurationSec(VIDEO, 120)
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={VIDEO} editable cells={subtitleCells}
        tracks={subtitleTracks(true)} audioCues={audioCues} onRetimeSubtitle={() => {}}
      />,
    )
    const lane = screen.getByTestId("tl-source-regions")
    expect(within(lane).getAllByTestId(/^tl-card-/)).toHaveLength(2)
    expect(within(lane).getByText("Whoa there")).toBeInTheDocument()
  })

  it("the row's trailing silence runs to the end of the footage", () => {
    setVideoDurationSec(VIDEO, 120)
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={VIDEO} editable cells={subtitleCells}
        tracks={subtitleTracks(true)} audioCues={audioCues} onRetimeSubtitle={() => {}}
      />,
    )
    // The last cue ends at 40s; 40→120 is a real, reachable chip.
    const gaps = screen.getAllByTestId("tl-source-gap")
    const last = gaps[gaps.length - 1]
    expect(Number(last.getAttribute("data-region-end"))).toBe(120)
  })

  it("still draws the row before the footage's length is known", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={VIDEO} editable cells={subtitleCells}
        tracks={subtitleTracks(true)} audioCues={audioCues} onRetimeSubtitle={() => {}}
      />,
    )
    // Spans the cues, exactly as the row did before — no crash, no empty row.
    const lane = screen.getByTestId("tl-source-regions")
    expect(within(lane).getAllByTestId(/^tl-card-/)).toHaveLength(2)
  })

  // THE LAYOUT-FLOOR GUARD, and the reason this test does not go anywhere near a
  // row. `subtitleFileWithFootage` also feeds the layout's duration floor, which
  // is the only thing that makes the track longer than its last cue. Couple that
  // floor to "has audio cues" by accident and the final minutes of a 70-minute
  // episode become unreachable on EVERY row at once, with nothing on screen to
  // suggest they exist. The band that used to demonstrate this is gone, and the
  // floor was never about the band.
  it("reaches the end of the footage with no audio VTT imported at all", () => {
    localStorage.removeItem("aquilla:timelineZoom:floorfile")
    setVideoDurationSec(VIDEO, 120)
    render(
      <TimelineEditor
        fileId="floorfile" coreMediaUrl={VIDEO} editable cells={subtitleCells}
        tracks={subtitleTracks(false)} onRetimeSubtitle={() => {}}
      />,
    )
    // The last cue ends at 52s; the scrolling track runs to the footage's 120.
    const track = screen.getByTestId("tl-scroll").firstElementChild as HTMLElement
    expect(parseFloat(track.style.width) / ZOOM_DEFAULT).toBeGreaterThanOrEqual(120)
    // …and there is no Source-audio row to have done it for us.
    expect(screen.queryByTestId("tl-source-regions")).not.toBeInTheDocument()
  })

  // Stage 2 withheld this button here and gave the film's mute to the video
  // pane, reasoning that it could only reach the play queue's own elements and a
  // subtitle file has none. That was already untrue by the end of that stage:
  // MediaVideoPane reads the audibility flag directly and mutes its element from
  // it. So the button works, and 2026-08-14 it came back — this row IS the
  // source audio, the way the row below is the target audio, and the pair
  // carries the same control. (The picture itself has none; the only other copy
  // is the playback bar's, on the same flag.)
  it("gives the Source-audio row its speaker on a subtitle file, naming the film", () => {
    setVideoDurationSec(VIDEO, 120)
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={VIDEO} editable cells={subtitleCells}
        tracks={subtitleTracks(true)} audioCues={audioCues} onRetimeSubtitle={() => {}}
      />,
    )
    const speaker = screen.getByTestId("tl-speaker-source")
    // Named for what actually goes quiet. On this file the row's cues are
    // timings over the FILM's soundtrack, and "source audio" would be true but
    // useless at the moment of clicking.
    expect(speaker).toHaveAttribute("aria-label", "Mute the film's own sound")
  })

  it("leaves the target row's speaker button alone", () => {
    setVideoDurationSec(VIDEO, 120)
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={VIDEO} editable cells={subtitleCells}
        tracks={subtitleTracks(true)} audioCues={audioCues} onRetimeSubtitle={() => {}}
      />,
    )
    expect(screen.getByTestId("tl-speaker-target")).toHaveAttribute("aria-pressed", "true")
  })

  it("an imported recording keeps its gutter source speaker, and it still publishes", () => {
    localStorage.removeItem("aquilla:timelineAudibility:spk2")
    setVideoDurationSec(VIDEO, 120)
    render(
      <TimelineEditor fileId="spk2" coreMediaUrl={VIDEO} editable cells={importedMedia} onRetimeSubtitle={() => {}} />,
    )
    // The dialogue lane, not the cue row — media cells own this track.
    expect(screen.queryByTestId("tl-source-regions")).not.toBeInTheDocument()
    expect(screen.getAllByTestId("tl-lane")).toHaveLength(2)
    const speaker = screen.getByTestId("tl-speaker-source")
    expect(speaker).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(speaker)
    expect(screen.getByTestId("tl-speaker-source")).toHaveAttribute("aria-pressed", "false")
    expect(lastAudibility).toEqual({ source: false, target: true })
  })

  // Round 8: the VTT's own timing is not ours to nudge, but a line added into
  // a silence still moves. Both cards live in the SAME lane, so this is the
  // test that would catch a lane-wide freeze pretending to be a per-cell one.
  //
  // 2026-08-20: the freeze now comes from the project TIMING LOCK rather than
  // from a film being linked. The old condition made unlocking a no-op on every
  // episode in the dubbing workflow, since they all have a film; the lock does
  // the same job without depending on that, and defaults to on. So this suite
  // states the lock explicitly — its subject is the per-cell exemption, not
  // where the freeze comes from.
  describe("imported cues are frozen, added lines are not", () => {
    // Scoped to the Subtitles track on purpose: it is the only row that may
    // retime anything, and other rows draw these same cells, so an unscoped
    // query could quietly start asserting against the wrong one.
    const gripsInSubtitleLane = (cardId: string) =>
      within(screen.getByTestId("tl-lane")).getByTestId(`tl-card-${cardId}`)
        .querySelectorAll(".cursor-ew-resize")

    it("no grips on an imported cue, grips on a line someone added", () => {
      setVideoDurationSec(VIDEO, 120)
      render(
        <TimelineEditor
          fileId="f1" coreMediaUrl={VIDEO} editable
          timingLocked
          cells={[
            cell({ id: "imported", original: "One", medium: "text", startTime: 10, endTime: 20 }),
            cell({
              id: "added", original: "", medium: "text", startTime: 25, endTime: 28,
              metadata: { aquillaOrigin: { kind: "user-insert" } },
            } as Partial<CellData>),
          ]}
          onRetimeSubtitle={() => {}}
        />,
      )
      expect(gripsInSubtitleLane("imported")).toHaveLength(0)
      expect(gripsInSubtitleLane("added")).toHaveLength(2)
    })

    it("a linked film no longer freezes anything on its own", () => {
      // The regression this pair exists for: with the film as a second freeze
      // condition, unlocking could not thaw the one workflow that has films.
      setVideoDurationSec(VIDEO, 120)
      render(
        <TimelineEditor
          fileId="f1" coreMediaUrl={VIDEO} editable
          timingLocked={false}
          cells={[cell({ id: "imported", original: "One", medium: "text", startTime: 10, endTime: 20 })]}
          onRetimeSubtitle={() => {}}
        />,
      )
      expect(gripsInSubtitleLane("imported")).toHaveLength(2)
    })

    it("SUB-36's subtitle mirror keeps its grips", () => {
      // The mirror cannot collide with the freeze — it exists only when there
      // ARE dialogue cells, and the freeze predicate needs there to be none —
      // but the predicate is scoped rather than trusted, so assert the other
      // side of it. deriveLanes only mirrors a media cell with a transcript.
      setVideoDurationSec(VIDEO, 120)
      render(
        <TimelineEditor
          fileId="f1" coreMediaUrl={VIDEO} editable
          cells={[cell({
            id: "m1", original: "One", transcription: "One", medium: "media",
            startTime: 0, endTime: 10,
          } as Partial<CellData>)]}
          onRetimeSubtitle={() => {}}
        />,
      )
      // Band off (there are dialogue cells), so both lanes render. Pick the
      // subtitle one by variant — the dialogue row is frozen by design, so an
      // index would silently assert the wrong lane.
      const lanes = screen.getAllByTestId("tl-lane")
      expect(lanes).toHaveLength(2)
      const subtitleLane = lanes.find((l) => l.getAttribute("data-variant") === "subtitle")!
      expect(within(subtitleLane).getByTestId("tl-card-m1").querySelectorAll(".cursor-ew-resize"))
        .toHaveLength(2)
    })
  })

  // Round 8 sent a gap click to the table as well, to scroll to the lines either
  // side and pulse them. Stage 2 drops that half deliberately: these gaps are
  // silences in the AUDIO cues, and the reveal matched their start second
  // against the TEXT region map, whose boundaries do not coincide — so it would
  // usually find nothing, and when it did find something it would be flashing
  // subtitle rows around a stretch where nobody SPOKE.
  it("clicking a silence in the audio row seeks its start, and does nothing else", () => {
    setVideoDurationSec(VIDEO, 120)
    const onSeekToTime = vi.fn()
    const onChipActivated = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={VIDEO} editable cells={subtitleCells}
        tracks={subtitleTracks(true)} audioCues={audioCues}
        onSeekToTime={onSeekToTime}
        onChipActivated={onChipActivated}
        onRetimeSubtitle={() => {}}
      />,
    )
    const gaps = screen.getAllByTestId("tl-source-gap")
    const middle = gaps.find((g) => g.getAttribute("data-region-start") === "20")!
    fireEvent.click(middle, { clientX: 400 })
    expect(onSeekToTime).toHaveBeenCalledWith(20)
    expect(onChipActivated).not.toHaveBeenCalled()
    expect(screen.getByTestId("tl-detail-empty")).toBeInTheDocument()
  })

  // The one deliberate UX choice of this round. Selection means "this is the
  // current chip", and everything it drives — the detail readout, the media
  // cursor, the row the text table scrolls to — is a TEXT-cell surface. An audio
  // cue has no row in any of them.
  // REWRITTEN 2026-08-14. Stage 2 asserted that an audio chip never selects,
  // because selection drove three text-cell surfaces at once and a cue has a
  // row in none of them. Stage 4 separates them instead: the chip selects and
  // fills the readout, and the dialogue table is reached through the cue's
  // LINKS. The seek half of the original is unchanged and still pinned here.
  it("an audio chip seeks the film AND selects, without touching the table", () => {
    setVideoDurationSec(VIDEO, 120)
    const onSeekToTime = vi.fn()
    const onChipActivated = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={VIDEO} editable cells={subtitleCells}
        tracks={subtitleTracks(true)} audioCues={audioCues}
        onSeekToTime={onSeekToTime}
        onChipActivated={onChipActivated}
        onRetimeSubtitle={() => {}}
      />,
    )
    // Resolved against the CUES: laneProps.onSeek looks ids up in the file's
    // own cells, where "c2" does not exist, and the chip would be a dead click.
    fireEvent.click(within(screen.getByTestId("tl-source-regions")).getByTestId("tl-card-c2"))
    expect(onSeekToTime).toHaveBeenCalledWith(30)
    // Still never onChipActivated: that scrolls the table BY CELL ID and a cue
    // has no row, so it would scroll to nothing.
    expect(onChipActivated).not.toHaveBeenCalled()
    // ...but the readout is no longer blank — the cue IS the current chip.
    expect(screen.queryByTestId("tl-detail-empty")).not.toBeInTheDocument()
    expect(screen.getByTestId("tl-detail")).toBeInTheDocument()
  })

  // Round 8, "no room, no add". These run ZOOMED IN ON PURPOSE: the buttons
  // also have a pixel floor (MIN_BUTTON_PX), and at the default 38px/s that
  // floor alone hides anything under ~0.63s — which would make these pass
  // without the length rule existing at all. At 240px/s the pixel floor clears
  // at 0.1s, so the only thing that can still hide a 0.15s gap is the new rule.
  describe("no room, no add", () => {
    const zoomedIn = (cells: CellData[]) => {
      localStorage.setItem("aquilla:timelineZoom:fzoom", String(ZOOM_MAX))
      return render(
        <TimelineEditor
          fileId="fzoom" coreMediaUrl={VIDEO} editable cells={cells}
          canAddLine allowLineCreation onAddLine={async () => null} onRetimeSubtitle={() => {}}
        />,
      )
    }

    it("offers no way in over a silence too short to hold a line", () => {
      setVideoDurationSec(VIDEO, 120)
      // 10.00–20.00, a 0.15s breath, 20.15–30.00.
      zoomedIn([
        cell({ id: "a", original: "A", medium: "text", startTime: 10, endTime: 20 }),
        cell({ id: "b", original: "B", medium: "text", startTime: 20.15, endTime: 30 }),
      ])
      expect(screen.queryByTestId("tl-add-line-20")).not.toBeInTheDocument()
      expect(screen.queryByTestId(/^tl-target-add-20/)).not.toBeInTheDocument()
      // Stage 2 dropped this test's third assertion — that the Source row also
      // declined to draw a chip over the same 0.15s. That row draws the AUDIO
      // cues now, a different set of boundaries entirely, so the two answers are
      // no longer about the same stretch. Both surfaces still share the number.
    })

    it("offers both ways in over a silence with room", () => {
      setVideoDurationSec(VIDEO, 120)
      zoomedIn([
        cell({ id: "a", original: "A", medium: "text", startTime: 10, endTime: 20 }),
        cell({ id: "b", original: "B", medium: "text", startTime: 20.3, endTime: 30 }),
      ])
      expect(screen.getByTestId("tl-add-line-20")).toBeInTheDocument()
    })

    // The project setting, off unless turned on (Sam, 2026-08-14). Adding
    // lines was built speculatively — no client asked for it — and its mic over
    // an empty stretch could mint a subtitle line and record a take matching no
    // audio cue. Clearance alone must not be enough to surface it.
    it("offers nothing without the project setting, however much clearance you have", () => {
      setVideoDurationSec(VIDEO, 120)
      localStorage.setItem("aquilla:timelineZoom:fzoom", String(ZOOM_MAX))
      render(
        <TimelineEditor
          fileId="fzoom" coreMediaUrl={VIDEO} editable
          cells={[
            cell({ id: "a", original: "A", medium: "text", startTime: 10, endTime: 20 }),
            cell({ id: "b", original: "B", medium: "text", startTime: 20.3, endTime: 30 }),
          ]}
          canAddLine onAddLine={async () => null} onRetimeSubtitle={() => {}}
        />,
      )
      expect(screen.queryByTestId("tl-add-line-20")).not.toBeInTheDocument()
      expect(screen.queryByTestId(/^tl-target-add-20/)).not.toBeInTheDocument()
    })

    // THE SETTING IS THE SINGLE AUTHORITY (Sam, 2026-08-21). Stage 4 used to
    // withdraw both ways in the moment an audio-cue track existed, which made
    // the project setting a visible no-op on every dubbing episode — Matt's
    // QA found the toggle dead. The stage-4 protection lives in the default
    // being OFF; an explicit ON means on, cue track or no cue track.
    it("keeps offering the ways in on a file with an audio-cue track — the setting decides", () => {
      setVideoDurationSec(VIDEO, 120)
      localStorage.setItem("aquilla:timelineZoom:fzoom", String(ZOOM_MAX))
      render(
        <TimelineEditor
          fileId="fzoom" coreMediaUrl={VIDEO} editable
          cells={[
            cell({ id: "a", original: "A", medium: "text", startTime: 10, endTime: 20 }),
            cell({ id: "b", original: "B", medium: "text", startTime: 20.3, endTime: 30 }),
          ]}
          canAddLine allowLineCreation onAddLine={async () => null} onRetimeSubtitle={() => {}}
          hasAudioCueTrack
        />,
      )
      // The same silence the test above offers both over.
      expect(screen.getByTestId("tl-add-line-20")).toBeInTheDocument()
    })
  })
})

// AQU-646 stage 1: the label gutter and the lanes beside it are ONE list now,
// not two hand-mirrored blocks of JSX. Every other test in this file is the
// parity net for that refactor (they all pass untouched); these two are the
// insurance for what it was for — stages 2 and 3 rename, reorder and add
// tracks by changing the list and nothing else.
describe("TimelineEditor — rows come from the track model", () => {
  beforeEach(() => { topOwner.value = 1 })

  const rowCells = [cell({ id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10 })]

  // The gutter carries no testid of its own, and must not grow one: this
  // refactor's whole contract is that it renders exactly the DOM the hardcoded
  // rows did. It is the grid column before the scrolling track.
  const gutterNames = () =>
    Array.from(
      screen.getByTestId("tl-scroll").previousElementSibling!.querySelectorAll("span.font-semibold"),
    ).map((el) => el.textContent)

  // AQU-646 stage 2: THE PREFIX SELECTORS ARE LOAD-BEARING, NOT TIDINESS. A
  // folder row and an added audio track each render a lane whose testid carries
  // the track's id, so an exact-match list would not see them — and this is the
  // one assertion that catches the gutter and the lanes falling out of step,
  // which is precisely the failure a new kind of row causes. Miss them here and
  // the guard goes blind at the exact moment the thing it guards becomes
  // possible.
  const laneRows = () =>
    Array.from(
      screen
        .getByTestId("tl-scroll")
        .querySelectorAll(
          '[data-testid="tl-lane"],[data-testid^="tl-target-lane"],[data-testid="tl-source-regions"],[data-testid^="tl-folder-lane-"]',
        ),
    ).map((el) => {
      const variant = el.getAttribute("data-variant")
      if (variant) return variant
      const id = el.getAttribute("data-testid") ?? ""
      // Collapse the namespaced ids back to a kind, so a case can assert the
      // SHAPE of the column without hard-coding generated track ids.
      if (id.startsWith("tl-folder-lane-")) return "folder"
      if (id.startsWith("tl-target-lane-")) return "added-audio"
      return id
    })

  // THE DUBBING GUARD. Stage 2 renamed every track kind and made derivation
  // file-aware; a project that imports mp3s must see none of it. This case is
  // deliberately unchanged from stage 1, down to the strings.
  it("draws the gutter and the lanes from the same list, in its order", () => {
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}} />,
    )
    expect(gutterNames()).toEqual(["Source text", "Source audio", "Target audio"])
    expect(laneRows()).toEqual(["subtitle", "dialogue", "tl-target-lane"])
  })

  it("a renamed, reordered track moves its label AND its lane", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}}
        // Through the real merge, from the deltas a file would carry: the
        // Target row named and lifted to the top.
        tracks={deriveTracksForFile({
          trackOverrides: { "target-audio": { name: "Armenian dub", order: -1 } },
        })}
      />,
    )
    expect(gutterNames()).toEqual(["Armenian dub", "Source text", "Source audio"])
    expect(laneRows()).toEqual(["tl-target-lane", "subtitle", "dialogue"])
  })

  // ── Stage 2: the same one list, drawing a subtitle file's rows ──

  const cueCells = [cell({ id: "s1", original: "One", translated: "Uno", medium: "text", startTime: 0, endTime: 4 })]
  const subtitleTracks = (hasAudioCues: boolean) =>
    deriveTracksForFile(null, { isSubtitleImport: true, hasMediaCells: false, hasAudioCues })

  it("a subtitle file with no audio VTT has no Source-audio row at all", () => {
    // Not an empty row: an empty "Source audio" reads as "this episode has no
    // speech", which is the opposite of true until someone imports the cues.
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={cueCells}
        tracks={subtitleTracks(false)} onRetimeSubtitle={() => {}}
      />,
    )
    expect(gutterNames()).toEqual(["Source text", "Target text", "Target audio"])
    expect(laneRows()).toEqual(["subtitle", "target-subtitle", "tl-target-lane"])
  })

  // Stage 3 reseated Target text from 2 to 1 (Sam: the translation belongs
  // directly under the cue it translates), so the imported audio row now lands
  // BELOW both text rows rather than between them.
  it("importing an audio VTT drops the Source-audio row into its own seat", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={cueCells}
        tracks={subtitleTracks(true)}
        audioCues={[cell({ id: "c1", original: "Whoa there", startTime: 1, endTime: 2 })]}
        onRetimeSubtitle={() => {}}
      />,
    )
    expect(gutterNames()).toEqual(["Source text", "Target text", "Source audio", "Target audio"])
    expect(laneRows()).toEqual(["subtitle", "target-subtitle", "source-audio-cues", "tl-target-lane"])
  })

  it("the Target-subtitles row shows the translation, not the source text", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={cueCells}
        tracks={subtitleTracks(false)} onRetimeSubtitle={() => {}}
      />,
    )
    const rows = screen.getAllByTestId("tl-lane")
    const target = rows.find((l) => l.getAttribute("data-variant") === "target-subtitle")!
    expect(within(target).getByTestId("tl-card-s1")).toHaveTextContent("Uno")
    expect(within(target).queryByText("One")).toBeNull()
  })

  // ── Stage 3: dragging a track's name up or down ──
  //
  // The KEYBOARD path, and it is here rather than a pointer drag on purpose: it
  // runs the identical wiring (a gutter label → proposeDropIndex's sibling
  // orderForDrop → onReorderTrack) with no geometry at all, and happy-dom gives
  // every element a 0x0 rect at the origin, so a pointer test would be
  // measuring the mock rather than the code. What it pins is the part that can
  // silently be wrong: which track moved, and what sort key it moved to.
  it("Alt+ArrowDown on a focused label moves it one place", () => {
    const onReorderTrack = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}}
        onReorderTrack={onReorderTrack}
      />,
    )
    const gutter = screen.getByTestId("tl-scroll").previousElementSibling!
    const labels = gutter.querySelectorAll<HTMLElement>("[data-tl-track-row]")
    expect(labels).toHaveLength(3)
    labels[0].focus()
    fireEvent.keyDown(labels[0], { key: "ArrowDown", altKey: true })
    // The dubbing shape's seats are 0 / 2 / 3, so Subtitles landing below
    // Source audio is the midpoint of its two NEW neighbours — one event, one
    // track, nothing else renumbered.
    expect(onReorderTrack).toHaveBeenCalledTimes(1)
    expect(onReorderTrack).toHaveBeenCalledWith("source-subtitles", 2.5)
    // And the editor does not move the row itself: the order is project-wide
    // data, so the optimistic overlay belongs to the workspace that persists it.
    expect(gutterNames()).toEqual(["Source text", "Source audio", "Target audio"])
  })

  // ── Stage 2: folders, and the two things they can silently break ──

  // Collapse state is PERSONAL and persisted per file, so it survives a
  // re-render — and would survive from one test into the next, since they all
  // mount the same fileId. Clearing it here is what keeps a case that collapses
  // a folder from silently deciding what the next case starts from.
  beforeEach(() => {
    try {
      localStorage.removeItem("aquilla:tlFoldersClosed:f1")
    } catch {
      /* private mode in some environment — nothing was persisted either */
    }
  })

  /** A file whose Target-audio row has been folded into a group, with one added
   *  audio track beside it. Built through the real merge, from the deltas a
   *  file would actually carry. */
  const foldedTracks = () =>
    deriveTracksForFile({
      trackOverrides: {
        grp: { kind: "folder", name: "Dubs", order: 4 },
        "target-audio": { groupId: "grp", order: 0 },
        "trk-es": { kind: "audio", name: "Spanish", groupId: "grp", order: 1, sourceTrackId: "source-subtitles" },
      },
    })

  // THE PARITY GUARD, WITH A FOLDER IN IT. The gutter and the lanes are two
  // `.map`s over one array, and this is the assertion that says so. A row kind
  // that renders a label and no lane — which is what a missing `laneForTrack`
  // case does, silently, because `undefined` is a valid ReactNode — shifts
  // every row below it out of line with its own label and takes the drag's
  // hit-testing with it.
  it("draws a folder and its members in both columns, in the same order", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        tracks={foldedTracks()} onRetimeSubtitle={() => {}}
      />,
    )
    expect(gutterNames()).toEqual(["Source text", "Source audio", "Dubs", "Target audio", "Spanish"])
    expect(laneRows()).toEqual(["subtitle", "dialogue", "folder", "tl-target-lane", "added-audio"])
    expect(gutterNames()).toHaveLength(laneRows().length)
  })

  it("collapsing a folder takes its members out of BOTH columns together", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        tracks={foldedTracks()} onRetimeSubtitle={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-folder-toggle-grp"))
    expect(gutterNames()).toEqual(["Source text", "Source audio", "Dubs"])
    expect(laneRows()).toEqual(["subtitle", "dialogue", "folder"])
    // …and the folder's own lane says it is standing in for them.
    expect(screen.getByTestId("tl-folder-lane-grp")).toHaveAttribute("data-collapsed")
  })

  // THE OTHER SILENT KILL SWITCH. `beginTrackDrag` bails when the rendered row
  // count disagrees with what it expects, and a collapsed folder makes that
  // true against `tracks.length`. It fails with no error and no partial
  // behaviour — the handle simply stops working — so nothing else would catch
  // it. The keyboard path shares the wiring, which is what makes it testable
  // here at all (happy-dom gives every element a 0x0 rect).
  // 2026-08-27 (Sam, second reading — the first greyed the MEMBERS, wrongly):
  // the FOLDER ROW ITSELF is the grey — one opaque band across both columns,
  // with no break at the gutter/lane edge. The break was the gutter column's
  // own `border-r`, which no row could paint over (a border sits outside the
  // content box), so the divider is now an overlay rule the opaque z-30
  // folder row covers on its own stretch.
  it("draws the folder row as one grey band across both columns, over the divider", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        tracks={foldedTracks()} onRetimeSubtitle={() => {}} onReorderTrack={() => {}}
      />,
    )
    const gutter = screen.getByTestId("tl-scroll").previousElementSibling!
    const rows = [...gutter.querySelectorAll<HTMLElement>("[data-tl-track-row]")]
    // Source text, Source audio, Dubs, Target audio, Spanish — ONLY the
    // folder wears the band; the members keep their ordinary rows (the first
    // reading of this request, reverted).
    const BAND = "bg-[color:var(--tl-folder-band)]"
    expect(rows.map((r) => r.className.includes(BAND))).toEqual([
      false, false, true, false, false,
    ])
    // Opaque and above the divider rule, which is what closes the seam…
    expect(rows[2].className).toContain("z-30")
    // …and the divider is an overlay INSIDE the gutter now, not a border on
    // it, full height as before.
    const rule = screen.getByTestId("tl-gutter-rule")
    expect(gutter.contains(rule)).toBe(true)
    expect(rule.className).toContain("inset-y-0")
    expect(gutter.className).not.toContain("border-r")
    // The lane half of the band wears the same token, so the strip is one
    // colour edge to edge.
    expect(screen.getByTestId("tl-folder-lane-grp").className).toContain(BAND)
  })

  it("keeps reordering working while a folder is collapsed", () => {
    const onReorderTrack = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        tracks={foldedTracks()} onRetimeSubtitle={() => {}} onReorderTrack={onReorderTrack}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-folder-toggle-grp"))
    const gutter = screen.getByTestId("tl-scroll").previousElementSibling!
    const labels = gutter.querySelectorAll<HTMLElement>("[data-tl-track-row]")
    expect(labels).toHaveLength(3)
    labels[0].focus()
    fireEvent.keyDown(labels[0], { key: "ArrowDown", altKey: true })
    expect(onReorderTrack).toHaveBeenCalledTimes(1)
  })

  // A DRAG REORDERS WITHIN ONE SCOPE AND NEVER ACROSS. Crossing a folder
  // boundary means writing `groupId`, which is a gated operation and a menu
  // command — and it is what keeps the ungated bare-`{order}` write from being
  // able to restructure the tree with track editing switched off.
  it("moves a folder member among its siblings, not out of the folder", () => {
    const onReorderTrack = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        tracks={foldedTracks()} onRetimeSubtitle={() => {}} onReorderTrack={onReorderTrack}
      />,
    )
    const gutter = screen.getByTestId("tl-scroll").previousElementSibling!
    const labels = gutter.querySelectorAll<HTMLElement>("[data-tl-track-row]")
    // Row 3 is Target audio, the first member of "Dubs".
    labels[3].focus()
    fireEvent.keyDown(labels[3], { key: "ArrowDown", altKey: true })
    // Past "Spanish" (order 1) inside the folder — NOT out of it, and the patch
    // carries an order alone, so it stays ungated.
    expect(onReorderTrack).toHaveBeenCalledWith("target-audio", 2)
  })

  it("Alt+ArrowUp on a folder's FIRST member does nothing, rather than ejecting it", () => {
    const onReorderTrack = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        tracks={foldedTracks()} onRetimeSubtitle={() => {}} onReorderTrack={onReorderTrack}
      />,
    )
    const gutter = screen.getByTestId("tl-scroll").previousElementSibling!
    const labels = gutter.querySelectorAll<HTMLElement>("[data-tl-track-row]")
    labels[3].focus()
    fireEvent.keyDown(labels[3], { key: "ArrowUp", altKey: true })
    expect(onReorderTrack).not.toHaveBeenCalled()
  })

  // A folder's colour would say nothing, and its open/closed state says
  // everything — so its disclosure control stands where every other row's
  // colour dot stands, and the column of glyphs stays a column.
  // ── Stage 2: the two gates, seen from the UI ──
  //
  // The setting is the SECOND gate, on top of the maintainer floor, and what it
  // controls is whether a project's timelines can be RESTRUCTURED. What it must
  // never control is rename and drag-to-reorder, which already ship: a new
  // setting defaulting to off must not silently take an existing capability
  // away from every project that has one.

  const editingActions = () => ({
    onAdd: vi.fn((_spec: { kind: string; name: string }) => "new-track-id"),
    onSetColor: vi.fn(),
    onLeaveFolder: vi.fn(),
    onMoveToScope: vi.fn(),
    onCreateFolderFrom: vi.fn((_ids: readonly string[]) => "new-folder-id"),
    onDelete: vi.fn(),
  })

  it("with the setting off, the Add-track button does not exist", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}}
        onReorderTrack={vi.fn()} onRenameTrack={vi.fn()}
      />,
    )
    // ABSENT, not disabled (Sam, 2026-08-22). A greyed-out control advertises a
    // capability the project has switched off and invites a hunt for why it
    // will not click.
    expect(screen.queryByTestId("tl-add-track")).toBeNull()
  })

  it("with the setting on, the Add-track button is there", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}}
        onReorderTrack={vi.fn()} onRenameTrack={vi.fn()} trackEditing={editingActions()}
      />,
    )
    expect(screen.getByTestId("tl-add-track")).toBeTruthy()
  })

  it("offers rename only with the setting off, and the full menu with it on", () => {
    const { unmount } = render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}}
        onReorderTrack={vi.fn()} onRenameTrack={vi.fn()}
      />,
    )
    // A pointer's own ctrl-click → `contextmenu` synthesis is the BROWSER's, so
    // happy-dom will not produce one either; the event is dispatched directly.
    fireEvent.contextMenu(screen.getByTestId("tl-scroll").previousElementSibling!
      .querySelectorAll<HTMLElement>("[data-tl-track-row]")[0])
    expect(screen.getByText("Rename")).toBeTruthy()
    expect(screen.queryByText("Colour")).toBeNull()
    expect(screen.queryByText("New folder from this track")).toBeNull()
    unmount()

    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}}
        onReorderTrack={vi.fn()} onRenameTrack={vi.fn()} trackEditing={editingActions()}
      />,
    )
    fireEvent.contextMenu(screen.getByTestId("tl-scroll").previousElementSibling!
      .querySelectorAll<HTMLElement>("[data-tl-track-row]")[0])
    expect(screen.getByText("Rename")).toBeTruthy()
    expect(screen.getByText("New folder from this track")).toBeTruthy()
  })

  // The whole row of new machinery is withheld from someone who can do neither:
  // no trigger, no `⋯`, no `select-none` the trigger would add. The row a
  // viewer sees is the row that shipped.
  it("adds nothing at all to a row when the person can do neither", () => {
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}} />,
    )
    expect(screen.queryByTestId("tl-track-menu-target-audio")).toBeNull()
    expect(screen.queryByTestId("tl-add-track")).toBeNull()
  })

  // Deleting really deletes, so it asks — and it asks with the NUMBER, which is
  // the fact the person is being asked to accept.
  it("asks before deleting, naming the track", () => {
    const editing = editingActions()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}}
        tracks={deriveTracksForFile({
          trackOverrides: { "trk-es": { kind: "audio", name: "Spanish", order: 5 } },
        })}
        onReorderTrack={vi.fn()} onRenameTrack={vi.fn()} trackEditing={editing}
      />,
    )
    const rows = screen.getByTestId("tl-scroll").previousElementSibling!
      .querySelectorAll<HTMLElement>("[data-tl-track-row]")
    fireEvent.contextMenu(rows[rows.length - 1])
    fireEvent.click(screen.getByText("Delete track"))
    // The menu opens the QUESTION; nothing is deleted until it is answered.
    expect(editing.onDelete).not.toHaveBeenCalled()
    expect(screen.getByTestId("tl-delete-track-dialog")).toHaveTextContent("Spanish")
    fireEvent.click(screen.getByTestId("tl-delete-track-confirm"))
    expect(editing.onDelete).toHaveBeenCalledWith(["trk-es"])
  })

  // ── AQU-646 stage 6D ───────────────────────────────────────────────────────
  //
  // …AND THE NUMBER HAS TO BE TRUE, which is what nothing checked. The count
  // scanned only the ACTIVE file's audio, so on a file whose takes live on its
  // audio-cue sibling the dialog said "This track has no recordings on it" and
  // then orphaned them — Sam lost two tracks' takes that way on 2026-08-27.
  it("counts takes that live on the cue sibling, not just this file's", () => {
    const editing = editingActions()
    const cueWithTake = [
      cell({
        id: "cue1", fileId: "f1-cues", original: "One", medium: "media", startTime: 0, endTime: 4,
        selectedBySlot: { "trk-es": "aud-es" },
        attachments: {
          "aud-es": { audioId: "aud-es", slot: "trk-es", url: "frontier-audio://aud-es" },
        },
      } as unknown as Partial<CellData>),
    ]
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}}
        audioCues={cueWithTake}
        targetCells={cueWithTake}
        tracks={deriveTracksForFile({
          trackOverrides: { "trk-es": { kind: "audio", name: "Spanish", order: 5 } },
        })}
        onReorderTrack={vi.fn()} onRenameTrack={vi.fn()} trackEditing={editing}
      />,
    )
    const rows = screen.getByTestId("tl-scroll").previousElementSibling!
      .querySelectorAll<HTMLElement>("[data-tl-track-row]")
    fireEvent.contextMenu(rows[rows.length - 1])
    fireEvent.click(screen.getByText("Delete track"))
    const dialog = screen.getByTestId("tl-delete-track-dialog")
    // The take is counted and named…
    expect(dialog).toHaveTextContent("1 recording on this track will be deleted with it.")
    // …and the sentence that would have been a lie is nowhere on screen.
    expect(dialog).not.toHaveTextContent("no recordings")
  })

  // Only a track someone MADE. A derived row is a fact about the file — its
  // subtitles, its source audio, its dub — so "delete" could only mean "hide
  // it", which there is no state for.
  it("does not offer to delete a derived row", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}}
        onReorderTrack={vi.fn()} onRenameTrack={vi.fn()} trackEditing={editingActions()}
      />,
    )
    fireEvent.contextMenu(screen.getByTestId("tl-scroll").previousElementSibling!
      .querySelectorAll<HTMLElement>("[data-tl-track-row]")[0])
    expect(screen.queryByText("Delete track")).toBeNull()
  })

  it("renames in place, and commits only a changed, non-empty name", () => {
    const onRenameTrack = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}}
        onReorderTrack={vi.fn()} onRenameTrack={onRenameTrack}
      />,
    )
    fireEvent.contextMenu(screen.getByTestId("tl-scroll").previousElementSibling!
      .querySelectorAll<HTMLElement>("[data-tl-track-row]")[0])
    fireEvent.click(screen.getByText("Rename"))
    const input = screen.getByTestId("tl-track-rename-source-subtitles") as HTMLInputElement
    fireEvent.change(input, { target: { value: "  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    // An empty name is not a name — it would store an invisible label with no
    // way to tell it from a bug.
    expect(onRenameTrack).not.toHaveBeenCalled()

    fireEvent.contextMenu(screen.getByTestId("tl-scroll").previousElementSibling!
      .querySelectorAll<HTMLElement>("[data-tl-track-row]")[0])
    fireEvent.click(screen.getByText("Rename"))
    const again = screen.getByTestId("tl-track-rename-source-subtitles") as HTMLInputElement
    fireEvent.change(again, { target: { value: "Captions" } })
    fireEvent.keyDown(again, { key: "Enter" })
    expect(onRenameTrack).toHaveBeenCalledWith("source-subtitles", "Captions")
  })

  // A REGRESSION TEST FOR A BUG THIS ROUND SHIPPED AND FIXED. The rename starts
  // from a menu item, and Base UI hands focus back to the menu's trigger when
  // the menu closes — which lands after the input has mounted. With `autoFocus`
  // and an unguarded `onBlur`, the field focused, immediately blurred as the
  // row took focus back, and committed the untouched name: the editor vanished
  // the instant it appeared, with nothing on screen to say why.
  it("keeps the rename field open when the menu hands focus back", () => {
    const onRenameTrack = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}}
        onReorderTrack={vi.fn()} onRenameTrack={onRenameTrack}
      />,
    )
    const row = screen.getByTestId("tl-scroll").previousElementSibling!
      .querySelectorAll<HTMLElement>("[data-tl-track-row]")[0]
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText("Rename"))
    // The field is still there…
    const input = screen.getByTestId("tl-track-rename-source-subtitles")
    // …and a blur it never actually held focus for commits nothing.
    fireEvent.blur(input)
    expect(screen.getByTestId("tl-track-rename-source-subtitles")).toBeTruthy()
    expect(onRenameTrack).not.toHaveBeenCalled()
  })

  // ── Stage 2b: a track is something you select ──

  const gutter = () => screen.getByTestId("tl-scroll").previousElementSibling!
  const rows = () => gutter().querySelectorAll<HTMLElement>("[data-tl-track-row]")
  const selectedRows = () =>
    Array.from(gutter().querySelectorAll<HTMLElement>("[data-selected]")).map(
      (el) => el.querySelector("span.truncate")?.textContent,
    )

  const selectable = (extra: Record<string, unknown> = {}) => (
    <TimelineEditor
      fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}}
      onReorderTrack={vi.fn()} onRenameTrack={vi.fn()} {...extra}
    />
  )

  it("selects one track on a plain click, and replaces the selection on the next", () => {
    render(selectable())
    fireEvent.click(rows()[0])
    expect(selectedRows()).toEqual(["Source text"])
    fireEvent.click(rows()[2])
    expect(selectedRows()).toEqual(["Target audio"])
  })

  it("adds and removes with ⌘, and takes the run with shift", () => {
    render(selectable())
    fireEvent.click(rows()[0])
    fireEvent.click(rows()[2], { metaKey: true })
    expect(selectedRows()).toEqual(["Source text", "Target audio"])
    // ⌘ on one already in the selection takes it back out.
    fireEvent.click(rows()[2], { metaKey: true })
    expect(selectedRows()).toEqual(["Source text"])
    fireEvent.click(rows()[2], { shiftKey: true })
    expect(selectedRows()).toEqual(["Source text", "Source audio", "Target audio"])
  })

  // FOLDERS ARE NOT TRACKS (Sam, 2026-08-24). Clicking one opens and closes it;
  // it never joins a selection, so no bulk operation can ever be handed one.
  it("toggles a folder open and closed instead of selecting it", () => {
    render(selectable({ tracks: foldedTracks() }))
    const folderRow = Array.from(rows()).find((r) => r.textContent?.includes("Dubs"))!
    expect(gutterNames()).toContain("Spanish")
    fireEvent.click(folderRow)
    expect(gutterNames()).not.toContain("Spanish")
    expect(selectedRows()).toEqual([])
    fireEvent.click(folderRow)
    expect(gutterNames()).toContain("Spanish")
  })

  it("steps a shift-range over a folder rather than swallowing it", () => {
    render(selectable({ tracks: foldedTracks() }))
    // Subtitles … then shift to the last real track, across the "Dubs" row.
    fireEvent.click(rows()[0])
    const spanish = Array.from(rows()).find((r) => r.textContent?.includes("Spanish"))!
    fireEvent.click(spanish, { shiftKey: true })
    expect(selectedRows()).not.toContain("Dubs")
    expect(selectedRows()).toContain("Spanish")
  })

  it("does not select on a click that was really a drag", () => {
    render(selectable())
    const row = rows()[0]
    fireEvent.pointerDown(row, { clientY: 100, pointerId: 1, button: 0 })
    fireEvent.pointerMove(window, { clientY: 160 })
    fireEvent.pointerUp(window, { clientY: 160 })
    fireEvent.click(row)
    expect(selectedRows()).toEqual([])
  })

  it("leaves the speaker button's own click alone", () => {
    render(selectable())
    // The Source-audio row carries the speaker; pressing it must mute, not select.
    fireEvent.click(screen.getByTestId("tl-speaker-source"))
    expect(selectedRows()).toEqual([])
  })

  // ── Stage 2b: the menu acts on the selection ──

  it("right-clicking outside the selection makes that row the selection", () => {
    render(selectable({ trackEditing: editingActions() }))
    fireEvent.click(rows()[0])
    fireEvent.contextMenu(rows()[2])
    expect(selectedRows()).toEqual(["Target audio"])
  })

  // AQU-646 stage 7: EVERY row carries a hue and an identity bar, derived rows
  // included — their fixed colours went through the same hue-plus-alpha
  // vocabulary as the pickable ones, so the gutter reads as one system rather
  // than as two. A folder is the exception: it is a heading, not a track.
  it("gives every track row an accent bar and a hue, and a folder neither", () => {
    render(selectable({ trackEditing: editingActions(), tracks: foldedTracks() }))
    const named = (name: string) => Array.from(rows()).find((r) => r.textContent?.includes(name))!

    // THE BAR IS A CLASS ON THE ROW, never a new element: an accent span would
    // become the row's firstElementChild, which the drop-indent test reads.
    const audio = named("Target audio") as HTMLElement
    expect(audio.className).toContain("border-l-4")
    expect(audio.className).toContain("border-l-[color:var(--tl-track-hue)]")
    expect(audio.style.getPropertyValue("--tl-track-hue")).toBe("#40c06e")

    // A source row is not PICKABLE, but it still has a colour of its own and
    // is now drawn the same way — that is the whole of this change.
    const source = named("Source text") as HTMLElement
    expect(source.className).toContain("border-l-4")
    expect(source.style.getPropertyValue("--tl-track-hue")).toBe("#8b93a3")

    // …and every row's hue is its own, not one shared default.
    const dubs = named("Dubs") as HTMLElement // the folder
    expect(dubs.className).not.toContain("border-l-4")
    expect(dubs.style.getPropertyValue("--tl-track-hue")).toBe("")
  })

  // AQU-646 stage 7: SIX SWATCHES IN A SUBMENU, one click each (Sam,
  // 2026-08-27: "all the user needs to see is the six colors to pick from").
  // The picker dialog that briefly stood between the menu and the colour went
  // with the custom colours that needed it.
  it("recolours every selected track in one call, one value each", () => {
    const editing = editingActions()
    render(selectable({ trackEditing: editing, tracks: foldedTracks() }))
    const named = (name: string) => Array.from(rows()).find((r) => r.textContent?.includes(name))!
    fireEvent.click(named("Target audio"))
    fireEvent.click(named("Spanish"), { metaKey: true })
    fireEvent.contextMenu(named("Spanish"))
    fireEvent.click(screen.getByText("Colour 2 tracks"))
    fireEvent.click(screen.getByText("Magenta"))

    expect(editing.onSetColor).toHaveBeenCalledTimes(1)
    // ONE CALL, ONE VALUE PER TRACK — the payload's shape never depended on
    // where the colour came from. The value is the preset's ID, not its hex:
    // what an id LOOKS like is this build's business, not the project's.
    const [updates] = editing.onSetColor.mock.calls[0] as [{ trackId: string; color: string }[]]
    expect([...updates].sort((a, b) => a.trackId.localeCompare(b.trackId))).toEqual([
      { trackId: "target-audio", color: "magenta" },
      { trackId: "trk-es", color: "magenta" },
    ])
  })

  // Stage 3c, Sam's revision: ALL of them or none. Colouring "the two of these
  // five that can take one" is a partial success the menu cannot describe.
  it("offers a colour only when EVERY selected track can take one", () => {
    const editing = editingActions()
    render(selectable({ trackEditing: editing, tracks: foldedTracks() }))
    const named = (name: string) => Array.from(rows()).find((r) => r.textContent?.includes(name))!
    // Two colourable rows on their own: offered.
    fireEvent.click(named("Target audio"))
    fireEvent.click(named("Spanish"), { metaKey: true })
    fireEvent.contextMenu(named("Spanish"))
    expect(screen.getByText("Colour 2 tracks")).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: "Escape" })

    // Add the Source text row, which is not colourable — grey is deliberate
    // (Sam) — and the whole item goes rather than silently acting on two.
    fireEvent.click(named("Source text"), { metaKey: true })
    fireEvent.contextMenu(named("Source text"))
    expect(screen.queryByText(/^Colour/)).toBeNull()
  })

  it("offers no colour on a single row that cannot take one", () => {
    render(selectable({ trackEditing: editingActions() }))
    fireEvent.contextMenu(rows()[0])
    expect(screen.queryByText("Colour")).toBeNull()
  })

  // Stage 3c (Sam, 2026-08-24): the verb used to eject the track from the
  // folder it was in and make a fresh top-level folder at the BOTTOM of the
  // list — not what "new folder from this track" says it does. He chose
  // withholding it over allowing subfolders, which one level is enforced by
  // construction throughout track-groups anyway.
  it("does not offer a new folder for a track that is already in one", () => {
    render(selectable({ trackEditing: editingActions(), tracks: foldedTracks() }))
    const named = (name: string) => Array.from(rows()).find((r) => r.textContent?.includes(name))!
    fireEvent.contextMenu(named("Spanish"))
    expect(screen.queryByText(/^New folder/)).toBeNull()
    // The honest route out is right there instead.
    expect(screen.getByText("Take out of folder")).toBeInTheDocument()
  })

  // Sam, 2026-08-25: with tracks both inside and outside a folder selected, the
  // menu offered BOTH verbs, each quietly scoped to its own half — "make a
  // folder out of two of these" next to "eject the other three", with nothing
  // saying which was which. They are opposites; a selection that could take
  // either is one the user has not finished making.
  it("offers NEITHER foldering verb on a selection that straddles a folder", () => {
    render(selectable({ trackEditing: editingActions(), tracks: foldedTracks() }))
    const named = (name: string) => Array.from(rows()).find((r) => r.textContent?.includes(name))!
    // Spanish is inside the folder; Source audio is not.
    fireEvent.click(named("Spanish"))
    fireEvent.click(named("Source audio"), { metaKey: true })
    fireEvent.contextMenu(named("Source audio"))
    expect(screen.queryByText(/^New folder/)).toBeNull()
    expect(screen.queryByText(/^Take out of folder/)).toBeNull()
  })

  it("still offers each verb when the selection is all one way", () => {
    const editing = editingActions()
    render(selectable({ trackEditing: editing, tracks: foldedTracks() }))
    const named = (name: string) => Array.from(rows()).find((r) => r.textContent?.includes(name))!
    // All inside → eject, no new-folder.
    fireEvent.click(named("Target audio"))
    fireEvent.click(named("Spanish"), { metaKey: true })
    fireEvent.contextMenu(named("Spanish"))
    expect(screen.getByText(/^Take 2 tracks out of/)).toBeInTheDocument()
    expect(screen.queryByText(/^New folder/)).toBeNull()
    fireEvent.keyDown(document.body, { key: "Escape" })

    // All outside → new-folder, no eject.
    fireEvent.click(named("Source audio"))
    fireEvent.contextMenu(named("Source audio"))
    expect(screen.getByText(/^New folder/)).toBeInTheDocument()
    expect(screen.queryByText(/^Take out of folder/)).toBeNull()
  })

  it("makes a folder FROM the selection, and there is no move-to-folder", () => {
    const editing = editingActions()
    render(selectable({ trackEditing: editing }))
    fireEvent.click(rows()[1])
    fireEvent.click(rows()[2], { metaKey: true })
    fireEvent.contextMenu(rows()[2])
    expect(screen.queryByText(/move to folder/i)).toBeNull()
    fireEvent.click(screen.getByText("New folder from 2 tracks"))
    expect(editing.onCreateFolderFrom).toHaveBeenCalledTimes(1)
    expect((editing.onCreateFolderFrom.mock.calls[0][0] as string[]).sort()).toEqual([
      "source-audio",
      "target-audio",
    ])
  })

  it("deletes a whole selection behind one confirmation", () => {
    const editing = editingActions()
    render(
      selectable({
        trackEditing: editing,
        tracks: deriveTracksForFile({
          trackOverrides: {
            "trk-a": { kind: "audio", name: "One", order: 5 },
            "trk-b": { kind: "audio", name: "Two", order: 6 },
          },
        }),
      }),
    )
    const named = (name: string) => Array.from(rows()).find((r) => r.textContent?.includes(name))!
    fireEvent.click(named("One"))
    fireEvent.click(named("Two"), { metaKey: true })
    fireEvent.contextMenu(named("Two"))
    fireEvent.click(screen.getByText("Delete 2 tracks"))
    expect(editing.onDelete).not.toHaveBeenCalled()
    expect(screen.getByTestId("tl-delete-track-dialog")).toHaveTextContent("Delete 2 tracks?")
    fireEvent.click(screen.getByTestId("tl-delete-track-confirm"))
    expect((editing.onDelete.mock.calls[0][0] as string[]).sort()).toEqual(["trk-a", "trk-b"])
  })

  it("gives a folder a disclosure control instead of a colour dot", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        tracks={foldedTracks()} onRetimeSubtitle={() => {}}
      />,
    )
    const toggle = screen.getByTestId("tl-folder-toggle-grp")
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    fireEvent.click(toggle)
    expect(screen.getByTestId("tl-folder-toggle-grp")).toHaveAttribute("aria-expanded", "false")
  })
})

// AQU-646 stage 1: Free timing does not exist for a subtitle import — its cues
// are already timed to a video — so such a file has exactly one mode, and the
// workspace withholds the control entirely rather than showing an
// unchangeable label. A choice nobody can make is only a question.
describe("TimelineEditor — withholding the timing-mode control", () => {
  beforeEach(() => { topOwner.value = 1 })

  const editor = (extra: Record<string, unknown>) => (
    <TimelineEditor
      fileId="hidemode" coreMediaUrl={null} editable cells={[]} onRetimeSubtitle={() => {}} {...extra}
    />
  )

  it("hideTimingMode removes it above the maintainer floor and below it alike", () => {
    const { rerender } = render(editor({ hideTimingMode: true, onChangeTimingMode: vi.fn() }))
    expect(screen.queryByTestId("tl-timing-mode")).toBeNull()
    expect(screen.queryByTestId("tl-timing-mode-dubbing")).toBeNull()
    // Below the floor the same prop must not leave the read-only label behind.
    rerender(editor({ hideTimingMode: true }))
    expect(screen.queryByTestId("tl-timing-mode")).toBeNull()
    expect(screen.queryByTestId("tl-timing-mode-dubbing")).toBeNull()
  })

  it("is shown by default — an imported recording still chooses its mode", () => {
    render(editor({ onChangeTimingMode: vi.fn() }))
    expect(screen.getByTestId("tl-timing-mode")).toHaveAttribute("data-mode", "dubbing")
    expect(screen.getByTestId("tl-timing-mode-audioFirst")).toBeInTheDocument()
  })
})

// ── Stage 4: what linking mode says when it KNOWS nothing ──
//
// 2026-08-14: a dead cell_links table (read failing) plus a matcher that had
// never run rendered as every one of 548 cues confidently amber — "unlinked" —
// which reads as a fact nobody has. The amber mark exists to surface a handful
// of genuine orphans among hundreds of pairings; in both know-nothing states it
// is suppressed and a sentence says the true thing instead.
describe("TimelineEditor — linking mode's know-nothing states", () => {
  beforeEach(() => { topOwner.value = 1; resetVideoDurationsForTests() })

  const VIDEO = "https://cdn/episode.m3u8"

  const subs = [
    cell({ id: "s1", original: "One", medium: "text", startTime: 10, endTime: 20 }),
    cell({ id: "s2", original: "Two", medium: "text", startTime: 30, endTime: 40 }),
  ]
  const cues = [
    cell({ id: "c1", original: "One", startTime: 10, endTime: 20 }),
    cell({ id: "c2", original: "Whoa!", startTime: 25, endTime: 26 }),
  ]
  const tracks = deriveTracksForFile(null, { isSubtitleImport: true, hasMediaCells: false, hasAudioCues: true })

  const renderLinking = (over: Record<string, unknown> = {}) => {
    setVideoDurationSec(VIDEO, 120)
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={VIDEO} editable cells={subs}
        tracks={tracks} audioCues={cues} onRetimeSubtitle={() => {}}
        onToggleCueLink={() => {}}
        {...over}
      />,
    )
    armLinking()
  }

  const amberCount = () =>
    screen.getAllByTestId("tl-link-target").filter((el) => el.dataset.linkState === "unlinked").length

  it("suppresses every amber mark and explains, when nothing has ever been paired", () => {
    renderLinking({ cueLinks: buildCueLinkIndex([]) })
    expect(amberCount()).toBe(0)
    expect(screen.getByTestId("tl-linking-notice")).toHaveTextContent(/never been paired/)
  })

  it("suppresses amber and says so in red when the links READ failed", () => {
    // Failed ≠ empty: we could not ask, so we do not know. Even links we DO
    // hold locally may be stale, hence the notice rather than silence.
    renderLinking({
      cueLinks: buildCueLinkIndex([{
        kind: "text-audio", fromFileId: "f1", fromCellId: "s1",
        toFileId: "f-cues", toCellId: "c1", origin: "auto", confidence: 1,
      }]),
      cueLinksFailed: true,
    })
    expect(amberCount()).toBe(0)
    expect(screen.getByTestId("tl-linking-notice")).toHaveTextContent(/couldn't be loaded/)
  })

  it("marks ONLY the genuine orphans once real pairings exist", () => {
    // c1 is paired; c2 ("Whoa!") is a real orphan and keeps its mark. s2 is an
    // unpaired subtitle and keeps its mark on the text row.
    renderLinking({
      cueLinks: buildCueLinkIndex([{
        kind: "text-audio", fromFileId: "f1", fromCellId: "s1",
        toFileId: "f-cues", toCellId: "c1", origin: "auto", confidence: 1,
      }]),
    })
    const amber = screen.getAllByTestId("tl-link-target").filter((el) => el.dataset.linkState === "unlinked")
    expect(amber.map((el) => el.dataset.cellId).sort()).toEqual(["c2", "s2"])
    expect(screen.queryByTestId("tl-linking-notice")).not.toBeInTheDocument()
  })
})

// ── The Target audio row is about the file's UNITS, not about a video ──
//
// Sam, 2026-08-14: "the target audio recording buttons aligned with existing
// cells should always be there and should not be gated by anything." The row
// used to resolve `subtitleFileWithFootage ? subtitle : dialogue`, so a
// subtitle file with no video linked fell through to `dialogue` — which a VTT
// import never fills — and came up completely empty: no chips, no per-line
// record buttons, no way in from the timeline at all.
describe("TimelineEditor — the Target audio row's units", () => {
  beforeEach(() => { topOwner.value = 1; resetVideoDurationsForTests() })

  const subs = [
    cell({ id: "s1", original: "One", medium: "text", startTime: 0, endTime: 4 }),
    cell({ id: "s2", original: "Two", medium: "text", startTime: 5, endTime: 9 }),
  ]
  const tracks = (hasAudioCues: boolean) =>
    deriveTracksForFile(null, { isSubtitleImport: true, hasMediaCells: false, hasAudioCues })

  const recordButtons = () => screen.queryAllByTestId(/^tl-target-empty-.*-record$/)

  it("offers a record button per subtitle line with NO video linked", () => {
    // The case that was broken outright.
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={subs}
        tracks={tracks(false)} onRetimeSubtitle={() => {}} onOpenRecording={() => {}}
      />,
    )
    expect(recordButtons()).toHaveLength(2)
  })

  it("still offers one per line WITH a video linked", () => {
    // Unchanged: a subtitle-with-footage file has an empty dialogue lane and
    // still lands on the subtitle cells.
    setVideoDurationSec("https://cdn/e.m3u8", 60)
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl="https://cdn/e.m3u8" editable cells={subs}
        tracks={tracks(false)} onRetimeSubtitle={() => {}} onOpenRecording={() => {}}
      />,
    )
    expect(recordButtons()).toHaveLength(2)
  })

  it("realigns onto the audio cues once an audio VTT is imported", () => {
    // Same row, different units — three cues, so three buttons, regardless of
    // there being two subtitle lines.
    const cues = [
      cell({ id: "c1", original: "One", startTime: 0, endTime: 2 }),
      cell({ id: "c2", original: "and a half", startTime: 2, endTime: 4 }),
      cell({ id: "c3", original: "Two", startTime: 5, endTime: 9 }),
    ]
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={subs}
        tracks={tracks(true)} audioCues={cues} targetCells={cues}
        onRetimeSubtitle={() => {}} onOpenRecording={() => {}}
      />,
    )
    expect(recordButtons().map((b) => b.getAttribute("data-testid")).sort()).toEqual([
      "tl-target-empty-c1-record",
      "tl-target-empty-c2-record",
      "tl-target-empty-c3-record",
    ])
  })
})

// While the matcher is writing pairings (Sam, 2026-08-14: "a little loading
// circle... just to indicate the links are working themselves out and it's not
// just broken"). It is several hundred events and a few round trips, and until
// it lands the row is indistinguishable from a matcher that found nothing.
describe("TimelineEditor — pairing in progress", () => {
  beforeEach(() => { topOwner.value = 1; resetVideoDurationsForTests() })

  const subs = [cell({ id: "s1", original: "One", medium: "text", startTime: 10, endTime: 20 })]
  const cues = [cell({ id: "c1", original: "One", startTime: 10, endTime: 20 })]
  const tracks = deriveTracksForFile(null, {
    isSubtitleImport: true, hasMediaCells: false, hasAudioCues: true,
  })

  const renderPairing = (over: Record<string, unknown> = {}) =>
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={subs}
        tracks={tracks} audioCues={cues} onRetimeSubtitle={() => {}}
        onToggleCueLink={() => {}} {...over}
      />,
    )

  it("says it is pairing rather than offering to", () => {
    renderPairing({ cueLinksPending: true })
    expect(screen.getByTestId("tl-check-menu")).toHaveTextContent("Check")
  })

  it("goes back to offering once the pairings have landed", () => {
    renderPairing({ cueLinksPending: false })
    fireEvent.click(screen.getByTestId("tl-check-menu"))
    expect(screen.getByText("Check links")).toBeInTheDocument()
  })

  it("does not claim 'never been paired' while pairing is still running", () => {
    // The notice is for a standing state. Mid-write it is a state actively
    // being left, and saying so would send you off to fix what is fixing itself.
    renderPairing({ cueLinksPending: true })
    armLinking()
    expect(screen.queryByTestId("tl-linking-notice")).not.toBeInTheDocument()
  })

  it("still says it once pairing has finished and found nothing", () => {
    renderPairing({ cueLinksPending: false })
    armLinking()
    expect(screen.getByTestId("tl-linking-notice")).toHaveTextContent(/never been paired/)
  })
})

// ── An audio cue is a real selection (Sam, 2026-08-14) ──
//
// Stage 2 made cue chips seek-only, because selection drove three text-cell
// surfaces and a cue has a row in none of them. That was the wrong repair: the
// chip should select and draw as selected and fill the timing readout, and the
// one surface that genuinely needs a text row — the dialogue table — should be
// reached through the cue's LINKS, which stage 4 finally makes possible.
describe("TimelineEditor — selecting an audio cue", () => {
  beforeEach(() => { topOwner.value = 1; resetVideoDurationsForTests() })

  const subs = [cell({ id: "s1", original: "One", medium: "text", startTime: 0, endTime: 4 })]
  const cues = [
    cell({ id: "c1", original: "Whoa there", startTime: 10, endTime: 20 }),
    cell({ id: "c2", original: "Easy now", startTime: 30, endTime: 40 }),
  ]
  const tracks = deriveTracksForFile(null, {
    isSubtitleImport: true, hasMediaCells: false, hasAudioCues: true,
  })

  const CUE_VIDEO = "https://cdn/episode.m3u8"
  const renderCues = (over: Record<string, unknown> = {}) => {
    setVideoDurationSec(CUE_VIDEO, 120)
    return render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={CUE_VIDEO} editable cells={subs}
        tracks={tracks} audioCues={cues} onRetimeSubtitle={() => {}} {...over}
      />,
    )
  }

  const cueCard = (id: string) =>
    within(screen.getByTestId("tl-source-regions")).getByTestId(`tl-card-${id}`)

  it("marks the chip as selected when it is clicked", () => {
    renderCues()
    expect(cueCard("c1").className).not.toContain("ring-sky-500")
    fireEvent.click(cueCard("c1"))
    expect(cueCard("c1").className).toContain("ring-sky-500")
  })

  it("fills the timing readout, which used to come up blank for cues", () => {
    // `currentCell` searched only this file's cells, and a cue lives in the
    // hidden sibling — so every chip on this row read as nothing selected.
    renderCues()
    expect(screen.getByTestId("tl-detail-empty")).toBeInTheDocument()
    fireEvent.click(cueCard("c1"))
    expect(screen.getByTestId("tl-detail")).toBeInTheDocument()
  })

  it("reports the cue so the workspace can follow its links to the table", () => {
    const onCueActivated = vi.fn()
    renderCues({ onCueActivated })
    fireEvent.click(cueCard("c2"))
    expect(onCueActivated).toHaveBeenCalledWith("c2")
  })

  it("never routes a cue through onChipActivated", () => {
    // That one scrolls the dialogue table BY CELL ID, and a cue has no row —
    // it would scroll to nothing and silently disengage follow.
    const onChipActivated = vi.fn()
    renderCues({ onChipActivated, onCueActivated: vi.fn() })
    fireEvent.click(cueCard("c1"))
    expect(onChipActivated).not.toHaveBeenCalled()
  })
})

// ── The checks are setup work, not contributor work ──────────────────────
//
// Reviewing pairings and settling character disagreements happens BEFORE a file
// reaches translators and dubbers — and they are exactly the contributors who
// should not be re-deciding it afterwards. The client's producer sets projects
// up, so she clears the bar; a contributor does not. (Sam, 2026-08-18.)
//
// The IMPORT was already gated; these two surfaces were not — ProjectWorkspace
// always passed the handler, so anyone could open the drawer and write
// resolutions.

describe("who may use the Check tools", () => {
  const checkProps = {
    cells: [
      { id: "s1", fileId: "f1", original: "One", translated: "", startTime: 0, endTime: 2 },
      { id: "s2", fileId: "f1", original: "Two", translated: "", startTime: 3, endTime: 5 },
    ] as unknown as React.ComponentProps<typeof TimelineEditor>["cells"],
    coreMediaUrl: null,
    fileId: "f1",
    onRetimeSubtitle: () => {},
    audioCues: [
      { id: "q1", fileId: "f2", original: "One", startTime: 0, endTime: 2 },
    ] as unknown as React.ComponentProps<typeof TimelineEditor>["audioCues"],
    onToggleCueLink: () => {},
    onReviewCharacterDisagreements: () => {},
    editable: true,
  } satisfies Partial<React.ComponentProps<typeof TimelineEditor>>

  it("offers both checks when the bar is cleared", () => {
    render(<TimelineEditor {...checkProps} canCheck />)
    fireEvent.click(screen.getByTestId("tl-check-menu"))
    expect(screen.getByText("Check links")).toBeInTheDocument()
    expect(screen.getByText("Check characters")).toBeInTheDocument()
  })

  it("hides the whole menu below it", () => {
    render(<TimelineEditor {...checkProps} canCheck={false} />)
    expect(screen.queryByTestId("tl-check-menu")).not.toBeInTheDocument()
  })

  it("leaves Sources alone — importing has its own floor", () => {
    render(
      <TimelineEditor
        {...checkProps}
        canCheck={false}
        onRequestImportCharacters={() => {}}
        canImportCharacters
      />,
    )
    expect(screen.getByTestId("tl-sources-menu")).toBeInTheDocument()
  })
})

// ── Sources is project setup (Sam, 2026-08-18) ───────────────────────────
//
// The film, the audio cues and the character sheets are all attached before
// the file is handed to translators and dubbers, and all three are gated at
// project lead. A button that opens onto three greyed-out rows reads as "you
// are missing something" rather than "this is not yours to change".

describe("the Sources menu disappears when nothing in it is yours", () => {
  const sourceProps = {
    cells: [
      { id: "s1", fileId: "f1", original: "One", translated: "", startTime: 0, endTime: 2 },
    ] as unknown as React.ComponentProps<typeof TimelineEditor>["cells"],
    coreMediaUrl: null,
    fileId: "f1",
    onRetimeSubtitle: () => {},
    editable: true,
    onRequestLinkVideo: () => {},
    onRequestImportAudioVtt: () => {},
    onRequestImportCharacters: () => {},
  } satisfies Partial<React.ComponentProps<typeof TimelineEditor>>

  it("is gone entirely for someone who can attach none of it", () => {
    render(
      <TimelineEditor
        {...sourceProps}
        canLinkVideo={false}
        canImportAudioVtt={false}
        canImportCharacters={false}
      />,
    )
    expect(screen.queryByTestId("tl-sources-menu")).not.toBeInTheDocument()
  })

  it("stays for someone who can attach even one of them", () => {
    // A lead missing one specific permission keeps the menu — and the badges
    // that say what is already attached.
    render(
      <TimelineEditor
        {...sourceProps}
        canLinkVideo={false}
        canImportAudioVtt={false}
        canImportCharacters
      />,
    )
    expect(screen.getByTestId("tl-sources-menu")).toBeInTheDocument()
  })
})

// ── What the text column under the timeline is called (Sam, 2026-08-20) ─────
//
// It said "Dialogue" — a word of the app's own invention sitting between two
// labels it kept being confused with: the track gutter directly above already
// says "Source text" for the same cells, and the heard lines from the audio
// sibling are "Audio cues" a few inches away. These cells are the subtitles,
// so they say so.

describe("the heading over the text column", () => {
  const editor = (extra: Record<string, unknown>) => (
    <TimelineEditor
      fileId="heading" coreMediaUrl={null} editable cells={[]} onRetimeSubtitle={() => {}} {...extra}
    />
  )

  it("says Source text for a file imported as subtitles", () => {
    render(editor({ isSubtitleImport: true }))
    expect(screen.getByTestId("tl-dialogue-header")).toHaveTextContent("Source text")
  })

  it("says it with no video linked, which is where it used to say Dialogue", () => {
    // The old gate was `coreMediaUrl && no media cells`, so a subtitle file
    // with no video fell through to the per-cell derivation — which says
    // "Dialogue" whenever nothing is selected. The confusing case, on the one
    // file type that can least afford it.
    render(editor({ isSubtitleImport: true, coreMediaUrl: null }))
    expect(screen.getByTestId("tl-dialogue-header")).not.toHaveTextContent("Dialogue")
  })

  it("says it with a video linked too", () => {
    render(editor({ isSubtitleImport: true, coreMediaUrl: "https://example.test/master.m3u8" }))
    expect(screen.getByTestId("tl-dialogue-header")).toHaveTextContent("Source text")
  })

  it("leaves every other kind of project deriving its own word", () => {
    // An audio-first project has real media cells and no subtitle import; its
    // header keeps changing with the selection, which is what it should do.
    render(editor({}))
    expect(screen.getByTestId("tl-dialogue-header")).not.toHaveTextContent("Source text")
  })
})

// ── The project timing lock (AQU-646, Sam 2026-08-20) ────────────────────
//
// "When a subtitle VTT gets imported and nothing else has been added yet, I can
// technically go into the timeline and the chips have handlebars and I can
// totally mess up the timings."
//
// He was right, and the reason was precise: the guard that freezes imported
// rows was `subtitleFileWithFootage ? isUserAddedLine : undefined`, and
// `subtitleFileWithFootage` requires a LINKED FILM. With no film it was
// `undefined` and every imported row was draggable. So the first test here is
// his exact arrangement — a subtitle file, nothing else, no film.

describe("the project timing lock", () => {
  const imported = () =>
    cell({ id: "s1", original: "Imported line", medium: "text", startTime: 0, endTime: 8 })
  const added = () =>
    cell({
      id: "s2",
      original: "Added line",
      medium: "text",
      startTime: 12,
      endTime: 20,
      metadata: { aquillaOrigin: { version: 1, kind: "user-insert" } },
    })

  /** The resize grips — the "handlebars" Sam saw. They carry no testid of
   *  their own, so they are found the way the card renders them. */
  const grips = (id: string) =>
    screen.getByTestId(`tl-card-${id}`).querySelectorAll(".cursor-ew-resize")

  it("leaves the handles on an imported row when the project is unlocked", () => {
    // The control. Without this the next test would pass against a card that
    // never had grips for some unrelated reason (too narrow, too short).
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={[imported()]} onRetimeSubtitle={() => {}}
        timingLocked={false}
      />,
    )
    expect(grips("s1").length).toBeGreaterThan(0)
  })

  it("takes them away when it is locked — with no film linked, Sam's case", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={[imported()]} onRetimeSubtitle={() => {}}
        timingLocked
      />,
    )
    expect(grips("s1")).toHaveLength(0)
  })

  it("unlocking THAWS a file with a film linked — the case that made it a no-op", () => {
    // Sam, 2026-08-20: "when timing is unlocked AND an audio vtt is present,
    // timing is still locked." The real correlate was the LINKED FILM: the old
    // footage guard froze the rows on its own, so the `||` meant unlocking
    // could never defeat it — on every episode in the dubbing workflow, which
    // all have a film. The lock is now the only gate.
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl="https://cdn/ep101.m3u8" editable
        cells={[imported()]} onRetimeSubtitle={() => {}}
        timingLocked={false}
      />,
    )
    expect(grips("s1").length).toBeGreaterThan(0)
  })

  it("still freezes a film-linked file while it is LOCKED", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl="https://cdn/ep101.m3u8" editable
        cells={[imported()]} onRetimeSubtitle={() => {}}
        timingLocked
      />,
    )
    expect(grips("s1")).toHaveLength(0)
  })

  it("still lets someone move a line they added themselves", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={[imported(), added()]} onRetimeSubtitle={() => {}}
        timingLocked
      />,
    )
    expect(grips("s1")).toHaveLength(0)
    expect(grips("s2").length).toBeGreaterThan(0)
  })

  it("says so, and keeps saying so, while the project is unlocked", () => {
    // Sam: "the app should remind you when you're unlocked." A toast would go
    // away; the risk is a project left unlocked for a week without anyone
    // noticing, so the reminder is part of the toolbar.
    const { unmount } = render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={[imported()]} onRetimeSubtitle={() => {}}
        timingLocked={false}
      />,
    )
    expect(screen.getByTestId("tl-timing-unlocked")).toBeInTheDocument()
    unmount()

    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={[imported()]} onRetimeSubtitle={() => {}}
        timingLocked
      />,
    )
    expect(screen.queryByTestId("tl-timing-unlocked")).not.toBeInTheDocument()
  })
})

// ── Pairing asks first (AQU-646, Sam 2026-08-20) ─────────────────────────
//
// "When a link is broken or made, there should be a modal pop-up that asks are
// you sure? I know that sounds super annoying, but for now better safe than
// sorry."
//
// It is affordable because the bulk pairing happens at import — this mode
// corrects the tail — and it earns its keep because a pairing decides which
// recording is attributed to which line, and a mis-click says so silently.

describe("confirming a pairing", () => {
  const subs = [cell({ id: "s1", original: "Andrew, look.", medium: "text", startTime: 10, endTime: 20 })]
  const cues = [cell({ id: "c1", original: "Andrew, look.", startTime: 10, endTime: 20 })]
  const tracks = deriveTracksForFile(null, {
    isSubtitleImport: true, hasMediaCells: false, hasAudioCues: true,
  })

  const renderLinking = (over: Record<string, unknown> = {}) => {
    const onToggleCueLink = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={subs}
        tracks={tracks} audioCues={cues} onRetimeSubtitle={() => {}}
        onToggleCueLink={onToggleCueLink} {...over}
      />,
    )
    armLinking()
    return onToggleCueLink
  }

  /** Pick one side's chip, then click the other's — the click that pairs. */
  const clickBothSides = () => {
    const targets = screen.getAllByTestId("tl-link-target")
    const s1 = targets.find((el) => el.getAttribute("data-cell-id") === "s1")!
    const c1 = targets.find((el) => el.getAttribute("data-cell-id") === "c1")!
    fireEvent.click(s1)
    fireEvent.click(c1)
  }

  it("asks before pairing, and does not pair until you say yes", () => {
    const onToggleCueLink = renderLinking()
    clickBothSides()
    expect(onToggleCueLink).not.toHaveBeenCalled()
    expect(screen.getByTestId("cue-link-confirm")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("cue-link-confirm-go"))
    expect(onToggleCueLink).toHaveBeenCalledWith("s1", "c1", true)
  })

  it("backing out leaves the pairing alone", () => {
    const onToggleCueLink = renderLinking()
    clickBothSides()
    fireEvent.click(screen.getByTestId("cue-link-confirm-cancel"))
    expect(onToggleCueLink).not.toHaveBeenCalled()
    expect(screen.queryByTestId("cue-link-confirm")).not.toBeInTheDocument()
  })

  it("asks before BREAKING one too, and says which way it is going", () => {
    // Sam: "both directions deserve it." The pair already exists here, so the
    // same click is an unpair — and the dialog has to say so, since the two
    // acts are opposites reached by an identical gesture.
    const onToggleCueLink = renderLinking({
      cueLinks: {
        cuesForText: new Map([["s1", ["c1"]]]),
        textForCue: new Map([["c1", ["s1"]]]),
      },
    })
    clickBothSides()
    const dialog = screen.getByTestId("cue-link-confirm")
    expect(dialog).toHaveTextContent(/Break this pairing\?/)
    fireEvent.click(screen.getByTestId("cue-link-confirm-go"))
    expect(onToggleCueLink).toHaveBeenCalledWith("s1", "c1", false)
  })

  it("names both lines, because the risk is that you clicked the wrong chip", () => {
    renderLinking()
    clickBothSides()
    const dialog = screen.getByTestId("cue-link-confirm")
    // Its time and the opening of its words, for each side.
    expect(dialog).toHaveTextContent("Andrew, look.")
    expect(dialog).toHaveTextContent("Heard")
    expect(dialog).toHaveTextContent("Subtitle")
  })
})

// ── AQU-646 stage 3b: the gutter collapses ───────────────────────────────────
//
// Sam, 2026-08-24: "make the gutter collapsible, and when it's expanded it
// should be fully expanded so that you can see the full name and all the
// information… they would all do so at once."
//
// The last clause is the requirement these cases exist for. A per-row version
// of this would look almost identical in a screenshot and be the wrong feature,
// so "every row together" is asserted directly rather than inferred from one.
describe("TimelineEditor — the track gutter collapses and expands", () => {
  beforeEach(() => {
    topOwner.value = 1
    localStorage.clear()
  })

  const rowCells = [cell({ id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10 })]

  const gutter = () => screen.getByTestId("tl-scroll").previousElementSibling as HTMLElement
  const names = () =>
    Array.from(gutter().querySelectorAll("span.font-semibold")).map((el) => el.textContent)
  const toggle = () => screen.getByTestId("tl-gutter-toggle")

  // `onReorderTrack` throughout, because that is the gate on `data-tl-track-row`
  // — a viewer's rows carry no attribute at all, and asserting over them would
  // pass by finding nothing.
  const editor = (props: Record<string, unknown> = {}) => (
    <TimelineEditor
      fileId="f1" coreMediaUrl={null} editable cells={rowCells} onRetimeSubtitle={() => {}}
      onReorderTrack={() => {}} {...props}
    />
  )

  it("hides EVERY track's name at once, and brings them all back at once", () => {
    render(editor())
    expect(names()).toEqual(["Source text", "Source audio", "Target audio"])

    fireEvent.click(toggle())
    // Three rows, three blanks — not "fewer names", and not fewer ROWS either.
    // One row keeping its label would be the per-row feature Sam explicitly did
    // not ask for; a row disappearing would desync the gutter from the lanes.
    expect(names()).toEqual(["", "", ""])

    fireEvent.click(toggle())
    expect(names()).toEqual(["Source text", "Source audio", "Target audio"])
  })

  it("narrows the column itself, not just its contents", () => {
    render(editor())
    const grid = gutter().parentElement as HTMLElement
    expect(grid.style.gridTemplateColumns).toBe("240px 1fr")
    fireEvent.click(toggle())
    expect(grid.style.gridTemplateColumns).toBe("56px 1fr")
  })

  it("leaves every collapsed row still able to say which track it is", () => {
    // The names are the only thing a collapsed row loses, and losing them
    // outright would make the strip unusable — there would be no way to tell
    // track 2 from track 3 without expanding. The tooltip is that recovery,
    // and it is also the accessible name of a row that would otherwise
    // announce as its speaker button alone.
    render(editor())
    fireEvent.click(toggle())
    const rows = Array.from(gutter().querySelectorAll("[data-tl-track-row]"))
    expect(rows.map((r) => r.getAttribute("title"))).toEqual([
      "Source text",
      "Source audio",
      "Target audio",
    ])
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Source text",
      "Source audio",
      "Target audio",
    ])
  })

  it("says nothing extra while the names are on screen", () => {
    // A tooltip that repeats visible text is noise, and an aria-label there
    // would override the row's real content for a screen reader.
    render(editor())
    const rows = Array.from(gutter().querySelectorAll("[data-tl-track-row]"))
    expect(rows.every((r) => !r.hasAttribute("title"))).toBe(true)
    expect(rows.every((r) => !r.hasAttribute("aria-label"))).toBe(true)
  })

  it("keeps the rows countable, so dragging still works collapsed", () => {
    // `beginTrackDrag` bails outright when the `[data-tl-track-row]` count
    // disagrees with the rendered tracks — no error, no partial behaviour, just
    // a dead drag. Collapsing takes the GRIP away (there is no room for it) but
    // the whole row is the handle, so the count must not move with it.
    render(editor())
    const before = gutter().querySelectorAll("[data-tl-track-row]").length
    expect(before).toBe(3)
    fireEvent.click(toggle())
    expect(gutter().querySelectorAll("[data-tl-track-row]").length).toBe(before)
  })

  it("puts its button outside the layout, where the ruler's height is set", () => {
    // The gutter's header and the ruler beside it are both h-7, and that shared
    // height IS the vertical coordinate frame every drop line and lift offset
    // is measured in. A button in the normal flow would grow the header and put
    // all of them out by its height.
    render(editor())
    expect(toggle().className).toContain("absolute")
    expect((toggle().parentElement as HTMLElement).className).toContain("h-7")
  })

  it("remembers the choice against the file it was made on", () => {
    const { rerender } = render(editor())
    fireEvent.click(toggle())
    expect(names()).toEqual(["", "", ""])

    // A different file: this component is NOT remounted on a file switch, so a
    // preference that only lived in state would follow the user across — which
    // is the bug the zoom carried for months before stage 3 caught it.
    rerender(editor({ fileId: "f2" }))
    expect(names()).toEqual(["Source text", "Source audio", "Target audio"])

    rerender(editor({ fileId: "f1" }))
    expect(names()).toEqual(["", "", ""])
  })

  it("stores nothing for a file left expanded", () => {
    render(editor())
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    expect(localStorage.getItem("aquilla:tlGutterCollapsed:f1")).toBeNull()
  })
})

// ── AQU-646 stage 3c: the drop line has to move WHILE you drag ───────────────
//
// Sam, 2026-08-24: "technically based on mouse positioning it works correctly
// but it doesn't actually visually adapt while I'm dragging — it lines itself up
// correctly once I let go and then I find out if I dragged far enough."
//
// That defeats the whole point of the indent, which exists so the two possible
// outcomes of one gesture are distinguishable BEFORE release. The drop resolves
// on `pointermove` and the indicator is pure state, so this is testable without
// a browser — the only thing happy-dom cannot supply is geometry, and geometry
// is exactly what `vi.spyOn(el, "getBoundingClientRect")` can hand it.
describe("TimelineEditor — the drop indicator during a track drag", () => {
  beforeEach(() => { topOwner.value = 1 })

  const rowCells = [cell({ id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10 })]

  /** Three 40px rows stacked from the origin. The gutter's own rect stays
   *  happy-dom's 0-origin default, and scrollTop is 0, so `gutterContentY` is
   *  the identity and a clientY IS a content-y — which keeps the arithmetic in
   *  this test readable. */
  const stubRows = (rows: Element[]) => {
    rows.forEach((row, i) => {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        top: i * 40, bottom: i * 40 + 40, left: 0, right: 128, width: 128, height: 40, x: 0, y: i * 40,
        toJSON: () => ({}),
      } as DOMRect)
    })
  }

  /** Where the line is, as "<row index>:<edge>" — the EDGE matters as much as
   *  the row, because sliding from below row 1 to below row 2 keeps the same
   *  row element and moves the line from its top to its bottom. */
  const dropLineAt = () =>
    Array.from(document.querySelectorAll('[data-testid="tl-track-drop-line"]')).map((el) => {
      const row = el.closest("[data-tl-track-row]")!
      const index = Array.from(document.querySelectorAll("[data-tl-track-row]")).indexOf(row)
      return `${index}:${el.className.includes("top-0") ? "top" : "bottom"}`
    })

  it("draws the line as the pointer moves, and moves it — not only on release", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        onRetimeSubtitle={() => {}} onReorderTrack={() => {}}
      />,
    )
    const gutter = screen.getByTestId("tl-scroll").previousElementSibling as HTMLElement
    const rows = Array.from(gutter.querySelectorAll("[data-tl-track-row]"))
    expect(rows).toHaveLength(3)
    stubRows(rows)

    // Grab the top row and drag it down past the second.
    fireEvent.pointerDown(rows[0], { button: 0, pointerId: 1, clientX: 8, clientY: 10 })
    // Nothing yet — under the 3px threshold a drag has not been intended.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 8, clientY: 12 })
    expect(dropLineAt()).toEqual([])

    // Into the second row's lower half.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 8, clientY: 70 })
    const first = dropLineAt()
    expect(first).not.toEqual([])

    // …and on down into the third. THE LINE MUST FOLLOW. This is the assertion
    // Sam's report is about: a line that only appears once is a line that told
    // you nothing while you were deciding.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 8, clientY: 110 })
    const second = dropLineAt()
    expect(second).not.toEqual([])
    expect(second).not.toEqual(first)

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 8, clientY: 110 })
    // The gesture is over, so the line goes with it.
    expect(dropLineAt()).toEqual([])
  })
})

// ── AQU-646 stage 3c ─────────────────────────────────────────────────────────
describe("TimelineEditor — an added track finds its takes where they actually live", () => {
  beforeEach(() => { topOwner.value = 1 })

  // THE BLOCKER (Sam, 2026-08-24): "I could record it… but then when I saved
  // it, it just would disappear."
  //
  // On a file with an audio-cue sibling a take NEVER lands on a subtitle cell —
  // `openRecordingTarget` redirects the mic to the cue that performs the line
  // and the take is written against that cue. An added track aligned to a
  // subtitle row was drawing over the subtitle cells, so its chips could never
  // appear however much audio it held. The data was on disk and correct; two
  // surfaces simply disagreed about where to look.
  const subtitleCells = [
    cell({ id: "s1", original: "One", translated: "Uno", medium: "text", startTime: 0, endTime: 4 }),
  ]
  /** The heard lines that perform them, in the sibling file. The first carries
   *  a take on the added track; the second is bare, so the mic belongs on it. */
  const cueCells = [
    cell({
      id: "cue1", fileId: "f1-cues", original: "One", medium: "media", startTime: 0, endTime: 4,
      selectedBySlot: { "trk-extra": "aud-extra" },
      attachments: {
        "aud-extra": { audioId: "aud-extra", slot: "trk-extra", url: "frontier-audio://aud-extra" },
      },
    } as unknown as Partial<CellData>),
    cell({ id: "cue2", fileId: "f1-cues", original: "Two", medium: "media", startTime: 5, endTime: 9 }),
  ]
  const withAddedTrack = deriveTracksForFile(
    {
      trackOverrides: {
        "trk-extra": { kind: "audio", name: "Extra", order: 9, sourceTrackId: "source-subtitles" },
      },
    },
    { isSubtitleImport: true, hasMediaCells: false, hasAudioCues: true },
  )

  it("draws a subtitle-aligned track's chip from the CUE that carries it", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={subtitleCells}
        audioCues={cueCells}
        targetCells={cueCells}
        tracks={withAddedTrack}
        onRetimeSubtitle={() => {}}
      />,
    )
    const lane = screen.getByTestId("tl-target-lane-trk-extra")
    // Before the fix this lane resolved over `subtitleCells`, which hold no
    // attachment at this slot, and rendered no chip at all.
    expect(within(lane).getByTestId("tl-target-cue1")).toBeInTheDocument()
  })

  // The other half of the same rule, and the one that silently breaks if only
  // `items` is fixed: the hover mic is drawn over the cells with NO take, so if
  // `empty` still came from the subtitle list the mic would offer to record a
  // line that already has audio.
  it("offers the mic over the cue cells too, not the subtitle cells", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={subtitleCells}
        audioCues={cueCells}
        targetCells={cueCells}
        tracks={withAddedTrack}
        onRetimeSubtitle={() => {}}
        onOpenRecording={() => {}}
      />,
    )
    const lane = screen.getByTestId("tl-target-lane-trk-extra")
    // The bare CUE gets the mic…
    expect(within(lane).getByTestId("tl-target-empty-cue2")).toBeInTheDocument()
    // …the one that already has a take does not…
    expect(within(lane).queryByTestId("tl-target-empty-cue1")).toBeNull()
    // …and the subtitle cell gets nothing at all, because recording there is
    // redirected to a cue and a slot over it would be an offer the app cannot
    // keep.
    expect(within(lane).queryByTestId("tl-target-empty-s1")).toBeNull()
  })

  // ── AQU-646 stage 6C ───────────────────────────────────────────────────────
  //
  // Sam, 2026-08-27: "the first new track I added didn't let me add any audio
  // into it, or at least didn't display any of the takes that were recorded
  // into it." His track was aligned to SOURCE AUDIO, and that arm of
  // `cellsForSourceTrack` answered with the RAW `audioCues` prop rather than
  // the audio-merged `targetCells`. Stage 3c-1 above fixed the two subtitle
  // arms and never touched this one.
  //
  // THE FIXTURE IS DELIBERATELY DIFFERENT FROM THE ONE ABOVE, and that is the
  // whole point: those cases pass ONE array as both `audioCues` and
  // `targetCells`, which makes the raw and merged lists indistinguishable and
  // would let this bug pass unnoticed. Here they are genuinely two lists — the
  // raw cues carry no attachments at all, exactly as the real prop doesn't.
  const rawCues = [
    cell({ id: "cue1", fileId: "f1-cues", original: "One", medium: "media", startTime: 0, endTime: 4 }),
    cell({ id: "cue2", fileId: "f1-cues", original: "Two", medium: "media", startTime: 5, endTime: 9 }),
  ]
  const audioAlignedTrack = deriveTracksForFile(
    {
      trackOverrides: {
        "trk-audio": { kind: "audio", name: "Track", order: 9, sourceTrackId: "source-audio" },
      },
    },
    { isSubtitleImport: true, hasMediaCells: false, hasAudioCues: true },
  )

  it("draws a SOURCE-AUDIO-aligned track's take, which lives only on the merged cells", () => {
    const mergedCues = [
      cell({
        id: "cue1", fileId: "f1-cues", original: "One", medium: "media", startTime: 0, endTime: 4,
        selectedBySlot: { "trk-audio": "aud-audio" },
        attachments: {
          "aud-audio": { audioId: "aud-audio", slot: "trk-audio", url: "frontier-audio://aud-audio" },
        },
      } as unknown as Partial<CellData>),
      rawCues[1],
    ]
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={subtitleCells}
        audioCues={rawCues}
        targetCells={mergedCues}
        tracks={audioAlignedTrack}
        onRetimeSubtitle={() => {}}
      />,
    )
    const lane = screen.getByTestId("tl-target-lane-trk-audio")
    expect(within(lane).getByTestId("tl-target-cue1")).toBeInTheDocument()
  })

  // ── AQU-646 stage 6B ───────────────────────────────────────────────────────
  //
  // Sam, 2026-08-27: "trimming just doesn't work under any circumstances… in
  // the target audio track", on a file with NO FILM. The handles are withheld
  // when the master would ignore a dub's trims — but the virtual transport
  // (stage 3h) fires takes through the overlay pool, which honours them, and
  // this gate had never been told about it. Cue cells carry no source clip of
  // their own, so every clause was false and the row lost its handles.
  const takeOnCue = [
    cell({
      id: "cue1", fileId: "f1-cues", original: "One", medium: "media", startTime: 0, endTime: 4,
      // CELL-SEEDED, deliberately: the derived row refuses a recording-slot
      // clip that is not seeded with the cell id, because that is how the
      // shared imported SOURCE clip is told apart from a dub.
      selectedAudioId: "take-cue1-1",
      attachments: {
        "take-cue1-1": {
          audioId: "take-cue1-1", slot: "recording", url: "frontier-audio://take-cue1-1",
          durationMs: 4000,
        },
      },
    } as unknown as Partial<CellData>),
  ]

  function renderFilmless(virtualIsTransport: boolean) {
    return render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        virtualIsTransport={virtualIsTransport}
        cells={subtitleCells}
        audioCues={takeOnCue}
        targetCells={takeOnCue}
        tracks={deriveTracksForFile({}, { isSubtitleImport: true, hasMediaCells: false, hasAudioCues: true })}
        onRetimeSubtitle={() => {}}
        onTrimTarget={() => {}}
      />,
    )
  }

  it("gives a film-less file its trim handles once the virtual clock drives it", () => {
    renderFilmless(true)
    expect(screen.getByTestId("tl-target-cue1-handle-l")).toBeInTheDocument()
    expect(screen.getByTestId("tl-target-cue1-handle-r")).toBeInTheDocument()
  })

  // ── AQU-646 stage 6J ───────────────────────────────────────────────────────
  //
  // Sam, 2026-08-27: "target text should not be an option there because it's
  // not a source. And as far as source text and source audio go, in BTT
  // products where source audio is linked to source text the new tracks align
  // with the source audio regardless of which you select."
  it("offers one honest alignment on a cue-linked file, named for the audio", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={subtitleCells}
        audioCues={rawCues}
        targetCells={rawCues}
        tracks={deriveTracksForFile({}, {
          isSubtitleImport: true, hasMediaCells: false, hasAudioCues: true,
        })}
        onRetimeSubtitle={() => {}}
        onReorderTrack={vi.fn()} onRenameTrack={vi.fn()} trackEditing={{
          onAdd: vi.fn(), onSetColor: vi.fn(), onLeaveFolder: vi.fn(),
          onMoveToScope: vi.fn(), onCreateFolderFrom: vi.fn(), onDelete: vi.fn(),
        }}
      />,
    )
    // The toolbar control is a MENU — "Audio track" or "Folder" — so opening
    // the dialog takes both clicks.
    fireEvent.click(screen.getByTestId("tl-add-track"))
    fireEvent.click(screen.getByText("Audio track"))
    // One option, stated rather than asked…
    expect(screen.getByTestId("tl-add-track-align-fixed")).toHaveTextContent("Source audio")
    expect(screen.queryByTestId("tl-add-track-align")).toBeNull()
    // …and the boring automatic name.
    expect(screen.getByTestId("tl-add-track-name")).toHaveValue("Track")
  })

  it("never offers Target text, which is not a source", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={subtitleCells}
        tracks={deriveTracksForFile({}, {
          isSubtitleImport: true, hasMediaCells: false, hasAudioCues: false,
        })}
        onRetimeSubtitle={() => {}}
        onReorderTrack={vi.fn()} onRenameTrack={vi.fn()} trackEditing={{
          onAdd: vi.fn(), onSetColor: vi.fn(), onLeaveFolder: vi.fn(),
          onMoveToScope: vi.fn(), onCreateFolderFrom: vi.fn(), onDelete: vi.fn(),
        }}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-add-track"))
    fireEvent.click(screen.getByText("Audio track"))
    const shown = screen.queryByTestId("tl-add-track-align")
      ?? screen.getByTestId("tl-add-track-align-fixed")
    expect(shown.textContent).not.toContain("Target")
  })

  it("still withholds them when nothing that honours trims is driving", () => {
    // The honest remaining case: the queue sounding a take-only section through
    // an imported source recording, a master that ignores dub trims.
    renderFilmless(false)
    expect(screen.queryByTestId("tl-target-cue1-handle-l")).toBeNull()
  })
})

describe("TimelineEditor — a menu with nothing in it does not open", () => {
  beforeEach(() => { topOwner.value = 1 })

  const rowCells = [cell({ id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10 })]
  const gutterRows = () =>
    Array.from(
      (screen.getByTestId("tl-scroll").previousElementSibling as HTMLElement)
        .querySelectorAll("[data-tl-track-row]"),
    )

  // Sam, 2026-08-24: "right clicking only opens up an empty drop down thing…
  // technically we shouldn't even have a drop down thingy show up in the first
  // place." With several derived tracks selected there is genuinely nothing to
  // offer — Rename is single-track only and none of them can be coloured,
  // foldered from, or deleted with the setting off.
  it("stays shut on a multi-selection of derived tracks with editing off", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        onRetimeSubtitle={() => {}} onReorderTrack={() => {}} onRenameTrack={() => {}}
      />,
    )
    const rows = gutterRows()
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { metaKey: true })
    fireEvent.contextMenu(rows[1])
    expect(screen.queryByRole("menu")).toBeNull()
    // …and the `⋯` goes with it, rather than advertising a menu that will not open.
    expect(screen.queryByTestId("tl-track-menu-source-audio")).toBeNull()
  })

  it("still opens on ONE of them, where Rename applies", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        onRetimeSubtitle={() => {}} onReorderTrack={() => {}} onRenameTrack={() => {}}
      />,
    )
    fireEvent.contextMenu(gutterRows()[0])
    expect(screen.getByText("Rename")).toBeInTheDocument()
  })
})

describe("TimelineEditor — the gutter's trailing controls sit in one column", () => {
  beforeEach(() => { topOwner.value = 1 })

  const rowCells = [cell({ id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10 })]

  // Sam, 2026-08-24: "the mute button icons seem to be left justified with some
  // sort of a gap from the text… differently named tracks are leading to
  // differently aligned mute/unmute buttons."
  //
  // `trailing` is a FRAGMENT — the speaker and the `⋯` — and a fragment spreads
  // into the parent's flex as separate children. With `justify-between` the free
  // space then landed BETWEEN them, so the speaker sat wherever the track's name
  // happened to end. Wrapping the pair makes it one child pinned to the right
  // wall, which is what puts every row's speaker in the same column.
  it("wraps the speaker and the menu button as a single flex child", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        onRetimeSubtitle={() => {}} onReorderTrack={() => {}} onRenameTrack={() => {}}
      />,
    )
    const speaker = screen.getByTestId("tl-speaker-source")
    const row = speaker.closest("[data-tl-track-row]")!
    // Exactly two: the name block, and the controls. Three is the bug.
    expect(row.children).toHaveLength(2)
    const controls = row.children[1]
    expect(controls).toContainElement(speaker as HTMLElement)
    expect(controls).toContainElement(screen.getByTestId("tl-track-menu-source-audio"))
    // Pinned right, and not allowed to be squeezed by a long name.
    expect(controls.className).toContain("shrink-0")
  })
})

// AQU-646 stage 3c — the row you are dragging re-indents as you aim.
//
// Sam, 2026-08-25: "the blue line is either all the way at the edge or indented
// but the contents of the track that is being dragged are indented in both
// cases… it should be realigning dynamically as well." The line already told
// you which outcome a release would pick; the row under the pointer did not,
// so for the whole gesture the thing being moved and the promise about where it
// lands disagreed.
describe("TimelineEditor — the lifted row follows the drop it is aiming at", () => {
  beforeEach(() => { topOwner.value = 1 })

  const rowCells = [cell({ id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10 })]
  const folded = () =>
    deriveTracksForFile({
      trackOverrides: {
        grp: { kind: "folder", name: "Dubs", order: 4 },
        "target-audio": { groupId: "grp", order: 0 },
      },
    })

  /** 40px rows from the origin; the gutter keeps happy-dom's 0-origin rect, so
   *  a clientY is a content-y and a clientX is an indent-x. */
  const stubRows = (rows: Element[]) =>
    rows.forEach((row, i) => {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        top: i * 40, bottom: i * 40 + 40, left: 0, right: 240, width: 240, height: 40, x: 0, y: i * 40,
        toJSON: () => ({}),
      } as DOMRect)
    })

  /** Is the dragged row's CONTENT drawn indented? The indent is on the content
   *  block, not the row, so the drop line and the lift still span the gutter. */
  const contentIndented = (row: Element) =>
    (row.firstElementChild as HTMLElement).className.includes("pl-3.5")

  it("indents while aiming inside the folder and flattens while aiming outside", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        tracks={folded()}
        onRetimeSubtitle={() => {}} onReorderTrack={() => {}} onRenameTrack={() => {}}
        trackEditing={{
          onAdd: () => "x", onSetColor: () => {}, onLeaveFolder: () => {},
          onMoveToScope: () => {}, onCreateFolderFrom: () => "y", onDelete: () => {},
        }}
      />,
    )
    const gutter = screen.getByTestId("tl-scroll").previousElementSibling as HTMLElement
    const rows = Array.from(gutter.querySelectorAll("[data-tl-track-row]"))
    stubRows(rows)

    // Grab a loose row and drag it down over the folder's block.
    const dragged = rows[0]
    expect(contentIndented(dragged)).toBe(false)
    fireEvent.pointerDown(dragged, { button: 0, pointerId: 1, clientX: 8, clientY: 10 })

    // Well to the RIGHT — past half the 240px gutter — means "drop inside".
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 150 })
    const indentedWhileReachingIn = contentIndented(rows[0])

    // …and back to the LEFT means "just reorder", at the same height.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 4, clientY: 150 })
    const indentedWhileOutside = contentIndented(rows[0])

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 4, clientY: 150 })

    // THE ASSERTION IS THE DIFFERENCE, not either value on its own: the same Y
    // with a different X has to change how the travelling row is drawn, which
    // is exactly what was missing.
    expect(indentedWhileReachingIn).toBe(true)
    expect(indentedWhileOutside).toBe(false)
  })
})

// AQU-646 stage 3f — Transcribe asks where the audio ACTUALLY is.
//
// `canTranscribeCell` is `Boolean(cell.selectedAudioId)`, and on a file with an
// audio-cue sibling a subtitle cell never carries a take — the take hangs off
// the heard line performing it, in the other file. So the button was greyed out
// over lines that plainly had recordings, saying nothing about why.
//
// The rule that matters most here is that ELIGIBILITY and the RUN read the same
// function. A lit button that runs over nothing is worse than a dark one.
describe("TimelineEditor — transcribing a section whose audio lives elsewhere", () => {
  beforeEach(() => { topOwner.value = 1 })

  const sub = (id: string, start: number) =>
    cell({ id, original: `line ${id}`, medium: "text", startTime: start, endTime: start + 2 })
  /** The heard line that performs it — another file, and the take is on it. */
  const cueWithTake = (id: string) =>
    cell({
      id, fileId: "f1-cues", original: "heard", medium: "media", startTime: 0, endTime: 2,
      selectedAudioId: `audio-${id}-1700-take.webm`,
    } as Partial<CellData>)

  const render1 = (takeCellsFor?: (id: string) => readonly CellData[]) => {
    const onTranscribeSections = vi.fn()
    const view = render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={[sub("s1", 0), sub("s2", 4)]}
        onRetimeSubtitle={() => {}}
        onTranscribeSections={onTranscribeSections}
        takeCellsFor={takeCellsFor}
      />,
    )
    return { ...view, onTranscribeSections }
  }

  it("stays disabled when the subtitle really has no audio anywhere", () => {
    const { container } = render1()
    fireEvent.click(container.querySelector('[data-testid="tl-card-s1"]')!)
    expect(screen.getByTestId("tl-transcribe-selection")).toBeDisabled()
  })

  // THE BUG. The subtitle carries no take and never will; its heard line does.
  it("enables once the linked heard line's take is what gets asked about", () => {
    const { container } = render1((id) => (id === "s1" ? [cueWithTake("cue-1")] : []))
    fireEvent.click(container.querySelector('[data-testid="tl-card-s1"]')!)
    expect(screen.getByTestId("tl-transcribe-selection")).toBeEnabled()
  })

  // The run is handed the SELECTED sections; the workspace resolves them to the
  // cells holding the audio with the same function the button was lit from.
  it("passes the selected sections through, for the workspace to resolve", () => {
    const { container, onTranscribeSections } = render1((id) =>
      id === "s1" ? [cueWithTake("cue-1")] : [],
    )
    fireEvent.click(container.querySelector('[data-testid="tl-card-s1"]')!)
    fireEvent.click(screen.getByTestId("tl-transcribe-selection"))
    expect(onTranscribeSections).toHaveBeenCalledWith(["s1"])
  })

  // A section whose heard line has no recording yet must not be counted, or the
  // button promises work that cannot happen.
  it("counts only the sections whose audio exists", () => {
    const { container } = render1((id) => (id === "s1" ? [cueWithTake("cue-1")] : []))
    fireEvent.click(container.querySelector('[data-testid="tl-card-s1"]')!)
    fireEvent.click(container.querySelector('[data-testid="tl-card-s2"]')!, { metaKey: true })
    expect(screen.getByTestId("tl-transcribe-count")).toHaveTextContent("2 sections selected")
    expect(screen.getByTestId("tl-transcribe-selection")).toHaveTextContent("Transcribe section")
  })
})

// ── AQU-646 stage 4b ─────────────────────────────────────────────────────────
describe("TimelineEditor — folders look like folders", () => {
  beforeEach(() => {
    topOwner.value = 1
    // Both are personal state persisted per fileId, and every case here mounts
    // f1 — without the clears, one case's collapse or dial value silently
    // decides what the next one starts from.
    try {
      localStorage.removeItem("aquilla:tlFoldersClosed:f1")
      localStorage.removeItem("aquilla:timelineRowHeight:f1")
      // The pixel assertion below is in px-per-second, so the zoom another
      // case persisted for f1 must not leak into it.
      localStorage.setItem("aquilla:timelineZoom:f1", String(ZOOM_DEFAULT))
    } catch {
      /* private mode — nothing was persisted either */
    }
  })

  const rowCells = [cell({ id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10 })]
  const foldedTracks = () =>
    deriveTracksForFile({
      trackOverrides: {
        grp: { kind: "folder", name: "Dubs", order: 4 },
        "target-audio": { groupId: "grp", order: 0 },
        "trk-es": { kind: "audio", name: "Spanish", groupId: "grp", order: 1, sourceTrackId: "source-subtitles" },
      },
    })

  /** The folder's GUTTER row — the element the height contract is on. Found
   *  through the toggle because the gutter deliberately has no testid. */
  const folderGutterRow = () =>
    screen.getByTestId("tl-folder-toggle-grp").closest<HTMLElement>("[data-tl-track-row]")!

  // ── Slim fixed headings ──

  // FOLDERS ARE NOT TRACKS (Sam, 2026-08-24), and stage 4b makes it visible: a
  // folder is a 28px heading, not a 66px lane-height row, so collapsing a
  // stack actually reclaims vertical space instead of trading three tall rows
  // for one tall row. BOTH columns, byte for byte — the gutter and the lanes
  // are matched row for row, and a folder tall in one column would shift every
  // row beneath it out of line with its own label and take `beginTrackDrag`'s
  // hit-testing with it.
  it("draws a folder as a 28px heading in BOTH columns, off the dial", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        tracks={foldedTracks()} onRetimeSubtitle={() => {}} onReorderTrack={() => {}}
      />,
    )
    expect(folderGutterRow().style.height).toBe("28px")
    expect(screen.getByTestId("tl-folder-lane-grp").style.height).toBe("28px")
    // …and it stopped riding the dial's CSS variable: a folder at 160px is
    // exactly the "heading pretending to be a track" this stage retires.
    expect(folderGutterRow().className).not.toContain("--tl-row-h")
    expect(screen.getByTestId("tl-folder-lane-grp").className).not.toContain("--tl-row-h")
  })

  it("the tracks around it keep the dial's height class", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        tracks={foldedTracks()} onRetimeSubtitle={() => {}} onReorderTrack={() => {}}
      />,
    )
    const gutter = screen.getByTestId("tl-scroll").previousElementSibling!
    const trackRows = Array.from(gutter.querySelectorAll<HTMLElement>("[data-tl-track-row]")).filter(
      (row) => row !== folderGutterRow(),
    )
    expect(trackRows.length).toBeGreaterThan(0)
    for (const row of trackRows) {
      expect(row.className).toContain("--tl-row-h")
      expect(row.style.height).toBe("")
    }
  })

  // Sam's clamp ruling: the dial floor is 24px, and at that compression a fixed
  // 28px heading would stand TALLER than the tracks it is meant to be less
  // than. Everything gets uniformly small instead.
  it("never stands taller than the tracks — at the 24px dial floor it is 24px too", () => {
    localStorage.setItem("aquilla:timelineRowHeight:f1", "24")
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        tracks={foldedTracks()} onRetimeSubtitle={() => {}} onReorderTrack={() => {}}
      />,
    )
    expect(folderGutterRow().style.height).toBe("24px")
    expect(screen.getByTestId("tl-folder-lane-grp").style.height).toBe("24px")
  })

  // The "N tracks" sub-line retired with the height: two stacked lines need
  // ~30px of type and the 28px heading's content box holds 27. Its gate reads
  // the row's OWN height now — on the global dial value it would render the
  // second line into the clip and cut it mid-glyph.
  it("carries no 'N tracks' sub-line any more", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        tracks={foldedTracks()} onRetimeSubtitle={() => {}} onReorderTrack={() => {}}
      />,
    )
    expect(screen.queryByText("2 tracks")).toBeNull()
    // The kind-table fallback must not leak into its place either.
    expect(within(folderGutterRow()).queryByText("group")).toBeNull()
  })

  // ── The collapsed summary sees every kind of member ──

  // THE STALE HALF OF STAGE 3 (Sam, 2026-08-26: "the visualization of chips in
  // the timeline does not work for added tracks"). `summarySpansForTrack` sent
  // added tracks to a default arm returning nothing, from a comment written
  // before stage 3 gave them slots — so a folder of recorded added tracks
  // collapsed to a BLANK strip, and collapsing read as data loss. The arm now
  // resolves through `targetItemsForTrack`, the same resolver the open lane
  // uses, cue-link redirect and `selectedBySlot` included.
  const subtitleCells = [
    cell({ id: "s1", original: "One", translated: "Uno", medium: "text", startTime: 0, endTime: 4 }),
  ]
  const cueCells = [
    cell({
      id: "cue1", fileId: "f1-cues", original: "One", medium: "media", startTime: 0, endTime: 4,
      selectedBySlot: { "trk-extra": "aud-extra" },
      attachments: {
        "aud-extra": { audioId: "aud-extra", slot: "trk-extra", url: "frontier-audio://aud-extra" },
      },
    } as unknown as Partial<CellData>),
  ]
  const foldedAddedTrack = deriveTracksForFile(
    {
      trackOverrides: {
        grp: { kind: "folder", name: "Dubs", order: 9 },
        "trk-extra": { kind: "audio", name: "Extra", groupId: "grp", order: 0, sourceTrackId: "source-subtitles" },
      },
    },
    { isSubtitleImport: true, hasMediaCells: false, hasAudioCues: true },
  )

  const summaryBlocksOf = (lane: HTMLElement) =>
    Array.from(lane.querySelectorAll<HTMLElement>("div[aria-hidden]"))

  it("a collapsed folder summarises an added track's takes — from the cue file they live on", () => {
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable
        cells={subtitleCells}
        audioCues={cueCells}
        targetCells={cueCells}
        tracks={foldedAddedTrack}
        onRetimeSubtitle={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-folder-toggle-grp"))
    const lane = screen.getByTestId("tl-folder-lane-grp")
    expect(lane).toHaveAttribute("data-collapsed")
    // Before the fix this was [] however much audio the track held.
    expect(summaryBlocksOf(lane).length).toBeGreaterThan(0)
  })

  // CHIP RESOLUTION, NOT CELL RESOLUTION. The old cell-span shortcut predates
  // per-take placement: a chip dragged away from its line still summarised at
  // its old spot, so the closed folder contradicted the open lane it stands in
  // for. The summary reads `layout.targetGeom` now — the block sits where the
  // CHIP sits, not where the cell is.
  it("summarises a dragged take where the chip actually sits", () => {
    const dragged = [
      cell({
        id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10,
        selectedAudioId: "audio-m1-1700000000-take.webm",
        attachments: {
          "audio-m1-1700000000-take.webm": {
            type: "audio", url: "frontier-audio://take",
            // Placed at 15s — inside the FILE's span (the second cell carries
            // the view out to 20s; the summary culls to the visible window,
            // and a take parked beyond every cell would be culled with it),
            // but nowhere near its own cell's 0–10.
            durationMs: 2000, targetOffsetMs: 15000,
          },
        },
      } as unknown as Partial<CellData>),
      cell({ id: "m2", original: "Two", medium: "media", startTime: 10, endTime: 20 }),
    ]
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={dragged}
        tracks={foldedTracks()} onRetimeSubtitle={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-folder-toggle-grp"))
    const blocks = summaryBlocksOf(screen.getByTestId("tl-folder-lane-grp"))
    expect(blocks.length).toBeGreaterThan(0)
    // The take was placed at 15s; its cell sits at 0s. Cell resolution drew
    // this block at left 0 — the wrong answer this case exists to refuse.
    const lefts = blocks.map((b) => parseFloat(b.style.left))
    expect(lefts).toContain(15 * ZOOM_DEFAULT)
    expect(lefts).not.toContain(0)
  })
})

// ── AQU-646 stage 5 ─────────────────────────────────────────────────────────
//
// Sam, 2026-08-26: dragging the playhead scrubs the picture. happy-dom gives
// every element a 0-origin rect, which is what lets a clientX map straight to a
// track offset here with no stubbing — the same thing TimelineRuler.test.tsx
// already relies on.
describe("TimelineEditor — dragging the playhead (stage 5)", () => {
  beforeEach(() => { topOwner.value = 1 })

  const rowCells = [cell({ id: "m1", original: "One", medium: "media", startTime: 0, endTime: 10 })]

  function renderScrub() {
    const onSeekToTime = vi.fn()
    const onScrubStart = vi.fn()
    const onScrubEnd = vi.fn()
    render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={rowCells}
        onRetimeSubtitle={() => {}}
        onSeekToTime={onSeekToTime}
        onScrubStart={onScrubStart}
        onScrubEnd={onScrubEnd}
      />,
    )
    return { onSeekToTime, onScrubStart, onScrubEnd, ruler: screen.getByTestId("tl-ruler") }
  }

  // THE EXISTING GESTURE MUST SURVIVE UNTOUCHED. A click on this band has
  // always seeked, and has never stopped playback — so the transport is taken
  // at the intent threshold, not at pointerdown.
  it("a plain click still seeks, and is not a scrub", () => {
    const { onSeekToTime, onScrubStart, onScrubEnd, ruler } = renderScrub()
    fireEvent.click(ruler, { clientX: 152 })
    expect(onSeekToTime).toHaveBeenCalledTimes(1)
    expect(onSeekToTime.mock.calls[0][0]).toBeCloseTo(4, 1) // 152 / 38
    expect(onScrubStart).not.toHaveBeenCalled()
    expect(onScrubEnd).not.toHaveBeenCalled()
  })

  it("a press that never travels 3px does not take the transport", () => {
    const { onScrubStart, ruler } = renderScrub()
    fireEvent.pointerDown(ruler, { button: 0, pointerId: 1, clientX: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 102 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 102 })
    expect(onScrubStart).not.toHaveBeenCalled()
  })

  it("takes the transport once, at the threshold, however far the drag goes", () => {
    const { onScrubStart, ruler } = renderScrub()
    fireEvent.pointerDown(ruler, { button: 0, pointerId: 1, clientX: 100 })
    for (const x of [140, 180, 220, 260]) fireEvent.pointerMove(window, { pointerId: 1, clientX: x })
    expect(onScrubStart).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 260 })
  })

  it("hands the transport back on release, and lands the final position", async () => {
    const { onSeekToTime, onScrubEnd, ruler } = renderScrub()
    fireEvent.pointerDown(ruler, { button: 0, pointerId: 1, clientX: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 380 })
    expect(onScrubEnd).toHaveBeenCalledTimes(1)
    // The landing seek goes through the ordinary funnel, which is what cues the
    // queue where the hand stopped.
    await waitFor(() => expect(onSeekToTime).toHaveBeenCalled())
    const landed = onSeekToTime.mock.calls[onSeekToTime.mock.calls.length - 1][0]
    expect(landed).toBeCloseTo(10, 1) // 380 / 38
  })

  // A CANCELLED DRAG COMMITS NOTHING — but the transport still has to come
  // back, or it stays suppressed for the rest of the session.
  it("hands the transport back when the pointer is taken away", () => {
    const { onScrubEnd, ruler } = renderScrub()
    fireEvent.pointerDown(ruler, { button: 0, pointerId: 1, clientX: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300 })
    fireEvent.pointerCancel(window, { pointerId: 1, clientX: 300 })
    expect(onScrubEnd).toHaveBeenCalledTimes(1)
  })

  /**
   * Frames, on demand. The gesture coalesces its work into a rAF, so without
   * driving one nothing it does is observable inside a test body at all —
   * which is how two of these first passed while asserting nothing.
   *
   * QUEUE AND FLUSH, never run-inline. A stub that invokes the callback
   * synchronously makes the coalescing guard latch forever: the callback clears
   * the pending-frame id BEFORE the assignment that stores it, so the id stays
   * set and every later move returns early. That is an artifact of the stub,
   * not of the code — and it silently reduced a ten-move drag to one.
   */
  function withFrames(run: (flush: () => void) => void) {
    const queued: FrameRequestCallback[] = []
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      queued.push(cb as FrameRequestCallback)
      return queued.length
    })
    // Inside `act`: the frame callback is what calls setState, and outside act
    // that update never reaches the DOM before the assertion reads it.
    const flush = () => { act(() => { for (const cb of queued.splice(0)) cb(0) }) }
    try { run(flush) } finally { raf.mockRestore() }
  }

  // THE JUDDER THIS EXISTS TO PREVENT. The three effects that write the
  // timeline's clock are each fired by a transport publishing where it actually
  // LANDED — always behind the pointer, because the picture is seeked on a
  // throttle. Leave them running during a drag and every seek yanks the head
  // back to where the throttle last sampled.
  //
  // This pins the OUTCOME, not one mechanism: the head is held on the hand
  // twice over — the effects stand down for the duration, and the head is drawn
  // from the scrub position rather than the clock — and removing either alone
  // leaves the other covering it. Removing both fails this.
  it("keeps the head on the hand when a transport publishes an older position", () => {
    mockQueueState = { kind: "playing", cellIndex: 0, cellId: "m1" }
    mockProgress = { currentTime: 2, duration: 20, rate: 1, volume: 1 }
    const clipped = [
      cell({
        id: "m1", original: "One", medium: "media", startTime: 0, endTime: 20,
        attachments: { "audio-f1-1690000000-shared.mp3": { type: "audio", url: "frontier-audio://src" } },
      } as Partial<CellData>),
    ]
    const { rerender } = render(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={clipped}
        onRetimeSubtitle={() => {}} onSeekToTime={() => {}}
        onScrubStart={() => {}} onScrubEnd={() => {}}
      />,
    )
    const head = () => parseFloat(screen.getByTestId("tl-playhead").style.left)
    const ruler = screen.getByTestId("tl-ruler")
    withFrames((flush) => {
      fireEvent.pointerDown(ruler, { button: 0, pointerId: 1, clientX: 100 })
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 38 * 12 })
      flush()
    })
    expect(head()).toBeCloseTo(38 * 12, 0)

    // The transport now reports where it got to. Mid-scrub, that is stale news.
    mockProgress = { currentTime: 4, duration: 20, rate: 1, volume: 1 }
    rerender(
      <TimelineEditor
        fileId="f1" coreMediaUrl={null} editable cells={clipped}
        onRetimeSubtitle={() => {}} onSeekToTime={() => {}}
        onScrubStart={() => {}} onScrubEnd={() => {}}
      />,
    )
    expect(head()).toBeCloseTo(38 * 12, 0)
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 38 * 12 })
    mockQueueState = { kind: "idle" }
    mockProgress = { currentTime: 0, duration: 0, rate: 1, volume: 1 }
  })

  // A drag's trailing `click` must not seek a second time and fight the
  // landing seek the release already issued.
  it("does not seek twice for one gesture", async () => {
    const { onSeekToTime, ruler } = renderScrub()
    fireEvent.pointerDown(ruler, { button: 0, pointerId: 1, clientX: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 300 })
    const afterRelease = onSeekToTime.mock.calls.length
    fireEvent.click(ruler, { clientX: 300 })
    expect(onSeekToTime).toHaveBeenCalledTimes(afterRelease)
  })

  // The workspace crossing is the expensive part of a seek — it re-renders the
  // whole project view — so it is throttled on top of the per-frame coalescing.
  it("does not cross into the workspace once per frame", () => {
    const { onSeekToTime, ruler } = renderScrub()
    withFrames((flush) => {
      fireEvent.pointerDown(ruler, { button: 0, pointerId: 1, clientX: 100 })
      for (let i = 0; i < 10; i += 1) {
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 140 + i * 10 })
        flush()
      }
    })
    // Ten frames' worth of movement, and the leading edge is the only one that
    // gets through inside the throttle window.
    expect(onSeekToTime.mock.calls.length).toBeGreaterThan(0)
    expect(onSeekToTime.mock.calls.length).toBeLessThan(10)
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 240 })
  })
})
