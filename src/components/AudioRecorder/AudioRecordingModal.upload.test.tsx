// AQU-646 stage 5: "Upload audio" inside the recording modal — attach a file
// instead of performing the line.
//
// The point of a modal-owned control (rather than reusing the cell rail's
// button) is that it runs through this dialog's PHASE MACHINE and can see the
// takes list, so an uploaded file arrives named like every other take. That
// naming is what the first test pins down. The other two are the two ways this
// can waste someone's time: a doomed upload while offline, and a file that was
// never going to play, sent to R2 anyway.

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
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  notifyAudioAttachmentsChanged: vi.fn(),
  injectOptimisticAudioAttachment: vi.fn(),
  injectOptimisticAudioRemove: vi.fn(),
}))
const emitAttach = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => "evt-attach"))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: (...args: unknown[]) => emitAttach(...args),
  emitCellAudioSelect: vi.fn(async () => "evt"),
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
vi.mock("@/lib/audio/audio-coordinator", () => ({ pushAudioShortcutOverride: () => () => {} }))

import { AudioRecordingModal } from "./AudioRecordingModal"

const project = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord
const cell = {
  id: "c1", fileId: "f1", original: "hello", translated: "bonjour",
  medium: "media", startTime: 0, endTime: 5,
} as unknown as CellData

const onTakeSaved = vi.fn()

function renderModal() {
  return render(
    <AudioRecordingModal
      open
      project={project}
      cells={[cell]}
      activeCellId="c1"
      username="sam"
      onActiveCellChange={() => {}}
      onTakeSaved={onTakeSaved}
      onClose={() => {}}
    />,
  )
}

/** Drive the hidden input the way a file picker does — `files` is read-only, so
 *  the browser's own assignment has to be simulated before the change event. */
function pick(file: File) {
  const input = screen.getByLabelText("Upload audio file") as HTMLInputElement
  Object.defineProperty(input, "files", { value: [file], configurable: true })
  fireEvent(input, new Event("change", { bubbles: true }))
}

describe("AudioRecordingModal — upload a file", () => {
  beforeEach(() => {
    onlineState.value = true
    recorderState.value = { kind: "idle" }
    attachmentsState.byCellId = new Map()
    emitAttach.mockClear()
    uploadSpy.mockClear()
    onTakeSaved.mockClear()
  })

  it("attaches the picked file as the NEXT numbered take", async () => {
    // One take already on the cell, so the strip's next name is "Take 2".
    attachmentsState.byCellId = new Map([["c1", {
      selectedAudioId: null,
      attachments: {
        "audio-c1-1000.webm": {
          audioId: "audio-c1-1000.webm",
          url: "frontier-audio://audio-c1-1000.webm",
          slot: "recording", label: "Take 1", mimeType: "audio/webm",
          voiceId: null, referenceAudioId: null, durationMs: 1000,
          trimStartMs: null, trimEndMs: null,
        },
      },
    }]])
    renderModal()
    pick(new File(["bytes"], "line.wav", { type: "audio/wav" }))

    await waitFor(() => expect(emitAttach).toHaveBeenCalled())
    expect(emitAttach.mock.calls[0][0]).toMatchObject({
      cellId: "c1",
      slot: "recording",
      // The whole reason this control lives in the modal rather than being the
      // rail button moved: the rail has no takes list, so it cannot name a take.
      label: "Take 2",
    })
    // The workspace hears about it exactly as it does for a recorded take, so a
    // text-less line still gets the target row that makes it countable work.
    await waitFor(() => expect(onTakeSaved).toHaveBeenCalledWith("c1"))
  })

  it("keeping a take leaves every way of making another one live (2026-08-13)", async () => {
    renderModal()
    pick(new File(["bytes"], "line.wav", { type: "audio/wav" }))

    // The confirmation is a note that names the take, not a screen that takes
    // the panel over…
    expect(await screen.findByTestId("rec-saved-note")).toHaveTextContent("Take 1 added")
    // …and every way of making ANOTHER take is still present and still usable.
    // This is the regression worth pinning: the state this replaced disabled
    // Record, dropped Generate and Upload from the panel entirely, ignored
    // Space, and — with auto-advance switched off — had no transition out of
    // itself at all, so the line was finished whether you meant it or not.
    expect(screen.getByTestId("rec-start")).toBeEnabled()
    expect(screen.getByTestId("rec-generate-tts")).toBeEnabled()
    expect(screen.getByTestId("rec-upload")).toBeEnabled()
  })

  it("offline: the upload button is disabled", () => {
    onlineState.value = false
    renderModal()
    expect(screen.getByTestId("rec-upload")).toBeDisabled()
  })

  it("a file that is not audio is refused WITHOUT uploading anything", async () => {
    renderModal()
    pick(new File(["not audio"], "notes.txt", { type: "text/plain" }))

    expect(await screen.findByTestId("rec-error-message")).toHaveTextContent(/doesn't look like an audio file/)
    expect(uploadSpy).not.toHaveBeenCalled()
    expect(emitAttach).not.toHaveBeenCalled()
  })
})
