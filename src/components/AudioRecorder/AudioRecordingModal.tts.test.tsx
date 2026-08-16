// Round 8: the recording modal's Generate-TTS button — the clear
// "regenerate" counterpart to re-recording, right where recording lives.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
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
const attachmentsState = vi.hoisted(() => ({ byCellId: new Map<string, unknown>() }))
vi.mock("@/hooks/useFileAudioAttachments", () => ({
  useFileAudioAttachments: () => ({ byCellId: attachmentsState.byCellId, isLoading: false, revalidate: vi.fn() }),
  mergeCellsWithAudio: (cells: unknown[]) => cells,
}))
const generateCellVoice = vi.fn(async (..._args: unknown[]) => true)
vi.mock("@/lib/audio/voice-generate-helpers", () => ({
  generateCellVoice: (...args: unknown[]) => generateCellVoice(...args),
}))
const probeSpy = vi.hoisted(() => vi.fn(async () => 1000))
vi.mock("@/lib/import", () => ({
  probeDurationMsSafe: (...args: unknown[]) => probeSpy(...(args as [])),
}))
const injectOptimistic = vi.hoisted(() => vi.fn((..._args: unknown[]) => {}))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  notifyAudioAttachmentsChanged: vi.fn(),
  injectOptimisticAudioAttachment: (...args: unknown[]) => injectOptimistic(...args),
  injectOptimisticAudioRemove: vi.fn(),
}))
const emitAttach = vi.fn(async (..._args: unknown[]) => "evt-attach")
const emitSelect = vi.fn(async (..._args: unknown[]) => "evt-select")
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: (...args: unknown[]) => emitAttach(...args),
  emitCellAudioSelect: (...args: unknown[]) => emitSelect(...args),
  emitCellAudioRemove: vi.fn(async () => "evt"),
  emitCellAudioRename: vi.fn(async () => "evt"),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "sync-tok",
}))
vi.mock("@/lib/audio/upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCellAudio: vi.fn(async () => new ArrayBuffer(8)),
  uploadCellAudio: vi.fn(async () => ({
    audioId: "audio-c1-999-new",
    ext: "webm",
    url: "frontier-audio://audio-c1-999-new.webm",
  })),
  deleteCellAudio: vi.fn(async () => {}),
}))
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("@/lib/audio/transcribe-status", () => ({ setTranscribeStatus: vi.fn() }))
const transcribeCell = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}))
vi.mock("@/lib/audio/transcribe", () => ({
  transcribeCell: (...args: unknown[]) => transcribeCell(...args),
}))
vi.mock("@/lib/audio/audio-coordinator", () => ({ pushAudioShortcutOverride: () => () => {} }))

import { AudioRecordingModal } from "./AudioRecordingModal"
import { resetRecordingAutoAdvanceCacheForTests } from "@/lib/store/recording-auto-advance-pref"

const onActiveCellChange = vi.fn((..._args: unknown[]) => {})

const project = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord

const cellWith = (translated: string): CellData =>
  ({
    id: "c1", fileId: "f1", original: "hello", translated,
    medium: "media", startTime: 0, endTime: 5,
  }) as unknown as CellData

function renderModal(cell: CellData) {
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

const att = (audioId: string, over: Record<string, unknown> = {}) => ({
  audioId, url: `frontier-audio://${audioId}`, slot: "recording", mimeType: "audio/mpeg",
  voiceId: null, referenceAudioId: null, durationMs: 4000,
  trimStartMs: null, trimEndMs: null, label: "Take 1", ...over,
})

function seedEntry(attachments: Record<string, unknown>, selectedAudioId: string | null, selectedGeneratedVoiceAudioId: string | null = null) {
  attachmentsState.byCellId = new Map([
    ["c1", { attachments, selectedAudioId, selectedGeneratedVoiceAudioId, audioTimings: {} }],
  ])
}

describe("AudioRecordingModal — takes strip contents", () => {
  beforeEach(() => {
    attachmentsState.byCellId = new Map()
  })

  it("the imported SOURCE clip (fileId-seeded) never appears as a take", () => {
    seedEntry({
      "audio-f1-100-clip.mp3": att("audio-f1-100-clip.mp3", { label: null }),
      "audio-c1-200-take.webm": att("audio-c1-200-take.webm"),
    }, "audio-c1-200-take.webm")
    renderModal(cellWith("bonjour"))
    expect(screen.getByTestId("take-row-audio-c1-200-take.webm")).toBeInTheDocument()
    expect(screen.queryByTestId("take-row-audio-f1-100-clip.mp3")).toBeNull()
    expect(screen.getByText("Takes (1)")).toBeInTheDocument()
  })

  it("generated TTS attachments appear as takes alongside recordings (round 8c)", () => {
    seedEntry({
      "audio-c1-200-take.webm": att("audio-c1-200-take.webm"),
      "audio-c1-300-tts.wav": att("audio-c1-300-tts.wav", { slot: "generatedVoice", voiceId: "v1", label: "Take 2" }),
    }, "audio-c1-200-take.webm")
    renderModal(cellWith("bonjour"))
    expect(screen.getByTestId("take-row-audio-c1-200-take.webm")).toBeInTheDocument()
    expect(screen.getByTestId("take-row-audio-c1-300-tts.wav")).toBeInTheDocument()
    expect(screen.getByText("Takes (2)")).toBeInTheDocument()
  })
})

describe("AudioRecordingModal — durationless-take heal (round 8c)", () => {
  beforeEach(() => {
    attachmentsState.byCellId = new Map()
    emitAttach.mockClear()
  })

  it("re-attaches the SELECTED webm take with its decoded duration, keeping name and trims", async () => {
    seedEntry({
      "audio-c1-200-take.webm": att("audio-c1-200-take.webm", {
        mimeType: "audio/webm", durationMs: null, label: "Take 1", trimStartMs: 100, trimEndMs: 900,
      }),
    }, "audio-c1-200-take.webm")
    renderModal(cellWith("bonjour"))
    await waitFor(() => expect(emitAttach).toHaveBeenCalledTimes(1))
    expect(emitAttach).toHaveBeenCalledWith(expect.objectContaining({
      audioId: "audio-c1-200-take.webm",
      slot: "recording",
      durationMs: 1000, // the mocked probe's decode result
      label: "Take 1",
      trimStartMs: 100,
      trimEndMs: 900,
    }))
  })

  it("does nothing when the selected take already has a duration", async () => {
    seedEntry({ "audio-c1-200-take.webm": att("audio-c1-200-take.webm") }, "audio-c1-200-take.webm")
    renderModal(cellWith("bonjour"))
    await new Promise((r) => setTimeout(r, 50))
    expect(emitAttach).not.toHaveBeenCalled()
  })
})

describe("AudioRecordingModal — TTS becomes the sounding take (round 8c)", () => {
  beforeEach(() => {
    attachmentsState.byCellId = new Map()
    generateCellVoice.mockClear()
    emitSelect.mockClear()
  })

  it("names the TTS take at birth and hands the recording slot to the source clip", async () => {
    seedEntry({
      "audio-f1-100-clip.mp3": att("audio-f1-100-clip.mp3", { label: null }),
      "audio-c1-200-take.webm": att("audio-c1-200-take.webm"),
    }, "audio-c1-200-take.webm") // a recorded take holds the slot
    renderModal(cellWith("bonjour"))
    fireEvent.click(screen.getByTestId("rec-generate-tts"))
    await waitFor(() => expect(generateCellVoice).toHaveBeenCalledTimes(1))
    const [args] = generateCellVoice.mock.calls[0] as unknown as [{ label?: string }]
    expect(args.label).toBe("Take 2")
    await waitFor(() => expect(emitSelect).toHaveBeenCalledTimes(1))
    expect(emitSelect).toHaveBeenCalledWith(expect.objectContaining({
      audioId: "audio-f1-100-clip.mp3", slot: "recording",
    }))
  })

  it("no displacement when the source clip already holds the slot", async () => {
    seedEntry({
      "audio-f1-100-clip.mp3": att("audio-f1-100-clip.mp3", { label: null }),
    }, "audio-f1-100-clip.mp3")
    renderModal(cellWith("bonjour"))
    fireEvent.click(screen.getByTestId("rec-generate-tts"))
    await waitFor(() => expect(generateCellVoice).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(emitSelect).not.toHaveBeenCalled()
  })
})

describe("AudioRecordingModal — Generate TTS (round 8)", () => {
  beforeEach(() => generateCellVoice.mockClear())

  it("renders beside Start and is disabled without a translation", () => {
    renderModal(cellWith(""))
    const btn = screen.getByTestId("rec-generate-tts")
    expect(btn).toBeDisabled()
    expect(screen.getByRole("button", { name: /Start/ })).toBeInTheDocument()
  })

  it("generates durably with the modal's project/cell/session/username", async () => {
    renderModal(cellWith("bonjour"))
    const btn = screen.getByTestId("rec-generate-tts")
    expect(btn).toBeEnabled()
    fireEvent.click(btn)
    await waitFor(() => expect(generateCellVoice).toHaveBeenCalledTimes(1))
    const [args] = generateCellVoice.mock.calls[0] as unknown as [{ project: ProjectRecord; cell: CellData; username: string }]
    expect(args.project.id).toBe("p1")
    expect(args.cell.id).toBe("c1")
    expect(args.username).toBe("sam")
  })
})

describe("AudioRecordingModal — take length comes from the recorder (SUB-48)", () => {
  beforeEach(() => {
    attachmentsState.byCellId = new Map()
    emitAttach.mockClear()
    injectOptimistic.mockClear()
    probeSpy.mockClear()
    recorderState.value = { kind: "idle" }
  })
  afterEach(() => {
    recorderState.value = { kind: "idle" }
  })

  it("saves with the recorder's measured length and never probes the blob", async () => {
    // Chrome's MediaRecorder writes NO duration header, so probing a mic take
    // raced a timeout and long recordings attached with no length at all —
    // which is why their chips were stuck at section width. The recorder has
    // timed the take all along; use that.
    recorderState.value = {
      kind: "stopped",
      blob: new Blob(["x"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      ext: "webm",
      durationSec: 12.34,
    }
    renderModal(cellWith("bonjour"))
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))

    await waitFor(() => expect(emitAttach).toHaveBeenCalledTimes(1))
    expect(emitAttach).toHaveBeenCalledWith(
      expect.objectContaining({ slot: "recording", durationMs: 12_340 }),
    )
    // A long take must not depend on decoding succeeding inside a timeout.
    expect(probeSpy).not.toHaveBeenCalled()
  })

  it("the optimistic overlay carries that same length, bound to the attach event", async () => {
    recorderState.value = {
      kind: "stopped",
      blob: new Blob(["x"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      ext: "webm",
      durationSec: 6,
    }
    renderModal(cellWith("bonjour"))
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() => expect(injectOptimistic).toHaveBeenCalled())
    const call = injectOptimistic.mock.calls.at(-1) as unknown as [string, string, { durationMs: number }, string]
    expect(call[2].durationMs).toBe(6000)
    expect(call[3]).toBe("evt-attach") // the id emitCellAudioAttach resolved with
  })
})

describe("AudioRecordingModal — transcription gets the REAL attachment (SUB-49)", () => {
  beforeEach(() => {
    attachmentsState.byCellId = new Map()
    transcribeCell.mockClear()
    recorderState.value = { kind: "idle" }
  })
  afterEach(() => { recorderState.value = { kind: "idle" } })

  it("hands transcription the take's duration, so its re-attach can't wipe it", async () => {
    // Transcription finishes a minute later and re-attaches. It forwards
    // whatever it finds on the attachment it was given; a stub of {url, type}
    // meant the re-attach carried no duration, and the projection read that
    // as "erase" — the take's chip lost its length long after saving.
    recorderState.value = {
      kind: "stopped",
      blob: new Blob(["x"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      ext: "webm",
      durationSec: 9.5,
    }
    renderModal(cellWith("bonjour"))
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))

    await waitFor(() => expect(transcribeCell).toHaveBeenCalledTimes(1))
    const [args] = transcribeCell.mock.calls[0] as unknown as [
      { cell: { selectedAudioId: string; attachments: Record<string, { durationMs?: number }> } },
    ]
    const att = args.cell.attachments[args.cell.selectedAudioId]
    expect(att).toBeDefined()
    expect(att.durationMs).toBe(9500)
  })
})

describe("AudioRecordingModal — auto-advance toggle (SUB-50)", () => {
  const stopped = {
    kind: "stopped",
    blob: new Blob(["x"], { type: "audio/webm" }),
    mimeType: "audio/webm",
    ext: "webm",
    durationSec: 2,
  }

  beforeEach(() => {
    attachmentsState.byCellId = new Map()
    localStorage.removeItem("aq.recording-auto-advance.v1")
    resetRecordingAutoAdvanceCacheForTests()
    onActiveCellChange.mockClear()
    recorderState.value = { kind: "idle" }
  })
  afterEach(() => {
    recorderState.value = { kind: "idle" }
    localStorage.removeItem("aq.recording-auto-advance.v1")
    resetRecordingAutoAdvanceCacheForTests()
  })

  const twoCells = (): CellData[] => [
    cellWith("bonjour"),
    { ...cellWith("salut"), id: "c2" } as CellData,
  ]

  function renderTwo() {
    return render(
      <AudioRecordingModal
        open
        project={project}
        cells={twoCells()}
        activeCellId="c1"
        username="sam"
        onActiveCellChange={onActiveCellChange}
        onClose={() => {}}
      />,
    )
  }

  it("defaults to on — saving still moves to the next line", async () => {
    recorderState.value = stopped
    renderTwo()
    expect(screen.getByTestId("rec-auto-advance")).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() => expect(onActiveCellChange).toHaveBeenCalledWith("c2"), { timeout: 2000 })
  })

  it("turned off, saving stays on the same line for another take", async () => {
    recorderState.value = stopped
    renderTwo()
    fireEvent.click(screen.getByTestId("rec-auto-advance"))
    expect(screen.getByTestId("rec-auto-advance")).toHaveAttribute("aria-pressed", "false")

    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() => expect(emitAttach).toHaveBeenCalled()) // the save DID happen
    await new Promise((r) => setTimeout(r, 700)) // well past the 450ms advance window
    expect(onActiveCellChange).not.toHaveBeenCalled()
  })

  it("the choice survives a remount", () => {
    const { unmount } = renderTwo()
    fireEvent.click(screen.getByTestId("rec-auto-advance"))
    unmount()
    resetRecordingAutoAdvanceCacheForTests() // simulate a fresh page load
    renderTwo()
    expect(screen.getByTestId("rec-auto-advance")).toHaveAttribute("aria-pressed", "false")
  })
})
