// Decision 2026-08-05: recording is blocked UP FRONT while offline — the
// feature knows the app is offline and says so, instead of failing mid-flow.
// Capture is local, so a take caught by a mid-flow flap stays previewable and
// saves after reconnect.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
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
vi.mock("@/lib/import", () => ({ probeDurationMsSafe: vi.fn(async () => 1000) }))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  notifyAudioAttachmentsChanged: vi.fn(),
  injectOptimisticAudioAttachment: vi.fn(),
  injectOptimisticAudioRemove: vi.fn(),
}))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async () => "evt"),
  emitCellAudioSelect: vi.fn(async () => "evt"),
  emitCellAudioRemove: vi.fn(async () => "evt"),
  emitCellAudioRename: vi.fn(async () => "evt"),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "sync-tok",
}))
const uploadSpy = vi.hoisted(() => vi.fn(async () => ({
  audioId: "audio-c1-999-new", ext: "webm", url: "frontier-audio://audio-c1-999-new.webm",
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
vi.mock("@/lib/audio/audio-coordinator", () => ({ pushAudioShortcutOverride: () => () => {} }))

import { AudioRecordingModal } from "./AudioRecordingModal"

const project = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord
const cell = {
  id: "c1", fileId: "f1", original: "hello", translated: "bonjour",
  medium: "media", startTime: 0, endTime: 5,
} as unknown as CellData

function renderModal() {
  return render(
    <AudioRecordingModal
      open
      project={project}
      cells={[cell]}
      activeCellId="c1"
      username="sam"
      onActiveCellChange={() => {}}
      onClose={() => {}}
    />,
  )
}

const OFFLINE_RE = /You're offline — recordings can't be saved/

describe("AudioRecordingModal — offline gate", () => {
  beforeEach(() => {
    onlineState.value = true
    recorderState.value = { kind: "idle" }
    attachmentsState.byCellId = new Map()
    probeMic.mockClear()
    recorderStart.mockClear()
    recorderPrewarm.mockClear()
    uploadSpy.mockClear()
  })

  it("offline: Start and Generate TTS are disabled", () => {
    onlineState.value = false
    renderModal()
    expect(screen.getByTestId("rec-start")).toBeDisabled()
    expect(screen.getByTestId("rec-generate-tts")).toBeDisabled()
  })

  it("offline: Space shows the offline message and never touches the mic", () => {
    onlineState.value = false
    renderModal()
    fireEvent.keyDown(window, { key: " " })
    expect(screen.getByText(OFFLINE_RE)).toBeInTheDocument()
    expect(probeMic).not.toHaveBeenCalled()
    expect(recorderPrewarm).not.toHaveBeenCalled()
  })

  it("offline in preview: Save disabled with the notice, the take still previewable, no upload", () => {
    onlineState.value = false
    recorderState.value = {
      kind: "stopped",
      blob: new Blob(["x"], { type: "audio/webm" }),
      mimeType: "audio/webm", ext: "webm", durationSec: 2,
    }
    renderModal()
    expect(screen.getByTestId("rec-save")).toBeDisabled()
    expect(screen.getByTestId("rec-offline-notice")).toBeInTheDocument()
    // The captured take is never lost — the modal stays in the PREVIEW phase
    // (Retake still offered; the player itself needs URL.createObjectURL,
    // absent in jsdom — the browser pass covers audibility).
    expect(screen.getByRole("button", { name: /Retake/ })).toBeInTheDocument()
    // The Space/Enter path is silently backstopped — no upload attempt.
    fireEvent.keyDown(window, { key: "Enter" })
    expect(uploadSpy).not.toHaveBeenCalled()
  })

  it("back online: Space reaches the mic probe again", () => {
    onlineState.value = true
    renderModal()
    fireEvent.keyDown(window, { key: " " })
    expect(probeMic).toHaveBeenCalledTimes(1)
  })
})
