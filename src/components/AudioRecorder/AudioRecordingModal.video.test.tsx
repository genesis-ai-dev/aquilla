// AQU-646 stage 5: the film beside the recording stage.
//
// Three things are worth a test here, and the first is worth more than the
// other two put together: the url is dug out of `project.files`, which most
// ProjectRecord fixtures in this codebase (including the ones the other two
// modal suites use) do not have at all. A `project.files.find` would throw on
// them and take two green suites down with it.
//
// The other two guard the sound rule the whole surface exists under: the mic is
// opened with echo cancellation, noise suppression and auto gain ALL off, so an
// audible film records straight into the take. Muted by default, and running
// only while the take is actually capturing.

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
import { resetRecordingFilmAudibleCacheForTests } from "@/lib/store/recording-film-audible-pref"

const FILM = "https://cdn.example.com/ep.mp4"

/** The fixture shape every other modal suite uses: NO `files` key at all. */
const projectNoFilesKey = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord
const projectEmptyFiles = { id: "p1", name: "P", ttsSettings: {}, files: [] } as unknown as ProjectRecord
const projectWithFilm = {
  id: "p1", name: "P", ttsSettings: {},
  files: [{ id: "f1", name: "ep.vtt", coreMediaUrl: FILM }],
} as unknown as ProjectRecord

const cell = {
  id: "c1", fileId: "f1", original: "hello", translated: "bonjour",
  medium: "media", startTime: 4, endTime: 9,
} as unknown as CellData

const modal = (project: ProjectRecord) => (
  <AudioRecordingModal
    open
    project={project}
    cells={[cell]}
    activeCellId="c1"
    username="sam"
    onActiveCellChange={() => {}}
    onClose={() => {}}
  />
)

describe("AudioRecordingModal — the film", () => {
  beforeEach(() => {
    onlineState.value = true
    recorderState.value = { kind: "idle" }
    attachmentsState.byCellId = new Map()
    localStorage.clear()
    resetRecordingFilmAudibleCacheForTests()
  })

  it.each([
    ["the project has no files array at all (the other suites' fixture)", projectNoFilesKey],
    ["the project has files but none is this cell's", projectEmptyFiles],
  ])("renders NO picture when %s", (_case, project) => {
    render(modal(project))
    // The modal itself is up — otherwise this would pass for the wrong reason.
    expect(screen.getByTestId("rec-start")).toBeInTheDocument()
    expect(screen.queryByTestId("rec-video")).not.toBeInTheDocument()
  })

  it("the picture is MUTED by default, and the toggle flips it", () => {
    render(modal(projectWithFilm))
    // The property, not the attribute — happy-dom falls back to the attribute,
    // so an attribute check would pass even if React never set it, which is
    // exactly the bug that lets a film into a take.
    expect((screen.getByTestId("rec-video") as HTMLVideoElement).muted).toBe(true)
    fireEvent.click(screen.getByTestId("rec-film-audible"))
    expect((screen.getByTestId("rec-video") as HTMLVideoElement).muted).toBe(false)
  })

  it("the picture runs ONLY while the take is capturing", async () => {
    const play = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
    const pause = vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {})
    try {
      const { rerender } = render(modal(projectWithFilm))
      expect(play).not.toHaveBeenCalled()

      recorderState.value = { kind: "recording", startedAt: Date.now() }
      rerender(modal(projectWithFilm))
      await waitFor(() => expect(play).toHaveBeenCalled())

      play.mockClear()
      pause.mockClear()
      recorderState.value = {
        kind: "stopped",
        blob: new Blob(["x"], { type: "audio/webm" }),
        mimeType: "audio/webm", ext: "webm", durationSec: 2,
      }
      rerender(modal(projectWithFilm))
      await waitFor(() => expect(pause).toHaveBeenCalled())
      // And the preview does NOT run the picture: unmuted it would talk over
      // the take, muted it would drift the moment the audio is scrubbed.
      expect(play).not.toHaveBeenCalled()
    } finally {
      play.mockRestore()
      pause.mockRestore()
    }
  })
})
