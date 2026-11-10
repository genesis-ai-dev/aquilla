// AQU-2491 (review, Nov 9): the recorder's preview plays the film from where
// Save will put the take. A take with no pre-roll (a compressed take, or a WAV
// whose capture was not armed in time) is saved on its line's start, its own
// place; the preview still ran the film from the LINE's place, which on a line
// recorded before AQU-2491 is the old pre-roll (-200 ms), so the picture the
// person checked the take against was 0.2 s off where it lands.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
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
  emitCellAudioPlace: vi.fn(async () => "evt"),
  emitCellAudioAttach: vi.fn(async () => "evt"),
  emitCellAudioSelect: vi.fn(async () => "evt"),
  emitCellAudioValidate: vi.fn(async () => "evt"),
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
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCacheGet: vi.fn(async () => null), audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("@/lib/audio/transcribe-status", () => ({ setTranscribeStatus: vi.fn() }))
vi.mock("@/lib/audio/transcribe", () => ({ transcribeCell: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/audio-coordinator", () => ({
  pushAudioShortcutOverride: () => () => {},
  setActiveAudio: () => {},
  clearActiveAudioIf: () => {},
  claimActiveAudio: () => {},
  getActiveAudio: () => null,
}))
// AQU-1217: the ready screen's selected-take waveform has its own suite
// (AudioRecordingModal.ready.test.tsx); here it only reports where it is, for
// the film play-along tests.
const readyPlayer = vi.hoisted(() => ({ isPlaying: false, currentTime: 0 }))
vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "idle", error: null, isPlaying: readyPlayer.isPlaying, currentTime: readyPlayer.currentTime, duration: 0,
    peaks: null, peaksState: "idle",
    play: async () => {}, pause: () => {}, seek: () => {}, setVolume: () => {},
    setTrim: () => {}, requestPeaks: async () => {}, ensureBytes: async () => new Uint8Array(),
  }),
}))

// The preview's own player, where it is in the take.
const previewPlayer = vi.hoisted(() => ({ isPlaying: false, currentTime: 0 }))
vi.mock("./usePreviewTake", () => ({
  usePreviewTake: () => ({
    state: "ready", error: null, isPlaying: previewPlayer.isPlaying, currentTime: previewPlayer.currentTime, duration: 3.6,
    peaks: new Float32Array([0.2, 0.9]), peaksState: "ready",
    play: async () => {}, pause: () => {}, seek: () => {}, setVolume: () => {},
    setTrim: () => {}, requestPeaks: async () => {}, ensureBytes: async () => new Uint8Array(),
  }),
}))

import { AudioRecordingModal } from "./AudioRecordingModal"
import { resetRecordingFilmAudibleCacheForTests } from "@/lib/store/recording-film-audible-pref"

const FILM = "https://cdn.example.com/ep.mp4"
const projectWithFilm = {
  id: "p1", name: "P", ttsSettings: {},
  files: [{ id: "f1", name: "ep.vtt", coreMediaUrl: FILM }],
} as unknown as ProjectRecord

/** A line recorded before AQU-2491: the recorder's pre-roll is still its place. */
const oldLine = {
  id: "c1", fileId: "f1", original: "hello", translated: "bonjour",
  medium: "media", startTime: 4, endTime: 9, metadata: { target_offset_ms: -200 },
} as unknown as CellData

const modal = () => (
  <AudioRecordingModal open project={projectWithFilm} cells={[oldLine]} activeCellId="c1" username="sam" onActiveCellChange={() => {}} onClose={() => {}} />
)

describe("AudioRecordingModal — the preview's film runs from where Save puts the take", () => {
  let ready: ReturnType<typeof vi.spyOn>
  let play: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    onlineState.value = true
    attachmentsState.byCellId = new Map()
    localStorage.clear()
    resetRecordingFilmAudibleCacheForTests()
    previewPlayer.isPlaying = true
    previewPlayer.currentTime = 1.5
    ready = vi.spyOn(window.HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4)
    play = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
  })
  afterEach(() => {
    ready.mockRestore()
    play.mockRestore()
  })

  it("a take with no pre-roll: the film runs from the line's start, where Save places it", () => {
    recorderState.value = {
      kind: "stopped", blob: new Blob(["x"], { type: "audio/webm" }), mimeType: "audio/webm", ext: "webm", durationSec: 3.6,
    }
    render(modal())
    // Saved at its own place 0: 1.5 s into the take is 5.5 s into the film,
    // not 5.3 s (the line's old -200 ms).
    expect((screen.getByTestId("rec-video") as HTMLVideoElement).currentTime).toBeCloseTo(5.5, 2)
  })

  it("a take with a pre-roll: the film runs from its pre-roll before the line, as before", () => {
    recorderState.value = {
      kind: "stopped", blob: new Blob(["x"], { type: "audio/wav" }), mimeType: "audio/wav", ext: "wav",
      durationSec: 3.6, preRollMs: 200, tailGraceMs: 250,
    }
    render(modal())
    expect((screen.getByTestId("rec-video") as HTMLVideoElement).currentTime).toBeCloseTo(5.3, 2)
  })
})
