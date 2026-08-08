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
  progress: { currentTime: 0, duration: 0, rate: 1, volume: 1 },
}
vi.mock("@/lib/audio/play-queue", () => ({
  useQueueForFile: () => mockQueue,
  // Mirrors the real rule: the queue's clock is file time only for a media cell
  // backed by the shared source clip.
  queueClockIsFileTime: (c: CellData | undefined | null) =>
    c?.medium === "media" && Boolean(c?.attachments),
}))

import { MediaVideoPane, readCaptionPlacement, readSubtitleMode } from "./MediaVideoPane"

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
  return render(<MediaVideoPane src="https://cdn/episode.webm" cells={CELLS} {...props} />)
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
      progress: { currentTime: 0, duration: 0, rate: 1, volume: 1 },
    }
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
    rerender(<MediaVideoPane src="https://cdn/episode.webm" cells={CELLS} />)
    expect(screen.getByTestId("video-pane-caption-target")).toHaveTextContent(
      "Que la paz de Cristo reine en sus corazones.",
    )

    sounding("c2")
    rerender(<MediaVideoPane src="https://cdn/episode.webm" cells={CELLS} />)
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
    expect(readSubtitleMode()).toBe("target")
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
    render(<MediaVideoPane src="https://cdn/episode.webm" cells={subtitleCells} onVideoTime={onVideoTime} />)
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
    rerender(<MediaVideoPane src="https://cdn/episode.webm" cells={CELLS} />)
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
})
