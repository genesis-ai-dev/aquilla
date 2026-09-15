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
// audible film records straight into the take. Muted by default, and still in
// the two states where a moving picture would be wrong — before anything has
// been asked for, and while a finished take is under review.

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
  emitCellLaneRetime: vi.fn(async () => "evt"),
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
import { resetRecordingCountdownCacheForTests } from "@/lib/store/recording-countdown-pref"
import { resetCountdownBeepContextForTests } from "./useCountdown"

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
    resetRecordingCountdownCacheForTests()
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

  // ONE canvas from the countdown into the take. The waveform owns an
  // AudioContext attached to the live microphone, and a remount at zero closes
  // and reopens that context at the exact moment nothing may touch the audio
  // device — the input restart that replaced the first ~1.4s of a take with
  // near-silence and a fade-in (2026-08-14). Mounted during the countdown, any
  // renegotiation lands in discarded pre-mark audio instead of the take.
  it("keeps ONE waveform canvas from the countdown into the take", async () => {
    // The dialog renders through a portal, so the canvas lives under
    // document.body, not the render container.
    const { rerender } = render(modal(projectNoFilesKey))
    expect(document.querySelector("canvas")).toBeNull()

    fireEvent.click(screen.getByTestId("rec-start"))
    // The permission probe resolves async; the countdown UI mounts the meter.
    await waitFor(() => expect(document.querySelector("canvas")).not.toBeNull())
    const duringCountdown = document.querySelector("canvas")
    // Hot mic, no take yet: the trace is grey.
    expect(duringCountdown).toHaveAttribute("data-tone", "armed")

    recorderState.value = { kind: "recording", startedAt: Date.now() }
    rerender(modal(projectNoFilesKey))
    await waitFor(() => expect(screen.getByText("REC")).toBeInTheDocument())
    // The SAME element, not an equal one — recoloured, never remounted.
    expect(document.querySelector("canvas")).toBe(duringCountdown)
    expect(duringCountdown).toHaveAttribute("data-tone", "live")
  })

  // NOT "only while capturing" any more (2026-08-14): the picture also rolls
  // through the countdown as a lead-in, arriving at the line's first frame at
  // zero. What stays true — and is what this pins — is the two states where it
  // must be still: nothing has been asked for yet, and a finished take is being
  // reviewed. (The lead-in itself is pinned in RecordingVideoSurface.test.tsx,
  // where the element's readiness can be controlled.)
  it("the picture is still in idle, runs while capturing, and stops for the preview", async () => {
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

// AQU-1209 — the countdown is a preference now.
//
// It lives in this suite rather than a new one because the two things the
// preference changes are exactly what this file already pins: the counting
// phase between the click and the take, and the film's rolling lead-in, which
// is timed from the count and therefore has to disappear with it.
//
// The pref is DEVICE-scoped and defaults to ON, so every assertion about the
// default here doubles as the regression guard on the counted path.
describe("AudioRecordingModal — the countdown preference", () => {
  /** Stands in for the AudioContext `beepOnce` builds per tick. happy-dom has
   *  none, so without it the real code's try/catch swallows every beep and a
   *  "no beep" assertion would pass for the wrong reason. */
  function installAudioContextSpy(): { oscillators: number } {
    const record = { oscillators: 0 }
    class FakeOsc {
      frequency = { value: 0 }
      type = ""
      onended: (() => void) | null = null
      connect() {}
      start() {}
      stop() {}
    }
    class FakeCtx {
      currentTime = 0
      state = "running"
      destination = {}
      createOscillator() { record.oscillators += 1; return new FakeOsc() }
      createGain() {
        return {
          gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {},
        }
      }
      close() { return Promise.resolve() }
    }
    ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeCtx
    return record
  }

  beforeEach(() => {
    onlineState.value = true
    recorderState.value = { kind: "idle" }
    attachmentsState.byCellId = new Map()
    localStorage.clear()
    resetRecordingFilmAudibleCacheForTests()
    resetRecordingCountdownCacheForTests()
    recorderStart.mockClear()
    // The beep context is a module singleton by design; drop it so this test's
    // fake is the one the countdown would reach for.
    resetCountdownBeepContextForTests()
  })

  it("counts by default: 3 on screen, a way to cancel it, and no take yet", async () => {
    render(modal(projectNoFilesKey))
    fireEvent.click(screen.getByTestId("rec-start"))

    await waitFor(() => expect(screen.getByText("3")).toBeInTheDocument())
    // Counting, not recording — the recorder is armed but has not been marked.
    expect(recorderStart).not.toHaveBeenCalled()
    // The anchor button is the count's Cancel for as long as the count runs.
    expect(screen.queryByTestId("rec-start")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument()
  })

  // The whole point of the preference: the click IS zero.
  it("with the countdown off, Record starts the take at once and never counts", async () => {
    const audio = installAudioContextSpy()
    localStorage.setItem("aq.recording-countdown.v1", "off")
    resetRecordingCountdownCacheForTests()

    const { rerender } = render(modal(projectNoFilesKey))
    fireEvent.click(screen.getByTestId("rec-start"))

    // The permission probe resolves async; the take begins on the other side.
    await waitFor(() => expect(recorderStart).toHaveBeenCalledTimes(1))
    // No counting phase ever existed: no digits, and the Record button is still
    // the anchor rather than being replaced by "Cancel".
    expect(screen.queryByText("3")).not.toBeInTheDocument()
    expect(screen.getByTestId("rec-start")).toBeInTheDocument()
    // …and nothing beeped, even though the beep toggle is still ON: there is no
    // countdown left to sound.
    expect(audio.oscillators).toBe(0)

    // Zero's visual beat goes with it — GO announces an instant nothing led up
    // to once the operator's own click is the cue.
    recorderState.value = { kind: "recording", startedAt: Date.now() }
    rerender(modal(projectNoFilesKey))
    await waitFor(() => expect(screen.getByText("REC")).toBeInTheDocument())
    expect(screen.queryByText("GO")).not.toBeInTheDocument()
  })

  // The lead-in is timed FROM the count, so with no count there is no lead-in:
  // the picture is already parked on the line's first frame from the arm at
  // open, and `running` inherits it. What must not happen is a rewind or a
  // second play() under the operator's first word.
  it("with the countdown off, the film is not re-armed for a lead-in", async () => {
    const play = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
    try {
      localStorage.setItem("aq.recording-countdown.v1", "off")
      resetRecordingCountdownCacheForTests()

      render(modal(projectWithFilm))
      fireEvent.click(screen.getByTestId("rec-start"))
      await waitFor(() => expect(recorderStart).toHaveBeenCalledTimes(1))

      // Still idle as far as the surface is concerned — the recorder mock has
      // not flipped — so nothing has asked the picture to move.
      expect(play).not.toHaveBeenCalled()
    } finally {
      play.mockRestore()
    }
  })

  it("greys the beep control out while the countdown is off, and gives it back", () => {
    render(modal(projectNoFilesKey))
    fireEvent.click(screen.getByTestId("rec-settings"))

    const beep = screen.getByTestId("rec-beep") as HTMLButtonElement
    // Default: the countdown runs, so the beep is a live choice.
    expect(beep).not.toBeDisabled()
    expect(beep).toHaveAttribute("aria-pressed", "true")

    fireEvent.click(screen.getByTestId("rec-countdown"))
    expect(screen.getByTestId("rec-beep")).toBeDisabled()
    // Not applicable, not changed — the stored answer survives.
    expect(screen.getByTestId("rec-beep")).toHaveAttribute("aria-pressed", "true")

    fireEvent.click(screen.getByTestId("rec-countdown"))
    expect(screen.getByTestId("rec-beep")).not.toBeDisabled()
    expect(screen.getByTestId("rec-beep")).toHaveAttribute("aria-pressed", "true")
  })

  it("persists the opt-out per device", () => {
    const { unmount } = render(modal(projectNoFilesKey))
    fireEvent.click(screen.getByTestId("rec-settings"))
    fireEvent.click(screen.getByTestId("rec-countdown"))
    expect(localStorage.getItem("aq.recording-countdown.v1")).toBe("off")
    unmount()

    // A fresh session on the same device reads the stored opt-out back.
    resetRecordingCountdownCacheForTests()
    render(modal(projectNoFilesKey))
    fireEvent.click(screen.getByTestId("rec-settings"))
    expect(screen.getByTestId("rec-countdown")).toHaveAttribute("aria-pressed", "false")
  })
})
