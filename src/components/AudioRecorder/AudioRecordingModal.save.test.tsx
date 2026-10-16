// What Save sends, pinned. (AQU-1210, slice 0)
//
// Nothing asserted this until now, and AQU-1210 is about to let the operator
// change it: a pre-save trim rewrites the take's window AND its placement. The
// promise that goes with that feature is that a take saved WITHOUT touching
// the trim lines is exactly what it is today — same window, same retime. These
// are that promise, written down before the feature exists.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
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

const project = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord
const cell = {
  id: "c1", fileId: "f1", original: "hello", translated: "bonjour",
  medium: "media", startTime: 10, endTime: 13,
} as unknown as CellData

function renderModal() {
  return render(
    <AudioRecordingModal
      open project={project} cells={[cell]} activeCellId="c1" username="sam"
      onActiveCellChange={() => {}} onTakeSaved={() => {}} onClose={() => {}}
    />,
  )
}

beforeEach(() => {
  onlineState.value = true
  attachmentsState.byCellId = new Map()
  emitAttach.mockClear()
  emitRetime.mockClear()
})

describe("Save, untouched", () => {
  it("a WAV take opens on the cue's start and closes just past Stop", async () => {
    // The WAV path anchors the take 200ms early (the pre-roll) and keeps 250ms
    // of grace after Stop. The window undoes both: head trim = the pre-roll,
    // so audible start = anchor + trim = the cue's own start.
    recorderState.value = {
      kind: "stopped", blob: new Blob(["x"], { type: "audio/wav" }), mimeType: "audio/wav", ext: "wav",
      durationSec: 3.6, preRollMs: 200, tailGraceMs: 250,
    }
    renderModal()
    fireEvent.click(screen.getByTestId("rec-save"))
    await waitFor(() => expect(emitAttach).toHaveBeenCalledTimes(1))
    expect(emitAttach.mock.calls[0][0]).toMatchObject({ durationMs: 3600, trimStartMs: 200, trimEndMs: 3360 })
    await waitFor(() => expect(emitRetime).toHaveBeenCalledTimes(1))
    expect(emitRetime.mock.calls[0][0]).toMatchObject({ cellId: "c1", targetOffsetMs: -200 })
    // AQU-1572: the save is ONE attach carrying the recorder's origin, which
    // is what the emit seam counts as one `audio recorded`.
    expect(emitAttach.mock.calls[0][0]).toMatchObject({ audioOrigin: "record", surface: "recorder" })
  })

  it("a compressed take carries no window and no retime", async () => {
    recorderState.value = {
      kind: "stopped", blob: new Blob(["x"], { type: "audio/webm" }), mimeType: "audio/webm", ext: "webm",
      durationSec: 3.6,
    }
    renderModal()
    fireEvent.click(screen.getByTestId("rec-save"))
    await waitFor(() => expect(emitAttach).toHaveBeenCalledTimes(1))
    const attach = emitAttach.mock.calls[0][0] as Record<string, unknown>
    expect(attach.durationMs).toBe(3600)
    expect("trimStartMs" in attach).toBe(false)
    expect("trimEndMs" in attach).toBe(false)
    // Give any retime a chance to fire; none should.
    await new Promise((r) => setTimeout(r, 0))
    expect(emitRetime).not.toHaveBeenCalled()
  })

  it("a take anchored at file zero has nothing to window out at its head", async () => {
    recorderState.value = {
      kind: "stopped", blob: new Blob(["x"], { type: "audio/wav" }), mimeType: "audio/wav", ext: "wav",
      durationSec: 3.6, preRollMs: 0, tailGraceMs: 250,
    }
    renderModal()
    fireEvent.click(screen.getByTestId("rec-save"))
    await waitFor(() => expect(emitAttach).toHaveBeenCalledTimes(1))
    const attach = emitAttach.mock.calls[0][0] as Record<string, unknown>
    expect("trimStartMs" in attach).toBe(false)
    expect(attach.trimEndMs).toBe(3360)
  })
})
