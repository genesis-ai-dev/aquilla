// AQU-1210: trim a take's silence in the recorder, before saving.
//
// After Stop the take is drawn with two lines at the window it would be born
// with anyway (the cue's start to just after Stop). Moving them changes what
// plays, what the target bar judges and what Save keeps — and a head trim
// re-places the take so its first kept sample still lands on the cue.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import { encodeWavPcm16 } from "@/lib/audio/wav-encode"

const onlineState = vi.hoisted(() => ({ value: true }))
vi.mock("@/hooks/useOnline", () => ({ useOnline: () => onlineState.value }))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "sam" }, loading: false }),
}))
const recorderState = vi.hoisted(() => ({
  value: { kind: "idle" } as Record<string, unknown>,
}))
const recorderStart = vi.hoisted(() => vi.fn())
const recorderPrewarm = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/useAudioRecorder", () => ({
  useAudioRecorder: () => ({
    state: recorderState.value,
    start: recorderStart,
    stop: vi.fn(),
    reset: vi.fn(),
    prewarm: recorderPrewarm,
  }),
}))
const probeMic = vi.hoisted(() => vi.fn(async () => "granted" as const))
vi.mock("./probeMicPermission", () => ({
  probeMicPermission: (...args: unknown[]) => probeMic(...(args as [])),
}))
const attachmentsState = vi.hoisted(() => ({ byCellId: new Map<string, unknown>() }))
vi.mock("@/hooks/useFileAudioAttachments", () => ({
  useFileAudioAttachments: () => ({ byCellId: attachmentsState.byCellId, isLoading: false, revalidate: vi.fn() }),
  mergeCellsWithAudio: (cells: unknown[]) => cells,
}))
vi.mock("@/lib/audio/voice-generate-helpers", () => ({ generateCellVoice: vi.fn(async () => true) }))
// MUST be mocked: the real probeDurationMsSafe waits on a media element that
// happy-dom will never load, and every upload here would sit for its full 15s
// timeout before the attach event fires.
vi.mock("@/lib/import", () => ({ probeDurationMsSafe: vi.fn(async () => 1000) }))
const injectAttach = vi.hoisted(() => vi.fn())
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  notifyAudioAttachmentsChanged: vi.fn(),
  injectOptimisticAudioAttachment: (...args: unknown[]) => injectAttach(...args),
  injectOptimisticAudioRemove: vi.fn(),
}))
const emitAttach = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => "evt-attach"))
const emitRetime = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => "evt-retime"))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellLaneRetime: (...args: unknown[]) => emitRetime(...args),
  emitCellAudioAttach: (...args: unknown[]) => emitAttach(...args),
  emitCellAudioSelect: vi.fn(async () => "evt"),
  emitCellAudioValidate: vi.fn(async () => "evt"),
  emitCellAudioRemove: vi.fn(async () => "evt"),
  emitCellAudioRename: vi.fn(async () => "evt"),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "sync-tok",
}))
const uploadSpy = vi.hoisted(() => vi.fn(async () => ({
  audioId: "audio-c1-999-new", ext: "wav", url: "frontier-audio://audio-c1-999-new.wav",
})))
vi.mock("@/lib/audio/upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCellAudio: vi.fn(async () => new ArrayBuffer(8)),
  uploadCellAudio: (...args: unknown[]) => uploadSpy(...(args as [])),
  deleteCellAudio: vi.fn(async () => {}),
}))
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("@/lib/audio/transcribe-status", () => ({ setTranscribeStatus: vi.fn() }))
const transcribeSpy = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}))
vi.mock("@/lib/audio/transcribe", () => ({ transcribeCell: (...args: unknown[]) => transcribeSpy(...args) }))
const activeAudio = vi.hoisted(() => ({ value: null as null | { isPlaying: () => boolean; pause: () => void } }))
vi.mock("@/lib/audio/audio-coordinator", () => ({
  pushAudioShortcutOverride: () => () => {},
  setActiveAudio: () => {},
  clearActiveAudioIf: () => {},
  claimActiveAudio: () => {},
  getActiveAudio: () => activeAudio.value,
}))
// The selected take's player, controllable per test.
const player = vi.hoisted(() => ({
  selected: [] as Array<string | undefined>,
  trims: [] as Array<[number | null, number | null]>,
  play: vi.fn(async () => {}),
  pause: vi.fn(),
  isPlaying: false,
}))
vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: (_p: unknown, cell: { metadata?: { selectedAudioId?: string } }) => {
    player.selected.push(cell.metadata?.selectedAudioId)
    return {
      state: "ready", error: null, isPlaying: player.isPlaying, currentTime: 0, duration: 4.1,
      peaks: new Float32Array([0.2, 0.9, 0.5, 0.7]), peaksState: "ready",
      play: player.play, pause: player.pause, seek: vi.fn(), setVolume: vi.fn(),
      setTrim: (s: number | null, e: number | null) => { player.trims.push([s, e]) },
      requestPeaks: vi.fn(async () => {}), ensureBytes: vi.fn(async () => new Uint8Array()),
    }
  },
}))

import { AudioRecordingModal } from "./AudioRecordingModal"

const project = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord
// A 3-second cue at 10s.
const cell = {
  id: "c1", fileId: "f1", original: "hello", translated: "bonjour",
  medium: "media", startTime: 10, endTime: 13,
} as unknown as CellData

/** A real 3.6s WAV take, as the recorder's WAV path hands it over. */
function wavTake() {
  const samples = new Float32Array(Math.round(3.6 * 8000))
  for (let i = 0; i < samples.length; i++) samples[i] = 0.4 * Math.sin(i / 5) * (i > 4000 && i < 26000 ? 1 : 0.02)
  return {
    kind: "stopped", blob: encodeWavPcm16(samples, 8000), mimeType: "audio/wav", ext: "wav",
    durationSec: 3.6, preRollMs: 200, tailGraceMs: 250,
  }
}

function modalEl() {
  return (
    <AudioRecordingModal
      open project={project} cells={[cell]} activeCellId="c1" username="sam"
      onActiveCellChange={() => {}} onTakeSaved={() => {}} onClose={() => {}}
    />
  )
}

async function previewShown() {
  await waitFor(() => expect(screen.getByTestId("rec-preview-waveform-shape")).toBeInTheDocument())
}

beforeEach(() => {
  onlineState.value = true
  attachmentsState.byCellId = new Map()
  emitAttach.mockClear()
  transcribeSpy.mockClear()
  emitRetime.mockClear()
  recorderState.value = wavTake()
})

describe("the take after Stop", () => {
  it("is drawn with its lines at the window it would be born with", async () => {
    render(modalEl())
    await previewShown()
    // Head at the 200ms pre-roll (= the cue's start), tail just past Stop.
    expect(screen.getByTestId("rec-trim-readout")).toHaveTextContent("0:00.2 – 0:03.3 · 0:03.1")
    const start = screen.getByRole("slider", { name: "Start of the kept audio" })
    expect(start).toHaveAttribute("data-editable", "true")
    expect(start.className).toContain("cursor-ew-resize")
    // The browser's own player is gone.
    expect(document.querySelector("audio[controls]")).toBeNull()
  })

  it("trims past the silence with the arrow keys; the bar judges the kept part", async () => {
    render(modalEl())
    await previewShown()
    const start = screen.getByRole("slider", { name: "Start of the kept audio" })
    for (let i = 0; i < 5; i++) fireEvent.keyDown(start, { key: "ArrowRight", shiftKey: true })
    await waitFor(() => expect(screen.getByTestId("rec-trim-readout")).toHaveTextContent("0:00.7 – 0:03.3 · 0:02.6"))
    // 2.6s against the 3.0s cue — inside the target once the silence is gone.
    expect(screen.getByText("0:02.6")).toBeInTheDocument()
  })

  it("saves the trim, and moves the take so its first kept sample lands on the cue", async () => {
    render(modalEl())
    await previewShown()
    const start = screen.getByRole("slider", { name: "Start of the kept audio" })
    for (let i = 0; i < 5; i++) fireEvent.keyDown(start, { key: "ArrowRight", shiftKey: true })
    const end = screen.getByRole("slider", { name: "End of the kept audio" })
    for (let i = 0; i < 4; i++) fireEvent.keyDown(end, { key: "ArrowLeft", shiftKey: true })
    await waitFor(() => expect(screen.getByTestId("rec-trim-readout")).toHaveTextContent("0:00.7 – 0:02.9"))
    fireEvent.click(screen.getByTestId("rec-save"))
    await waitFor(() => expect(emitAttach).toHaveBeenCalledTimes(1))
    expect(emitAttach.mock.calls[0][0]).toMatchObject({ durationMs: 3600, trimStartMs: 700, trimEndMs: 2960 })
    await waitFor(() => expect(emitRetime).toHaveBeenCalledTimes(1))
    // audible start = anchor + head trim = (10000 - 700) + 700 = the cue's start
    expect(emitRetime.mock.calls[0][0]).toMatchObject({ targetOffsetMs: -700 })
    // The transcript is of the kept part too.
    await waitFor(() => expect(transcribeSpy).toHaveBeenCalled())
    const { cell } = transcribeSpy.mock.calls.at(-1)![0] as { cell: { selectedAudioId: string; attachments: Record<string, unknown> } }
    expect(cell.attachments[cell.selectedAudioId]).toMatchObject({ trimStartMs: 700, trimEndMs: 2960 })
  })

  it("saves exactly today's window when the lines are left alone", async () => {
    render(modalEl())
    await previewShown()
    fireEvent.click(screen.getByTestId("rec-save"))
    await waitFor(() => expect(emitAttach).toHaveBeenCalledTimes(1))
    expect(emitAttach.mock.calls[0][0]).toMatchObject({ trimStartMs: 200, trimEndMs: 3360 })
    await waitFor(() => expect(emitRetime).toHaveBeenCalledTimes(1))
    expect(emitRetime.mock.calls[0][0]).toMatchObject({ targetOffsetMs: -200 })
  })

  it("puts the lines back where they started", async () => {
    render(modalEl())
    await previewShown()
    expect(screen.queryByTestId("rec-trim-reset")).toBeNull()
    const start = screen.getByRole("slider", { name: "Start of the kept audio" })
    fireEvent.keyDown(start, { key: "ArrowRight", shiftKey: true })
    fireEvent.click(await screen.findByTestId("rec-trim-reset"))
    await waitFor(() => expect(screen.getByTestId("rec-trim-readout")).toHaveTextContent("0:00.2 – 0:03.3 · 0:03.1"))
  })

  it("a new take starts from its own window, not the last one's trim", async () => {
    const { rerender } = render(modalEl())
    await previewShown()
    fireEvent.keyDown(screen.getByRole("slider", { name: "Start of the kept audio" }), { key: "ArrowRight", shiftKey: true })
    await waitFor(() => expect(screen.getByTestId("rec-trim-readout")).toHaveTextContent("0:00.3"))
    recorderState.value = wavTake()
    rerender(modalEl())
    await waitFor(() => expect(screen.getByTestId("rec-trim-readout")).toHaveTextContent("0:00.2 – 0:03.3"))
  })

  it("leaves Space its job: with a line focused it still saves", async () => {
    render(modalEl())
    await previewShown()
    const start = screen.getByRole("slider", { name: "Start of the kept audio" })
    start.focus()
    fireEvent.keyDown(start, { key: " " })
    await waitFor(() => expect(emitAttach).toHaveBeenCalledTimes(1))
  })
})

// AQU-1210 (Sam, 2026-09-25): on a film line, playing the kept part plays the
// film along with it — from the moment the take will sit on once saved.
describe("the film plays along with the preview", () => {
  const filmProject = {
    ...project, files: [{ id: "f1", name: "ep.vtt", coreMediaUrl: "https://cdn.example.com/ep.mp4" }],
  } as unknown as ProjectRecord

  it("rolls the film from the line's first frame when the kept part plays", async () => {
    const ready = vi.spyOn(window.HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4)
    // happy-dom plays nothing; stand in for the element reporting that it started.
    const play = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      this.onplay?.(new Event("play"))
      return Promise.resolve()
    })
    try {
      render(
        <AudioRecordingModal
          open project={filmProject} cells={[cell]} activeCellId="c1" username="sam"
          onActiveCellChange={() => {}} onTakeSaved={() => {}} onClose={() => {}}
        />,
      )
      await previewShown()
      const film = screen.getByTestId("rec-video") as HTMLVideoElement
      expect(play.mock.contexts).not.toContain(film)

      fireEvent.click(screen.getByTestId("rec-preview-waveform-play"))
      // The kept part starts at the pre-roll's end, which Save anchors on the
      // cue: the film rolls from the line's first frame, 10s.
      await waitFor(() => expect(play.mock.contexts).toContain(film))
      expect(film.currentTime).toBeCloseTo(10, 1)
    } finally {
      ready.mockRestore()
      play.mockRestore()
    }
  })
})
