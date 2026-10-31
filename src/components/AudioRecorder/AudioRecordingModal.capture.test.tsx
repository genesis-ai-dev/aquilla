// AQU-2327: opened by the Station's "Insert audio here › Record now", the
// recorder shows only what records and hands the recording back — no line
// navigation, none of the line's takes, no Upload or Generate. (Mocks as in
// AudioRecordingModal.ready.test.tsx.)

import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { screen } from "@testing-library/react"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

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
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellLaneRetime: vi.fn(async () => "evt"),
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
vi.mock("@/lib/audio/transcribe", () => ({ transcribeCell: vi.fn(async () => {}) }))
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
import { renderWithTooltips } from "@/test-utils/tooltip"
import { setRecordingTakesDrawerOpen } from "@/lib/store/recording-takes-drawer-pref"

const project = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord
const cell = {
  id: "c1", fileId: "f1", original: "hello", translated: "bonjour",
  medium: "media", startTime: 0, endTime: 2.5,
} as unknown as CellData

const take = (id: string, over: Record<string, unknown> = {}) => ({
  audioId: id, url: `frontier-audio://${id}`, slot: "recording", label: null, mimeType: "audio/wav",
  voiceId: null, referenceAudioId: null, durationMs: 3600, trimStartMs: null, trimEndMs: null, ...over,
})

function entry(over: Record<string, unknown>) {
  return new Map([["c1", {
    selectedAudioId: null, selectedGeneratedVoiceAudioId: null, audioTimings: {}, attachments: {}, ...over,
  }]])
}

const cell2 = { ...cell, id: "c2", startTime: 3, endTime: 5 } as unknown as CellData

function modalEl(onCaptured?: (blob: Blob, ext: string) => void) {
  return (
    <AudioRecordingModal
      open project={project} cells={[cell, cell2]} activeCellId="c1" username="sam"
      onActiveCellChange={() => {}} onTakeSaved={() => {}} onClose={() => {}}
      {...(onCaptured ? { onCaptured } : {})}
    />
  )
}

beforeEach(() => {
  onlineState.value = true
  recorderState.value = { kind: "idle" }
  attachmentsState.byCellId = new Map()
  player.selected.length = 0
  player.trims.length = 0
  player.play.mockClear()
  player.pause.mockClear()
  player.isPlaying = false
  activeAudio.value = null
})


const LINE_PARTS = ["rec-prev", "rec-next", "rec-ready-take", "rec-upload", "rec-generate-tts", "rec-takes-count", "rec-takes-drawer"]

describe("Record now from the Station", () => {
  beforeEach(() => {
    setRecordingTakesDrawerOpen(true)
    attachmentsState.byCellId = entry({
      selectedAudioId: "audio-c1-3.wav",
      attachments: { "audio-c1-3.wav": take("audio-c1-3.wav", { label: "Take 3" }) },
    })
  })
  afterEach(() => setRecordingTakesDrawerOpen(false))

  it("on a line, the recorder has its navigation, the line's takes, Upload and Generate", () => {
    renderWithTooltips(modalEl())
    for (const id of LINE_PARTS) expect(screen.queryAllByTestId(id).length, id).toBeGreaterThan(0)
    expect(screen.getByText("0:03.6")).toBeInTheDocument()
  })

  it("for an insert, it shows only what records: Record, the line to read, the format and the recording settings", () => {
    renderWithTooltips(modalEl(vi.fn()))
    for (const id of LINE_PARTS) expect(screen.queryAllByTestId(id), id).toHaveLength(0)
    expect(screen.getByTestId("rec-start")).toBeInTheDocument()
    expect(screen.getByTestId("rec-read-aloud")).toBeInTheDocument()
    expect(screen.getByTestId("rec-format")).toBeInTheDocument()
    expect(screen.getByTestId("rec-settings")).toBeInTheDocument()
    // Without the takes it fits what is left, rather than the tall column
    // whose lower half is the takes drawer.
    // The line's take (3.6 s here) is not measured on the bar: it starts empty.
    expect(screen.queryByText("0:03.6")).toBeNull()
    const panel = document.querySelector("[data-recorder-dialog]")!
    expect(panel.className).toContain("h-auto")
    expect(panel.className).not.toContain("h-[620px]")
  })

  it("for an insert, the settings keep the countdown and its beep, not the line-to-line ones", async () => {
    renderWithTooltips(modalEl(vi.fn()))
    await userEvent.setup().click(screen.getByTestId("rec-settings"))
    expect(await screen.findByTestId("rec-countdown")).toBeInTheDocument()
    expect(screen.queryByTestId("rec-auto-advance")).toBeNull()
    expect(screen.queryByTestId("rec-takes-drawer-open")).toBeNull()
  })
})
