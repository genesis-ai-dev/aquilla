import { describe, it, expect, beforeEach, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"

import type { CellData } from "@/hooks/useCells"
import type { QueueForFile } from "@/lib/audio/queue-scope"

// The queue is a module singleton driving real Audio elements; the pane only
// reads it. Stub the three entry points it uses so a test can put the transport
// wherever it likes without any audio.
let mockQueue: QueueForFile = {
  active: false,
  playing: false,
  running: false,
  cellId: null,
  kind: "idle",
  errorMessage: null,
  progress: { currentTime: 0, duration: 0, rate: 1, volume: 1 },
}
let mockAudibility: { source: boolean; target: boolean } = { source: true, target: true }
vi.mock("@/lib/audio/play-queue", () => ({
  useQueueForFile: () => mockQueue,
  // Mirrors the real rule: the queue's clock is file time only for a media cell
  // backed by the shared source clip.
  queueClockIsFileTime: (c: CellData | undefined | null) =>
    c?.medium === "media" && Boolean(c?.attachments),
  // Whether the film's soundtrack is on — the pane honours it when it is the
  // thing making the sound.
  useQueueAudibility: () => mockAudibility,
  // Stage 2: the pane seeds this file's persisted preference into the store on
  // mount and writes it back from the header's mute button, both through
  // @/lib/audio/audibility, which reaches for these two. The setter is inert on
  // purpose — `mockAudibility` stays the ONE thing deciding what the pane sees,
  // so a test can still put the flag wherever it likes before rendering.
  getQueueAudibility: () => mockAudibility,
  setQueueAudibility: () => {},
}))

import { MediaVideoPane, readCaptionPlacement, readSubtitleMode } from "./MediaVideoPane"
import {
  getVideoBuffering,
  getVideoSoundingCellId,
  resetVideoClockForTests,
} from "@/lib/timeline/video-clock"

const cell = (o: Partial<CellData>): CellData =>
  ({ id: "c1", fileId: "f1", original: "", translated: "", medium: "media", ...o }) as unknown as CellData

// `attachments` present = backed by the shared source clip, i.e. the queue's
// clock is file-timeline seconds and the pane can be slaved to it.
const CELLS = [
  cell({
    id: "c1",
    original: "episode-12.mp3",
    attachments: {},
    transcription: "Let the peace of Christ rule in your hearts.",
    translated: "Que la paz de Cristo reine en sus corazones.",
  }),
  cell({ id: "c2", original: "episode-12.mp3", attachments: {}, translated: "Y sean agradecidos." }),
]

function sounding(cellId: string, over: Partial<QueueForFile> = {}) {
  mockQueue = {
    ...mockQueue,
    active: true,
    playing: true,
    running: true,
    cellId,
    kind: "playing",
    ...over,
  }
}

function renderPane(props: Partial<React.ComponentProps<typeof MediaVideoPane>> = {}) {
  return render(<MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={CELLS} {...props} />)
}

describe("MediaVideoPane", () => {
  beforeEach(() => {
    localStorage.removeItem("codex:video-subtitle-mode")
    localStorage.removeItem("codex:video-caption-placement")
    mockQueue = {
      active: false,
      playing: false,
      running: false,
      cellId: null,
      kind: "idle",
      errorMessage: null,
      progress: { currentTime: 0, duration: 0, rate: 1, volume: 1 },
    }
    mockAudibility = { source: true, target: true }
  })

  // AQU-646 2026-08-11: when the picture is the transport, the queue is idle,
  // so everything that used to ask it "what is sounding" and "is it playing"
  // got nothing. Both are now answered by the element itself.
  describe("the picture as the transport", () => {
    const subs = [
      cell({ id: "s1", medium: "text", original: "Line one", translated: "Ligne un", startTime: 0, endTime: 5 }),
      cell({ id: "s2", medium: "text", original: "Line two", translated: "Ligne deux", startTime: 10, endTime: 15 }),
    ]
    const renderStandalone = (props = {}) =>
      render(<MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={subs} {...props} />)

    /** happy-dom has no media pipeline, so currentTime has to be planted. */
    const tickTo = (video: HTMLVideoElement, sec: number) => {
      Object.defineProperty(video, "currentTime", { value: sec, configurable: true })
      fireEvent.timeUpdate(video)
    }

    it("burns the line the picture is actually on", () => {
      renderStandalone()
      const video = screen.getByTestId("video-pane-media") as HTMLVideoElement
      expect(screen.queryByTestId("video-pane-caption")).not.toBeInTheDocument()
      tickTo(video, 2)
      expect(screen.getByTestId("video-pane-caption-target")).toHaveTextContent("Ligne un")
    })

    it("changes the line as the picture crosses into the next one", () => {
      renderStandalone()
      const video = screen.getByTestId("video-pane-media") as HTMLVideoElement
      tickTo(video, 2)
      expect(screen.getByTestId("video-pane-caption-target")).toHaveTextContent("Ligne un")
      tickTo(video, 12)
      expect(screen.getByTestId("video-pane-caption-target")).toHaveTextContent("Ligne deux")
    })

    it("clears the caption in a silence — there is no line to burn", () => {
      renderStandalone()
      const video = screen.getByTestId("video-pane-media") as HTMLVideoElement
      tickTo(video, 2)
      expect(screen.getByTestId("video-pane-caption")).toBeInTheDocument()
      tickTo(video, 7) // between the two cues
      expect(screen.queryByTestId("video-pane-caption")).not.toBeInTheDocument()
    })

    it("plays on a Space press, and pauses on the next one", () => {
      const play = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
      const pause = vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {})
      try {
        const { rerender } = renderStandalone({ togglePlay: { nonce: 0 } })
        const video = screen.getByTestId("video-pane-media") as HTMLVideoElement
        Object.defineProperty(video, "paused", { value: true, configurable: true })
        // Round 6: an element that cannot start yet is HELD rather than played
        // blind (see "play waits for the picture to be ready" below), and
        // happy-dom reports readyState 0 for everything. This test is about the
        // toggle, so give it a picture that is genuinely ready.
        Object.defineProperty(video, "readyState", { value: 4, configurable: true })
        rerender(<MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={subs} togglePlay={{ nonce: 1 }} />)
        expect(play).toHaveBeenCalled()

        Object.defineProperty(video, "paused", { value: false, configurable: true })
        rerender(<MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={subs} togglePlay={{ nonce: 2 }} />)
        expect(pause).toHaveBeenCalled()
      } finally {
        play.mockRestore()
        pause.mockRestore()
      }
    })

    it("ignores Space when the QUEUE is the transport — two writers would fight", () => {
      const play = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
      try {
        // renderPane()'s CELLS are media cells with the shared clip → slaved.
        const { rerender } = render(<MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={CELLS} togglePlay={{ nonce: 0 }} />)
        play.mockClear()
        rerender(<MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={CELLS} togglePlay={{ nonce: 1 }} />)
        expect(play).not.toHaveBeenCalled()
      } finally {
        play.mockRestore()
      }
    })
  })

  // AQU-646 2026-08-11: when the source chips come from a linked video, the
  // video IS the source audio — so the timeline's Source-track speaker button
  // has to reach it. Muting the original while listening back to a take is the
  // reason that button exists on that row.
  describe("the Source-track speaker button", () => {
    const subtitleCells = [cell({ id: "s1", medium: "text", original: "Line one" })]
    const renderStandalone = () =>
      render(<MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={subtitleCells} />)

    it("mutes the picture when the source track is muted", () => {
      mockAudibility = { source: false, target: true }
      renderStandalone()
      // The PROPERTY, not the attribute — happy-dom falls back to the attribute,
      // so an attribute check would pass even if React never set it.
      expect((screen.getByTestId("video-pane-media") as HTMLVideoElement).muted).toBe(true)
    })

    it("leaves it audible when the source track is audible", () => {
      renderStandalone()
      expect((screen.getByTestId("video-pane-media") as HTMLVideoElement).muted).toBe(false)
    })

    it("ignores the TARGET track — that one is the dub overlay's, not the video's", () => {
      mockAudibility = { source: true, target: false }
      renderStandalone()
      expect((screen.getByTestId("video-pane-media") as HTMLVideoElement).muted).toBe(false)
    })

    it("keeps a slaved picture silent whatever the source track says", () => {
      // Slaved means the queue is making the sound and the picture never should.
      mockAudibility = { source: true, target: true }
      renderPane()
      expect((screen.getByTestId("video-pane-media") as HTMLVideoElement).muted).toBe(true)
    })
  })

  it("is a muted picture surface with no competing controls", () => {
    renderPane()
    const video = screen.getByTestId("video-pane-media") as HTMLVideoElement
    // Assert the PROPERTY, not the attribute: happy-dom falls back to reading
    // the attribute, so an attribute-only check would pass even if React had
    // stopped setting it.
    expect(video.muted).toBe(true)
    expect(video.controls).toBe(false)
    expect(screen.getByTestId("tl-video-pane")).toHaveAttribute("data-video-state", "slaved")
  })

  it("burns the sounding line over the picture, and follows playback", () => {
    const { rerender } = renderPane()
    expect(screen.queryByTestId("video-pane-caption")).toBeNull()

    sounding("c1")
    rerender(<MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={CELLS} />)
    expect(screen.getByTestId("video-pane-caption-target")).toHaveTextContent(
      "Que la paz de Cristo reine en sus corazones.",
    )

    sounding("c2")
    rerender(<MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={CELLS} />)
    expect(screen.getByTestId("video-pane-caption-target")).toHaveTextContent("Y sean agradecidos.")
  })

  it("shows the transcript in Source mode — never the import filename", () => {
    sounding("c1")
    renderPane()
    fireEvent.click(screen.getByRole("tab", { name: "Source" }))
    const caption = screen.getByTestId("video-pane-caption-source")
    expect(caption).toHaveTextContent("Let the peace of Christ rule in your hearts.")
    expect(caption).not.toHaveTextContent("episode-12.mp3")
    expect(screen.queryByTestId("video-pane-caption-target")).toBeNull()
  })

  it("leaves the picture clean when a media line has no transcript yet", () => {
    // c2's stored source value is the filename. Blank beats "episode-12.mp3".
    sounding("c2")
    renderPane()
    fireEvent.click(screen.getByRole("tab", { name: "Source" }))
    expect(screen.queryByTestId("video-pane-caption")).toBeNull()
  })

  it("Both shows two lines, each with its own direction; Off shows none", () => {
    sounding("c1")
    renderPane({ targetDirectionMode: "rtl", sourceDirectionMode: "ltr" })
    fireEvent.click(screen.getByRole("tab", { name: "Both" }))
    expect(screen.getByTestId("video-pane-caption-target")).toHaveAttribute("dir", "rtl")
    expect(screen.getByTestId("video-pane-caption-source")).toHaveAttribute("dir", "ltr")

    fireEvent.click(screen.getByRole("tab", { name: "Off" }))
    expect(screen.queryByTestId("video-pane-caption")).toBeNull()
  })

  it("remembers the caption choice, and ignores a stored value it doesn't know", () => {
    renderPane()
    fireEvent.click(screen.getByRole("tab", { name: "Off" }))
    expect(localStorage.getItem("codex:video-subtitle-mode")).toBe("off")
    expect(readSubtitleMode()).toBe("off")

    localStorage.setItem("codex:video-subtitle-mode", "sideways")
    expect(readSubtitleMode()).toBe("both")
  })

  // 2026-08-11 (Sam): was "target", which burns nothing at all on a file with
  // no translation yet — the common case for footage being timed — and reads as
  // a broken caption rather than an empty one.
  it("defaults to showing BOTH lines when nothing is stored", () => {
    localStorage.removeItem("codex:video-subtitle-mode")
    expect(readSubtitleMode()).toBe("both")
    sounding("c1")
    renderPane()
    expect(screen.getByTestId("video-pane-caption-target")).toHaveTextContent(
      "Que la paz de Cristo reine en sus corazones.",
    )
    expect(screen.getByTestId("video-pane-caption-source")).toHaveTextContent(
      "Let the peace of Christ rule in your hearts.",
    )
  })

  it("still burns the source line when there is no translation yet", () => {
    // The reason the default moved off "target": footage being timed usually
    // has no target text at all, and a target-only caption burns nothing.
    localStorage.removeItem("codex:video-subtitle-mode")
    const untranslated = [
      cell({ id: "u1", medium: "media", attachments: {}, transcription: "In the beginning was the Word.", translated: "" }),
    ]
    sounding("u1")
    render(<MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={untranslated} />)
    expect(screen.getByTestId("video-pane-caption-source")).toHaveTextContent("In the beginning was the Word.")
    expect(screen.queryByTestId("video-pane-caption-target")).toBeNull()
  })

  it("hands the video back its controls when the queue cannot own the clock", () => {
    // A subtitle file timed against its footage: its cells are text, so the
    // queue can never produce file-timeline seconds. The video IS the player
    // and reports its own time upward.
    //
    // This is deliberately asserted on a file that DOES carry a dub, because
    // "has playable audio" was the first thing tried here and is wrong: it says
    // yes for this file, the pane slaves itself, every tick then fails the
    // file-time test and pauses — leaving a frozen frame with no controls.
    const subtitleCells = [
      cell({ id: "s1", medium: "text", original: "Line one", translated: "Ligne un", attachments: { a1: { url: "blob:x", type: "audio" } } }),
    ]
    const onVideoTime = vi.fn()
    render(<MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={subtitleCells} onVideoTime={onVideoTime} />)
    const video = screen.getByTestId("video-pane-media") as HTMLVideoElement
    expect(video.controls).toBe(true)
    expect(video.muted).toBe(false)
    expect(screen.getByTestId("tl-video-pane")).toHaveAttribute("data-video-state", "standalone")

    fireEvent.timeUpdate(video)
    expect(onVideoTime).toHaveBeenCalled()
  })

  it("heads its column with a Video label and the linked file's name", () => {
    renderPane()
    const header = screen.getByTestId("video-pane-header")
    expect(header).toHaveTextContent("Video")
    expect(header).toHaveTextContent("episode.webm")
    // Never the full URL — the pill is a name, not an address.
    expect(header).not.toHaveTextContent("https://")
  })

  it("keeps the caption controls on the picture, revealed while playback starts", () => {
    const { rerender } = renderPane()
    const controls = screen.getByTestId("video-pane-controls")
    // At rest they are faded out AND pointer-inert, so a click near a corner
    // hits the video rather than an invisible control.
    expect(controls.className).toContain("opacity-0")
    expect(controls.className).toContain("pointer-events-none")

    sounding("c1")
    rerender(<MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={CELLS} />)
    expect(screen.getByTestId("video-pane-controls").className).toContain("opacity-100")
  })

  it("lays the two caption controls out so they cannot cross", () => {
    // Positioned independently (one pinned left, one right) they overlapped by
    // 34px at the default pane width, and the later-painted one swallowed
    // clicks meant for the other — a press on "Target" toggled "In bar". One
    // row that wraps cannot do that at any width.
    renderPane()
    const controls = screen.getByTestId("video-pane-controls")
    expect(controls.className).toContain("flex-wrap")
    expect(controls.contains(screen.getByTestId("video-pane-placement-overlay"))).toBe(true)
    expect(controls.contains(screen.getByTestId("video-pane-mode-overlay"))).toBe(true)
  })

  it("puts the caption on the picture, not in the bars, by default", () => {
    // The exported video has no black bars, so the picture is where the line
    // really lives (Sam, 2026-08-08). Anchoring to the picture layer is also
    // what stops it drifting into a bar as the pane is resized.
    sounding("c1")
    renderPane()
    const caption = screen.getByTestId("video-pane-caption")
    const picture = screen.getByTestId("video-pane-picture")
    expect(picture.contains(caption)).toBe(true)
  })

  it("moves the caption off the picture when asked, and remembers", () => {
    sounding("c1")
    renderPane()
    fireEvent.click(screen.getByRole("tab", { name: "In bar" }))
    const caption = screen.getByTestId("video-pane-caption")
    expect(screen.getByTestId("video-pane-picture").contains(caption)).toBe(false)
    expect(screen.getByTestId("video-pane-field").contains(caption)).toBe(true)
    expect(localStorage.getItem("codex:video-caption-placement")).toBe("bar")
    expect(readCaptionPlacement()).toBe("bar")

    localStorage.setItem("codex:video-caption-placement", "sideways")
    expect(readCaptionPlacement()).toBe("picture")
  })

  it("hides the position control when captions are off — it would steer nothing", () => {
    renderPane()
    expect(screen.getByTestId("video-pane-placement-overlay")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("tab", { name: "Off" }))
    expect(screen.queryByTestId("video-pane-placement-overlay")).toBeNull()
    // ...and the control that turns them back on stays.
    expect(screen.getByTestId("video-pane-mode-overlay")).toBeInTheDocument()
  })

  it("says so when the source will not load, and offers a way to fix it", () => {
    const onChangeVideo = vi.fn()
    renderPane({ onChangeVideo })
    fireEvent.error(screen.getByTestId("video-pane-media"))

    expect(screen.getByTestId("tl-video-pane")).toHaveAttribute("data-video-state", "error")
    expect(screen.getByText("This video could not be loaded")).toBeInTheDocument()
    expect(screen.getByText("https://cdn/episode.webm")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Change video" }))
    expect(onChangeVideo).toHaveBeenCalledTimes(1)
  })

  // ── Round 6: waiting for the picture before starting it ──────────────────
  //
  // Sam's report: pause mid-film, drag the playhead back, press play
  // immediately — the picture starts with sound while the playhead and the bar
  // sit still, then everything lurches. Part of that was the queue being cued
  // behind our backs (fixed in ProjectWorkspace, which is not unit-testable),
  // and part was here: the play command went straight to `element.play()` with
  // a seek still in flight, and nothing in the app knew or could say so.
  describe("play waits for the picture to be ready", () => {
    /** A subtitle file with footage linked — the standalone arrangement. */
    const subs = [
      cell({ id: "s1", medium: "text", original: "Line one", translated: "Ligne un", startTime: 0, endTime: 5 }),
      cell({ id: "s2", medium: "text", original: "Line two", translated: "Ligne deux", startTime: 10, endTime: 15 }),
    ]

    /** happy-dom has no media pipeline: readiness and play() have to be planted. */
    const plant = (video: HTMLVideoElement, o: { readyState?: number; seeking?: boolean } = {}) => {
      Object.defineProperty(video, "readyState", { value: o.readyState ?? 0, configurable: true })
      Object.defineProperty(video, "seeking", { value: o.seeking ?? false, configurable: true })
      const play = vi.fn(() => Promise.resolve())
      video.play = play as unknown as HTMLVideoElement["play"]
      video.pause = vi.fn() as unknown as HTMLVideoElement["pause"]
      return play
    }

    /** Mount standalone, then arm the element, then press. */
    const pressPlay = (o: { readyState?: number; seeking?: boolean } = {}) => {
      const view = render(
        <MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={subs} onVideoTime={vi.fn()} />,
      )
      const video = screen.getByTestId("video-pane-media") as HTMLVideoElement
      const play = plant(video, o)
      const press = (nonce: number) =>
        view.rerender(
          <MediaVideoPane
            src="https://cdn/episode.webm"
            fileId="f1"
            cells={subs}
            onVideoTime={vi.fn()}
            togglePlay={{ nonce }}
          />,
        )
      press(1)
      return { video, play, press, view }
    }

    beforeEach(() => {
      resetVideoClockForTests()
    })

    it("starts at once when the picture is already able to", () => {
      // The overwhelmingly common case has to behave exactly as it always did:
      // no wait, no spinner, no deferral.
      const { play } = pressPlay({ readyState: 4 })
      expect(play).toHaveBeenCalledTimes(1)
      expect(getVideoBuffering()).toBe(false)
    })

    it("holds the start while a seek is still landing, and says it is waiting", () => {
      // `readyState` alone is not enough: an element that has the old position
      // buffered reports 4 while seeking somewhere it does not.
      const { play } = pressPlay({ readyState: 4, seeking: true })
      expect(play).not.toHaveBeenCalled()
      expect(getVideoBuffering()).toBe(true)
    })

    it("starts when the seek lands", () => {
      const { video, play } = pressPlay({ readyState: 0 })
      expect(play).not.toHaveBeenCalled()
      fireEvent.seeked(video)
      expect(play).toHaveBeenCalledTimes(1)
      expect(getVideoBuffering()).toBe(false)
    })

    it("starts when a freshly opened element reports it can play", () => {
      // Both events are needed and they are not interchangeable: `seeked` is
      // what a streamed, unbuffered range fires; `canplay` is what a fresh open
      // reports. Waiting on either alone hangs half the time.
      const { video, play } = pressPlay({ readyState: 0 })
      fireEvent.canPlay(video)
      expect(play).toHaveBeenCalledTimes(1)
    })

    it("only starts once, however many events arrive", () => {
      const { video, play } = pressPlay({ readyState: 0 })
      fireEvent.seeked(video)
      fireEvent.canPlay(video)
      fireEvent.seeked(video)
      expect(play).toHaveBeenCalledTimes(1)
    })

    it("a second press during the wait CANCELS it", () => {
      // The element stays `paused` all through the wait, so a toggle that only
      // looked at `paused` would re-arm the gate and the spinner would be the
      // only way out of a start you had changed your mind about.
      const { video, play, press } = pressPlay({ readyState: 0 })
      expect(getVideoBuffering()).toBe(true)
      press(2)
      expect(getVideoBuffering()).toBe(false)
      fireEvent.seeked(video)
      expect(play).not.toHaveBeenCalled()
    })

    it("gives up if the picture turns out to be unplayable", () => {
      const { video, play } = pressPlay({ readyState: 0 })
      fireEvent.error(video)
      expect(play).not.toHaveBeenCalled()
      expect(getVideoBuffering()).toBe(false)
    })

    it("starts anyway rather than waiting forever", () => {
      // Patience, not a promise: a stream that never reports ready must not
      // leave a dead button and a spinner.
      vi.useFakeTimers()
      try {
        const { play } = pressPlay({ readyState: 0 })
        expect(play).not.toHaveBeenCalled()
        vi.advanceTimersByTime(4000)
        expect(play).toHaveBeenCalledTimes(1)
        expect(getVideoBuffering()).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it("does not start a picture the recorder has since silenced", () => {
      // The transport can change its mind while we wait, and the take must not
      // pick up the film starting behind it.
      const view = render(
        <MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={subs} onVideoTime={vi.fn()} />,
      )
      const video = screen.getByTestId("video-pane-media") as HTMLVideoElement
      const play = plant(video, { readyState: 0 })
      view.rerender(
        <MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={subs} onVideoTime={vi.fn()} togglePlay={{ nonce: 1 }} />,
      )
      expect(getVideoBuffering()).toBe(true)
      view.rerender(
        <MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={subs} onVideoTime={vi.fn()} togglePlay={{ nonce: 1 }} suspended />,
      )
      fireEvent.seeked(video)
      expect(play).not.toHaveBeenCalled()
      expect(getVideoBuffering()).toBe(false)
    })
  })

  // ── Round 6: publishing where the picture is ─────────────────────────────
  describe("the position it publishes", () => {
    const subs = [
      cell({ id: "s1", medium: "text", original: "Line one", translated: "Ligne un", startTime: 0, endTime: 5 }),
      cell({ id: "s2", medium: "text", original: "Line two", translated: "Ligne deux", startTime: 10, endTime: 15 }),
    ]

    beforeEach(() => {
      resetVideoClockForTests()
    })

    it("says where a seek is going without waiting to be told it arrived", () => {
      // `timeupdate` is silent for the whole duration of a seek, and a browser
      // may not fire it at all against an element that has not opened yet — so
      // on a PAUSED film this is what stops the playhead, the bar's readout and
      // the marked row from sitting on the position the film used to be at.
      const onVideoTime = vi.fn()
      const view = render(
        <MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={subs} onVideoTime={onVideoTime} />,
      )
      onVideoTime.mockClear()
      view.rerender(
        <MediaVideoPane
          src="https://cdn/episode.webm"
          fileId="f1"
          cells={subs}
          onVideoTime={onVideoTime}
          seekSec={{ sec: 12, nonce: 1 }}
        />,
      )
      expect(onVideoTime).toHaveBeenCalledWith(12)
      // ...and the line under the new position comes with it, so the dialogue
      // table's marked row moves on a scrub rather than on the next tick.
      expect(getVideoSoundingCellId()).toBe("s2")
    })

    it("confirms where it actually landed", () => {
      const onVideoTime = vi.fn()
      render(<MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={subs} onVideoTime={onVideoTime} />)
      const video = screen.getByTestId("video-pane-media") as HTMLVideoElement
      Object.defineProperty(video, "currentTime", { value: 11.5, configurable: true })
      onVideoTime.mockClear()
      fireEvent.seeked(video)
      expect(onVideoTime).toHaveBeenCalledWith(11.5)
    })

    it("publishes nothing while the queue owns the clock", () => {
      // A slaved picture is the queue's to report; two writers would fight.
      const onVideoTime = vi.fn()
      const view = render(
        <MediaVideoPane src="https://cdn/episode.webm" fileId="f1" cells={CELLS} onVideoTime={onVideoTime} />,
      )
      onVideoTime.mockClear()
      view.rerender(
        <MediaVideoPane
          src="https://cdn/episode.webm"
          fileId="f1"
          cells={CELLS}
          onVideoTime={onVideoTime}
          seekSec={{ sec: 12, nonce: 1 }}
        />,
      )
      expect(onVideoTime).not.toHaveBeenCalledWith(12)
    })
  })
})
