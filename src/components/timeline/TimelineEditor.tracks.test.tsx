import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen, fireEvent, waitFor } from "@testing-library/react"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { TimelineEditor } from "./TimelineEditor"
import { buildTrackMetadata } from "@/lib/timeline/tracks"
import type { CellData } from "@/hooks/useCells"
import type { QueueState, QueueProgress } from "@/lib/audio/play-queue"

// AQU-904: a second cue file (Come and See's audio VTT) must land BESIDE the
// subtitle cues, not over them. These tests pin the two halves of that: what
// the editor derives from track-tagged cells, and that the import control
// hands the picked file straight through with the kind that was clicked.
//
// Same play-queue / shortcut stubs as TimelineEditor.test.tsx — the editor
// subscribes to both on mount and neither is under test here.
const mockQueueState: QueueState = { kind: "idle" }
const mockProgress: QueueProgress = { currentTime: 0, duration: 0, rate: 1, volume: 1 }
const mockMissingCells: ReadonlySet<string> = new Set()
vi.mock("@/lib/audio/play-queue", () => ({
  useQueueState: () => mockQueueState,
  useQueueProgress: () => mockProgress,
  useMissingClipCells: () => mockMissingCells,
  MISSING_AUDIO_MESSAGE: "This clip's audio is missing.",
  setQueueAudibility: () => {},
}))
vi.mock("@/lib/audio/audio-coordinator", () => ({
  pushAudioShortcutOverride: () => Object.assign(() => {}, { owner: 1 }),
  isTopAudioShortcutOwner: () => true,
  isInEditableContext: () => false,
}))

const cell = (o: Partial<CellData>): CellData =>
  ({ fileId: "f1", original: "", translated: "", ...o }) as unknown as CellData

/** A cue belonging to an imported track. */
const trackCell = (
  id: string,
  trackId: string,
  label: string,
  kind: "subtitle" | "audio",
  startTime: number,
): CellData =>
  cell({
    id,
    original: id,
    medium: "text",
    startTime,
    endTime: startTime + 1,
    metadata: buildTrackMetadata({ id: trackId, label, kind }),
  })

const SUB = cell({ id: "s1", original: "Sub line", medium: "text", startTime: 0, endTime: 2 })
const DUB = trackCell("a1", "trk_audio", "ep1-audio.vtt", "audio", 3)

const laneIds = () =>
  [...document.querySelectorAll('[data-variant="subtitle"]')].map((el) =>
    el.getAttribute("data-track-id"),
  )

let fileSeq = 0
/** Fresh fileId per render: hidden tracks and zoom persist per file. */
const nextFileId = () => `tracks-f${++fileSeq}`

describe("TimelineEditor cue tracks (AQU-904)", () => {
  beforeEach(() => localStorage.clear())

  it("draws exactly one subtitle lane when no cell is track-tagged", () => {
    renderWithTooltips(
      <TimelineEditor
        fileId={nextFileId()}
        coreMediaUrl={null}
        editable
        cells={[SUB, cell({ id: "d1", original: "Dia", medium: "media", startTime: 1, endTime: 4 })]}
        onRetimeSubtitle={() => {}}
      />,
    )
    expect(laneIds()).toEqual(["default"])
    expect(screen.getByText("Subtitles")).toBeInTheDocument()
  })

  it("keeps an imported audio track in its own lane, named by its file", () => {
    renderWithTooltips(
      <TimelineEditor
        fileId={nextFileId()}
        coreMediaUrl={null}
        editable
        cells={[SUB, DUB]}
        onRetimeSubtitle={() => {}}
      />,
    )
    // Two distinct subtitle-variant lanes, the default one first.
    expect(laneIds()).toEqual(["default", "trk_audio"])
    expect(screen.getByText("Subtitles")).toBeInTheDocument()
    expect(screen.getByText("ep1-audio.vtt")).toBeInTheDocument()
    // Each cue draws on its own lane — the subtitle cue is NOT duplicated.
    const dubLane = document.querySelector('[data-track-id="trk_audio"]')!
    expect(dubLane.querySelector('[data-testid="tl-card-a1"]')).toBeTruthy()
    expect(dubLane.querySelector('[data-testid="tl-card-s1"]')).toBeFalsy()
  })

  it("hides just the picked track, and remembers it for the file", () => {
    const fileId = nextFileId()
    const props = {
      fileId,
      coreMediaUrl: null,
      editable: true,
      cells: [SUB, DUB],
      onRetimeSubtitle: () => {},
    }
    const { unmount } = renderWithTooltips(<TimelineEditor {...props} />)

    fireEvent.click(screen.getByTestId("tl-track-eye-trk_audio"))
    expect(laneIds()).toEqual(["default"])
    // The default track is untouched, and the hidden one stays reachable.
    expect(screen.getByTestId("tl-track-eye-trk_audio")).toBeInTheDocument()

    unmount()
    renderWithTooltips(<TimelineEditor {...props} />)
    expect(laneIds()).toEqual(["default"])

    fireEvent.click(screen.getByTestId("tl-track-eye-trk_audio"))
    expect(laneIds()).toEqual(["default", "trk_audio"])
  })

  it("offers no hide control on the default track until a second track exists", () => {
    const { unmount } = renderWithTooltips(
      <TimelineEditor
        fileId={nextFileId()}
        coreMediaUrl={null}
        editable
        cells={[SUB]}
        onRetimeSubtitle={() => {}}
      />,
    )
    expect(screen.queryByTestId("tl-track-eye-default")).not.toBeInTheDocument()
    unmount()

    renderWithTooltips(
      <TimelineEditor
        fileId={nextFileId()}
        coreMediaUrl={null}
        editable
        cells={[SUB, DUB]}
        onRetimeSubtitle={() => {}}
      />,
    )
    expect(screen.getByTestId("tl-track-eye-default")).toBeInTheDocument()
  })

  it("splits two imported VTTs into two lanes alongside the original cues", () => {
    renderWithTooltips(
      <TimelineEditor
        fileId={nextFileId()}
        coreMediaUrl={null}
        editable
        cells={[SUB, DUB, trackCell("b1", "trk_subs2", "ep1-subs-fr.vtt", "subtitle", 5)]}
        onRetimeSubtitle={() => {}}
      />,
    )
    expect(laneIds()).toEqual(["default", "trk_audio", "trk_subs2"])
  })

  it("passes the picked file up with the kind of button that was clicked", async () => {
    const onImportTrack = vi.fn(async () => {})
    renderWithTooltips(
      <TimelineEditor
        fileId={nextFileId()}
        coreMediaUrl={null}
        editable
        cells={[SUB]}
        onRetimeSubtitle={() => {}}
        onImportTrack={onImportTrack}
      />,
    )
    const audioFile = new File(["WEBVTT"], "ep1-audio.vtt", { type: "text/vtt" })
    const input = screen
      .getByTestId("tl-import-audio-track")
      .querySelector("input[type=file]") as HTMLInputElement
    fireEvent.change(input, { target: { files: [audioFile] } })
    await waitFor(() => expect(onImportTrack).toHaveBeenCalledWith(audioFile, "audio"))

    const subFile = new File(["WEBVTT"], "ep1-subs.vtt", { type: "text/vtt" })
    const subInput = screen
      .getByTestId("tl-import-subtitle-track")
      .querySelector("input[type=file]") as HTMLInputElement
    fireEvent.change(subInput, { target: { files: [subFile] } })
    await waitFor(() => expect(onImportTrack).toHaveBeenCalledWith(subFile, "subtitle"))
  })

  it("surfaces a failed import instead of swallowing it", async () => {
    const onImportTrack = vi.fn(async () => {
      throw new Error("\"empty.vtt\" has no timed cues.")
    })
    renderWithTooltips(
      <TimelineEditor
        fileId={nextFileId()}
        coreMediaUrl={null}
        editable
        cells={[SUB]}
        onRetimeSubtitle={() => {}}
        onImportTrack={onImportTrack}
      />,
    )
    const input = screen
      .getByTestId("tl-import-audio-track")
      .querySelector("input[type=file]") as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([""], "empty.vtt")] } })
    const row = await screen.findByTestId("tl-import-track-error")
    expect(row).toHaveTextContent("has no timed cues")
  })

  it("hides the import control from a read-only viewer", () => {
    renderWithTooltips(
      <TimelineEditor
        fileId={nextFileId()}
        coreMediaUrl={null}
        editable={false}
        cells={[SUB]}
        onRetimeSubtitle={() => {}}
        onImportTrack={async () => {}}
      />,
    )
    expect(screen.queryByTestId("tl-import-audio-track")).not.toBeInTheDocument()
  })
})
