// AQU-906 — the recording modal's scene monitor. Regression guard for the
// two rules that make a video safe next to a live mic: it is FORCE-muted for
// the duration of the take, and it is parked on the cell's own time window.
//
// happy-dom has no media pipeline (no real playback, `play()` is absent), so
// what is asserted here is the wiring — element present, `muted` reflected,
// seek target, mute affordance locked while armed. Actual synchronised
// playback is E2E/manual territory, same caveat as the offline suite.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "sam" }, loading: false }),
}))
const recorderState = vi.hoisted(() => ({
  value: { kind: "idle" } as Record<string, unknown>,
}))
vi.mock("@/hooks/useAudioRecorder", () => ({
  useAudioRecorder: () => ({
    state: recorderState.value,
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    prewarm: vi.fn(),
  }),
}))
vi.mock("@/hooks/useFileAudioAttachments", () => ({
  useFileAudioAttachments: () => ({ byCellId: new Map(), isLoading: false, revalidate: vi.fn() }),
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
vi.mock("@/lib/audio/upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCellAudio: vi.fn(async () => new ArrayBuffer(8)),
  uploadCellAudio: vi.fn(async () => ({ audioId: "a1", ext: "webm", url: "frontier-audio://a1.webm" })),
  deleteCellAudio: vi.fn(async () => {}),
}))
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("@/lib/audio/transcribe-status", () => ({ setTranscribeStatus: vi.fn() }))
vi.mock("@/lib/audio/transcribe", () => ({ transcribeCell: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/audio-coordinator", () => ({ pushAudioShortcutOverride: () => () => {} }))

import { AudioRecordingModal } from "./AudioRecordingModal"

const project = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord

// A dubbing cell whose window sits well into the reel — 12s–17s — so a seek
// to the window start is distinguishable from "never seeked" (0).
const cell = {
  id: "c1", fileId: "f1", original: "hello", translated: "bonjour",
  medium: "media", startTime: 12, endTime: 17,
} as unknown as CellData

function renderModal(videoUrl: string | null) {
  return render(
    <AudioRecordingModal
      open
      project={project}
      cells={[cell]}
      activeCellId="c1"
      username="sam"
      videoUrl={videoUrl}
      onActiveCellChange={() => {}}
      onClose={() => {}}
    />,
  )
}

beforeEach(() => {
  recorderState.value = { kind: "idle" }
})

describe("AudioRecordingModal — scene video (AQU-906)", () => {
  it("shows the linked video, parked on the cell's window start", () => {
    renderModal("https://cdn.test/ep1.mp4")
    const video = screen.getByTestId("rec-video") as HTMLVideoElement
    expect(video.getAttribute("src")).toBe("https://cdn.test/ep1.mp4")
    // Positioned for THIS cell's time range, not the head of the reel.
    expect(video.currentTime).toBe(12)
  })

  it("renders no video stage when the file has no linked video", () => {
    renderModal(null)
    expect(screen.queryByTestId("rec-video-stage")).toBeNull()
  })

  it("force-mutes the video while recording, with a visible muted state", () => {
    recorderState.value = { kind: "recording" }
    renderModal("https://cdn.test/ep1.mp4")
    const video = screen.getByTestId("rec-video") as HTMLVideoElement
    expect(video.muted).toBe(true)
    // Visible, not merely a DOM property — the badge and the pressed toggle.
    expect(screen.getByTestId("rec-video-muted-badge")).toBeTruthy()
    expect(screen.getByTestId("rec-video-mute").getAttribute("aria-pressed")).toBe("true")
  })

  it("does not let the mute be given away mid-take", () => {
    recorderState.value = { kind: "recording" }
    renderModal("https://cdn.test/ep1.mp4")
    const toggle = screen.getByTestId("rec-video-mute") as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    fireEvent.click(toggle)
    expect((screen.getByTestId("rec-video") as HTMLVideoElement).muted).toBe(true)
  })

  it("lets the scene be heard between takes, and muted again on request", () => {
    renderModal("https://cdn.test/ep1.mp4")
    const video = screen.getByTestId("rec-video") as HTMLVideoElement
    // Idle: audible, so the actor can review the scene before rolling.
    expect(video.muted).toBe(false)
    expect(screen.queryByTestId("rec-video-muted-badge")).toBeNull()

    fireEvent.click(screen.getByTestId("rec-video-mute"))
    expect((screen.getByTestId("rec-video") as HTMLVideoElement).muted).toBe(true)
  })

  it("keeps the takes strip and transport alongside the video (no regression)", () => {
    renderModal("https://cdn.test/ep1.mp4")
    // The idle transport is still reachable with the monitor on screen.
    expect(screen.getByTestId("rec-video-stage")).toBeTruthy()
    expect(screen.getByRole("dialog")).toBeTruthy()
  })
})
