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
let mockHasAudio = true
vi.mock("@/lib/audio/play-queue", () => ({
  useQueueForFile: () => mockQueue,
  hasAnyPlayableAudio: () => mockHasAudio,
  queueClockIsFileTime: (c: CellData | undefined | null) =>
    c?.medium === "media" && Boolean(c?.attachments),
}))

import { MediaVideoPane, readSubtitleMode } from "./MediaVideoPane"

const cell = (o: Partial<CellData>): CellData =>
  ({ id: "c1", fileId: "f1", original: "", translated: "", medium: "media", ...o }) as unknown as CellData

const CELLS = [
  cell({
    id: "c1",
    original: "episode-12.mp3",
    transcription: "Let the peace of Christ rule in your hearts.",
    translated: "Que la paz de Cristo reine en sus corazones.",
  }),
  cell({ id: "c2", original: "episode-12.mp3", translated: "Y sean agradecidos." }),
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
    mockHasAudio = true
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

  it("hands the video back its controls when the file has no audio at all", () => {
    // A subtitle file timed against its footage: the queue can never start, so
    // the video IS the player and reports its own time upward.
    mockHasAudio = false
    const onVideoTime = vi.fn()
    renderPane({ onVideoTime })
    const video = screen.getByTestId("video-pane-media") as HTMLVideoElement
    expect(video.controls).toBe(true)
    expect(video.muted).toBe(false)
    expect(screen.getByTestId("tl-video-pane")).toHaveAttribute("data-video-state", "standalone")

    fireEvent.timeUpdate(video)
    expect(onVideoTime).toHaveBeenCalled()
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
