// Decision 2026-08-05: recording is blocked UP FRONT while offline — the
// feature knows the app is offline and says so, instead of failing mid-flow.
// Capture is local, so a take caught by a mid-flow flap stays previewable and
// saves after reconnect.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expectClickNote, expectDisabledNote, renderWithTooltips } from "@/test-utils/tooltip"
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
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
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
// (AudioRecordingModal.ready.test.tsx); here it is inert.
vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "idle", error: null, isPlaying: false, currentTime: 0, duration: 0,
    peaks: null, peaksState: "idle",
    play: async () => {}, pause: () => {}, seek: () => {}, setVolume: () => {},
    setTrim: () => {}, requestPeaks: async () => {}, ensureBytes: async () => new Uint8Array(),
  }),
}))

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

  it("offline: Space shows the offline message and never starts the record flow", () => {
    onlineState.value = false
    renderModal()
    // Opening the modal performs ONE passive permission-status read (it warms
    // the mic session when access is already granted — round 4). That is not
    // the record flow; clear it so the assertions below pin the flow alone.
    probeMic.mockClear()
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

  it("a save that fails MID-UPLOAD bounces back to the preview with the take intact (2026-08-06)", async () => {
    onlineState.value = true
    recorderState.value = {
      kind: "stopped",
      blob: new Blob(["x"], { type: "audio/webm" }),
      mimeType: "audio/webm", ext: "webm", durationSec: 2,
    }
    uploadSpy.mockRejectedValueOnce(new Error("HTTP 500"))
    renderModal()
    fireEvent.keyDown(window, { key: "Enter" })
    // The failure lands back in PREVIEW — not the dead-end error phase whose
    // footer has no Save or Retake. The reason shows inline.
    expect(await screen.findByTestId("rec-save-error")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Retake/ })).toBeInTheDocument()
    expect(screen.getByTestId("rec-save")).toBeEnabled()
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    // And the retry saves the SAME take — nothing was lost.
    fireEvent.keyDown(window, { key: "Enter" })
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(2))
  })

  it("back online: Space reaches the mic probe again", () => {
    onlineState.value = true
    renderModal()
    // Discard the open-time permission read (see the offline Space test).
    probeMic.mockClear()
    fireEvent.keyDown(window, { key: " " })
    expect(probeMic).toHaveBeenCalledTimes(1)
  })

  it("keys originating in a STACKED dialog never reach the recorder (2026-08-06)", async () => {
    // The timing-mode heads-up can open ON TOP of the recorder (a cell
    // transition surfaces it). Escape there must dismiss only the heads-up —
    // not also close the recorder — and Space must not start a recording.
    // Uses the REAL dialog so Base UI's own popup stack participates.
    const { TimingModeChangedDialog } = await import("@/components/timeline/TimingModeChangedDialog")
    const onClose = vi.fn()
    const onAcknowledge = vi.fn()
    render(
      <>
        <AudioRecordingModal
          open
          project={project}
          cells={[cell]}
          activeCellId="c1"
          username="sam"
          onActiveCellChange={() => {}}
          onClose={onClose}
        />
        <TimingModeChangedDialog ack={{ from: "dubbing", to: "audioFirst" }} onAcknowledge={onAcknowledge} />
      </>,
    )
    const okButton = screen.getByTestId("timing-ack-ok")
    // Discard the open-time permission read (see the offline Space test).
    probeMic.mockClear()
    fireEvent.keyDown(okButton, { key: " " })
    expect(probeMic).not.toHaveBeenCalled()
    fireEvent.keyDown(okButton, { key: "Escape" })
    expect(onClose).not.toHaveBeenCalled()
  })
})

// AQU-2260 (Sam, Oct 29): a hover may only NAME an icon-only button. Record,
// Save, Upload, Generate and the format switch carry their own words, so they
// have no hover; why one is greyed out opens on a click.
describe("AudioRecordingModal — reasons open on click, text buttons have no hover", () => {
  beforeEach(() => {
    onlineState.value = true
    recorderState.value = { kind: "idle" }
    attachmentsState.byCellId = new Map()
    localStorage.clear()
  })

  const modal = () => (
    <AudioRecordingModal
      open project={project} cells={[cell]} activeCellId="c1" username="sam"
      onActiveCellChange={() => {}} onClose={() => {}}
    />
  )

  async function expectNoHover(el: Element) {
    await userEvent.setup().hover(el)
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(screen.queryByRole("tooltip")).toBeNull()
  }

  it("offline: Record, Generate and Upload say they are offline on a click", async () => {
    onlineState.value = false
    renderWithTooltips(modal())
    await expectDisabledNote(screen.getByTestId("rec-start"), OFFLINE_RE)
    await expectDisabledNote(screen.getByTestId("rec-generate-tts"), OFFLINE_RE)
    await expectDisabledNote(screen.getByTestId("rec-upload"), OFFLINE_RE)
  })

  it("offline in preview: Save says it is offline on a click", async () => {
    onlineState.value = false
    recorderState.value = {
      kind: "stopped", blob: new Blob(["x"], { type: "audio/webm" }),
      mimeType: "audio/webm", ext: "webm", durationSec: 2,
    }
    renderWithTooltips(modal())
    await expectDisabledNote(screen.getByTestId("rec-save"), OFFLINE_RE)
  })

  it("online: Record, Generate, Upload and the format switch show nothing on hover", async () => {
    renderWithTooltips(modal())
    await expectNoHover(screen.getByTestId("rec-start"))
    await expectNoHover(screen.getByTestId("rec-generate-tts"))
    await expectNoHover(screen.getByTestId("rec-upload"))
    await expectNoHover(screen.getByTestId("rec-format"))
  })

  it("online in preview: Save shows nothing on hover", async () => {
    recorderState.value = {
      kind: "stopped", blob: new Blob(["x"], { type: "audio/webm" }),
      mimeType: "audio/webm", ext: "webm", durationSec: 2,
    }
    renderWithTooltips(modal())
    await expectNoHover(screen.getByTestId("rec-save"))
  })

  it("says what the recording format costs behind its (i)", async () => {
    renderWithTooltips(modal())
    await expectClickNote(
      screen.getByRole("button", { name: "About Format" }),
      /three times the file size|much smaller files/,
    )
  })

  it("a very short window says so on a click on the counter, not a hover", async () => {
    renderWithTooltips(
      <AudioRecordingModal
        open project={project} cells={[{ ...cell, endTime: 0.3 } as CellData]} activeCellId="c1" username="sam"
        onActiveCellChange={() => {}} onClose={() => {}}
      />,
    )
    const counter = screen.getByTestId("recorder-window")
    expect(counter).toHaveTextContent("very short")
    expect(counter).not.toHaveAttribute("title")
    await expectClickNote(counter, "barely room")
  })

  it("with a take in hand, the locked format says why on a click", async () => {
    recorderState.value = {
      kind: "stopped", blob: new Blob(["x"], { type: "audio/webm" }),
      mimeType: "audio/webm", ext: "webm", durationSec: 2,
    }
    renderWithTooltips(modal())
    await expectDisabledNote(screen.getByTestId("rec-format"), "already captured")
    expect(screen.queryByRole("button", { name: "About Format" })).toBeNull()
  })
})
