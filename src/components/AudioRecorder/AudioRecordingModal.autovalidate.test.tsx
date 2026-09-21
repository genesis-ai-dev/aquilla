// AQU-490: a fresh recording validates itself, the way a direct human edit
// validates the cell. Sam's ruling — "the most directly understood by
// translators; if they don't want it they can complain."
//
// This suite drives the MIC save path end to end (recorder stopped → preview
// → Save), because that path is the only place the rule may fire. Every other
// suite here stubs `stop`, so without this the wiring had no test at all —
// and "unit tests green, live path broken" has already happened twice on this
// ticket.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/hooks/useOnline", () => ({ useOnline: () => true }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "sam" }, loading: false }),
}))
const recorderState = vi.hoisted(() => ({ value: { kind: "idle" } as Record<string, unknown> }))
vi.mock("@/hooks/useAudioRecorder", () => ({
  useAudioRecorder: () => ({
    state: recorderState.value, start: vi.fn(), stop: vi.fn(), reset: vi.fn(), prewarm: vi.fn(),
  }),
}))
vi.mock("./probeMicPermission", () => ({ probeMicPermission: vi.fn(async () => "granted") }))
vi.mock("@/hooks/useFileAudioAttachments", () => ({
  useFileAudioAttachments: () => ({ byCellId: new Map(), isLoading: false, revalidate: vi.fn() }),
  mergeCellsWithAudio: (cells: unknown[]) => cells,
}))
vi.mock("@/lib/audio/voice-generate-helpers", () => ({ generateCellVoice: vi.fn(async () => true) }))
vi.mock("@/lib/import", () => ({ probeDurationMsSafe: vi.fn(async () => 1000) }))
const inject = vi.hoisted(() => vi.fn())
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  notifyAudioAttachmentsChanged: vi.fn(),
  injectOptimisticAudioAttachment: (...a: unknown[]) => inject(...a),
  injectOptimisticAudioRemove: vi.fn(),
}))
const emitValidate = vi.hoisted(() => vi.fn(async () => "evt-validate"))
const emitAttach = vi.hoisted(() => vi.fn(async () => "evt-attach"))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellLaneRetime: vi.fn(async () => "evt"),
  emitCellAudioAttach: (...a: unknown[]) => emitAttach(...a),
  emitCellAudioSelect: vi.fn(async () => "evt"),
  emitCellAudioValidate: (...a: unknown[]) => emitValidate(...a),
  emitCellAudioRemove: vi.fn(async () => "evt"),
  emitCellAudioRename: vi.fn(async () => "evt"),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "sync-tok" }))
vi.mock("@/lib/audio/upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCellAudio: vi.fn(async () => new ArrayBuffer(8)),
  uploadCellAudio: vi.fn(async () => ({ audioId: "audio-c1-1-new", ext: "webm", url: "frontier-audio://audio-c1-1-new.webm" })),
  deleteCellAudio: vi.fn(async () => {}),
}))
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("@/lib/audio/transcribe-status", () => ({ setTranscribeStatus: vi.fn() }))
vi.mock("@/lib/audio/transcribe", () => ({ transcribeCell: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/audio-coordinator", () => ({ pushAudioShortcutOverride: () => () => {} }))

import { AudioRecordingModal } from "./AudioRecordingModal"

const cell = {
  id: "c1", fileId: "f1", original: "hello", translated: "bonjour",
  medium: "media", startTime: 0, endTime: 5,
} as unknown as CellData

function renderWith(projectOver: Record<string, unknown> = {}) {
  const project = { id: "p1", name: "P", ttsSettings: {}, ...projectOver } as unknown as ProjectRecord
  return render(
    <AudioRecordingModal
      open project={project} cells={[cell]} activeCellId="c1" username="sam"
      onActiveCellChange={() => {}} onClose={() => {}}
    />,
  )
}

/** A recording that has just stopped: the modal moves to preview and offers Save. */
function stoppedRecording() {
  recorderState.value = {
    kind: "stopped",
    blob: new Blob([new Uint8Array(8)], { type: "audio/webm" }),
    mimeType: "audio/webm", ext: "webm", durationSec: 1,
  }
}

async function saveTake() {
  const save = await screen.findByTestId("rec-save")
  fireEvent.click(save)
  await waitFor(() => expect(emitAttach).toHaveBeenCalledTimes(1))
}

beforeEach(() => {
  recorderState.value = { kind: "idle" }
  emitValidate.mockClear(); emitAttach.mockClear(); inject.mockClear()
})

describe("AudioRecordingModal — a fresh recording validates itself (AQU-490)", () => {
  it("emits cell.audio.validate for the just-saved take, after its attach", async () => {
    stoppedRecording()
    renderWith()
    await saveTake()
    await waitFor(() => expect(emitValidate).toHaveBeenCalledTimes(1))
    expect(emitValidate.mock.calls[0][0]).toMatchObject({
      projectId: "p1", fileId: "f1", cellId: "c1", audioId: "audio-c1-1-new.webm", author: "sam",
    })
    // The order is the rule: the vote names a take that must already exist.
    expect(emitAttach.mock.invocationCallOrder[0]).toBeLessThan(emitValidate.mock.invocationCallOrder[0])
  })

  it("shows the take as mine-and-validated before the projection comes back", async () => {
    stoppedRecording()
    renderWith()
    await saveTake()
    const injected = inject.mock.calls[0][2] as Record<string, unknown>
    expect(injected).toMatchObject({
      role: "dub", recordedBy: "sam", validators: ["sam"], validatorCount: 1,
    })
  })

  // The AUDIO switch, read on its own. Reading the text one here would be the
  // thing Sam's separate-settings ruling exists to prevent.
  it("does not when the project forbids validating your own recordings", async () => {
    stoppedRecording()
    renderWith({ allowSelfValidationAudio: false, allowSelfValidation: true })
    await saveTake()
    expect(emitValidate).not.toHaveBeenCalled()
    const injected = inject.mock.calls[0][2] as Record<string, unknown>
    expect(injected).toMatchObject({ validators: [], validatorCount: 0 })
  })

  it("does not for someone below the project's audio role floor", async () => {
    stoppedRecording()
    renderWith({
      validationRoleFloorAudio: "maintainer",
      syncRole: { level: 400, name: "contributor", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
    })
    await saveTake()
    expect(emitValidate).not.toHaveBeenCalled()
  })

  it("ignores the TEXT self-validation switch entirely", async () => {
    stoppedRecording()
    renderWith({ allowSelfValidation: false })
    await saveTake()
    expect(emitValidate).toHaveBeenCalledTimes(1)
  })
})
