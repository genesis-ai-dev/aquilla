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
  emitCellLaneRetime: vi.fn(async () => "evt"),
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
import { setTtsStatus, ttsStatusKey } from "@/lib/audio/tts"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

const onActiveCellChange = vi.fn((..._args: unknown[]) => {})

const project = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord

const cellWith = (translated: string): CellData =>
  ({
    id: "c1", fileId: "f1", original: "hello", translated,
    medium: "media", startTime: 0, endTime: 5,
  }) as unknown as CellData

function renderModal(cell: CellData, extra: Record<string, unknown> = {}) {
  return render(
    <AudioRecordingModal
      open
      project={project}
      cells={[cell]}
      activeCellId="c1"
      username="sam"
      onActiveCellChange={() => {}}
      onClose={() => {}}
      {...extra}
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
    expect(screen.getByTestId("rec-takes-count")).toHaveTextContent("Takes 1")
  })

  it("generated TTS attachments appear as takes alongside recordings (round 8c)", () => {
    seedEntry({
      "audio-c1-200-take.webm": att("audio-c1-200-take.webm"),
      "audio-c1-300-tts.wav": att("audio-c1-300-tts.wav", { slot: "generatedVoice", voiceId: "v1", label: "Take 2" }),
    }, "audio-c1-200-take.webm")
    renderModal(cellWith("bonjour"))
    expect(screen.getByTestId("take-row-audio-c1-200-take.webm")).toBeInTheDocument()
    expect(screen.getByTestId("take-row-audio-c1-300-tts.wav")).toBeInTheDocument()
    expect(screen.getByTestId("rec-takes-count")).toHaveTextContent("Takes 2")
  })

  // AQU-646 stage 3c — Sam, 2026-08-24: "if a take exists for a given cell in
  // the default target audio track, then… any takes from other tracks connected
  // to that cell show up as well. The moment the audio tracks from the original
  // target audio track are removed, then the other takes disappear along with
  // it (they are still there, but they are invisible)."
  //
  // The strip listed EVERY track's takes but was gated on the CURRENT track's
  // count, so an empty current track hid the whole list — including audio that
  // very much existed. This is the one the blocker report was about.
  it("lists another track's takes even when this track has none of its own", () => {
    seedEntry({
      "audio-c1-400-other.webm": att("audio-c1-400-other.webm", { slot: "trk-2", label: "Take 1" }),
    }, null)
    renderModal(cellWith("bonjour"), {
      timelineTracks: [{ id: "trk-2", kind: "audio", name: "Second track", order: 9 }],
    })
    expect(screen.getByTestId("take-row-audio-c1-400-other.webm")).toBeInTheDocument()
    expect(screen.getByTestId("rec-takes-count")).toHaveTextContent("Takes 1")
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
    expect(screen.getByTestId("rec-start")).toBeInTheDocument()
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
    fireEvent.click(screen.getByTestId("rec-settings"))
    expect(screen.getByTestId("rec-auto-advance")).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() => expect(onActiveCellChange).toHaveBeenCalledWith("c2"), { timeout: 2000 })
  })

  it("turned off, saving stays on the same line for another take", async () => {
    recorderState.value = stopped
    renderTwo()
    fireEvent.click(screen.getByTestId("rec-settings"))
    fireEvent.click(screen.getByTestId("rec-auto-advance"))
    expect(screen.getByTestId("rec-auto-advance")).toHaveAttribute("aria-pressed", "false")

    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() => expect(emitAttach).toHaveBeenCalled()) // the save DID happen
    await new Promise((r) => setTimeout(r, 700)) // well past the 450ms advance window
    expect(onActiveCellChange).not.toHaveBeenCalled()
  })

  it("the choice survives a remount", () => {
    // Auto-advance moved behind the utility strip's settings button in the
    // split-stage rebuild, so both halves of this have to open it first.
    const { unmount } = renderTwo()
    fireEvent.click(screen.getByTestId("rec-settings"))
    fireEvent.click(screen.getByTestId("rec-auto-advance"))
    unmount()
    resetRecordingAutoAdvanceCacheForTests() // simulate a fresh page load
    renderTwo()
    fireEvent.click(screen.getByTestId("rec-settings"))
    expect(screen.getByTestId("rec-auto-advance")).toHaveAttribute("aria-pressed", "false")
  })
})

// ── AQU-646 stage 4c ─────────────────────────────────────────────────────────
//
// Sam, 2026-08-26: "If TTS generation fails, the recording modal should reflect
// this… the generate TTS button itself should turn red and have a little
// warning written out on it."
//
// It never did. `generateCellVoice` has always written the failure into the
// shared per-cell status store; the modal read only the boolean it returns and,
// on false, let the button fall back to idle — so a failed generation looked
// exactly like one that had never been pressed.
//
// These drive the STORE directly, because the suite mocks `generateCellVoice`
// wholesale and its real status writes therefore never run.
describe("AudioRecordingModal — a failed generation says so (stage 4c)", () => {
  const KEY = ttsStatusKey("c1")
  // The default engine's most likely failure, verbatim.
  const NOT_CONFIGURED = "voice/tts failed (503): TTS not configured"

  beforeEach(() => {
    attachmentsState.byCellId = new Map()
    generateCellVoice.mockClear()
  })
  // `tts.ts` has no clear function — the store is a module Map that outlives
  // any component — so a case that leaves an error in it would hand that error
  // to every case after it.
  afterEach(() => setTtsStatus(KEY, { kind: "idle" }))

  it("turns the button red and keeps it PRESSABLE, because pressing it is the retry", () => {
    setTtsStatus(KEY, { kind: "error", message: NOT_CONFIGURED })
    renderModal(cellWith("bonjour"))
    const btn = screen.getByTestId("rec-generate-tts")
    expect(btn).toHaveTextContent("TTS failed")
    expect(btn.className).toContain("text-destructive")
    // The one thing a failure must never do. Disabling it would strand the user
    // on the error with no way out of it.
    expect(btn).toBeEnabled()
  })

  it("writes the reason out in full, without the server's own words", () => {
    setTtsStatus(KEY, { kind: "error", message: NOT_CONFIGURED })
    renderModal(cellWith("bonjour"))
    const line = screen.getByTestId("rec-tts-error")
    // What it IS, then what to do about it. AQU-1001 names the engine: the
    // default engine's 503 reads as Inworld TTS not configured, never as a
    // missing Gemini key.
    expect(line).toHaveTextContent(/Inworld TTS isn't configured/i)
    expect(line).toHaveTextContent(/will not fix/i)
    // NOT the raw fragment. That is support's text, not the performer's, and it
    // lives in the tooltip.
    expect(line.textContent).not.toContain("503")
    expect(line.textContent).not.toContain("voice/tts")
  })

  it("does not repeat itself when the explanation already opens with its heading", () => {
    // The daily-budget body is literally "Daily AI limit reached — resets at
    // midnight UTC…" under the title "Daily AI limit reached", so a naive join
    // says it twice.
    setTtsStatus(KEY, {
      kind: "error",
      message: 'voice/tts failed (429): {"error":"tts_daily_limit_exceeded"}',
    })
    renderModal(cellWith("bonjour"))
    const text = screen.getByTestId("rec-tts-error").textContent ?? ""
    expect(text).toMatch(/Daily AI limit reached/)
    expect(text.match(/Daily AI limit reached/g)).toHaveLength(1)
  })

  // THE GUARD THAT MATTERS MOST. `generateCellVoice` also returns false when the
  // user DECLINED a model download, and that path deliberately sets an idle
  // status. Reddening the button for a choice someone just made would be a
  // worse lie than saying nothing — which is exactly why this reads the store
  // and not the boolean.
  it("stays quiet when a run returns false without an error — a declined download is not a fault", async () => {
    generateCellVoice.mockImplementationOnce(async () => false)
    renderModal(cellWith("bonjour"))
    const btn = screen.getByTestId("rec-generate-tts")
    fireEvent.click(btn)
    await waitFor(() => expect(generateCellVoice).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId("rec-generate-tts")).toBeEnabled())
    expect(screen.getByTestId("rec-generate-tts").className).not.toContain("text-destructive")
    expect(screen.queryByTestId("rec-tts-error")).toBeNull()
  })

  it("a retry reads as in-flight, not as the failure it is replacing", async () => {
    setTtsStatus(KEY, { kind: "error", message: NOT_CONFIGURED })
    // Held open so the button is observed mid-run rather than after it.
    let release: (v: boolean) => void = () => {}
    generateCellVoice.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { release = resolve }),
    )
    renderModal(cellWith("bonjour"))
    fireEvent.click(screen.getByTestId("rec-generate-tts"))
    await waitFor(() => expect(screen.getByTestId("rec-generate-tts")).toBeDisabled())
    const btn = screen.getByTestId("rec-generate-tts")
    // Busy leads the precedence: the stale error is still sitting in the store,
    // and a button that showed it while working would say the retry had already
    // failed.
    expect(btn).not.toHaveTextContent("TTS failed")
    expect(btn.className).not.toContain("text-destructive")
    release(true)
  })

  it("counts out a voice-model download instead of spinning anonymously", () => {
    setTtsStatus(KEY, { kind: "loading", loaded: 5, total: 10, file: "model.onnx" })
    renderModal(cellWith("bonjour"))
    const btn = screen.getByTestId("rec-generate-tts")
    expect(btn).toHaveTextContent("Downloading 50%")
    // A run someone else started for this cell still counts as busy — two
    // synths for one cell would fight over one status slot.
    expect(btn).toBeDisabled()
  })

  it("says when it has stopped downloading and started speaking", () => {
    setTtsStatus(KEY, { kind: "synthesizing" })
    renderModal(cellWith("bonjour"))
    expect(screen.getByTestId("rec-generate-tts")).toHaveTextContent("Synthesizing")
  })

  it("keeps the verbatim server text reachable on hover", async () => {
    setTtsStatus(KEY, { kind: "error", message: NOT_CONFIGURED })
    renderWithTooltips(
      <AudioRecordingModal
        open project={project} cells={[cellWith("bonjour")]} activeCellId="c1"
        username="sam" onActiveCellChange={() => {}} onClose={() => {}}
      />,
    )
    await expectTooltip(screen.getByTestId("rec-generate-tts"), /TTS not configured/i)
  })
})

// ── AQU-646: leaving with a take you have not kept ──────────────────────────
//
// Sam, 2026-08-26: "if you've recorded a take and haven't actually clicked save
// yet or retake, but you click the little X button or press escape, then the
// recording modal closes and by default does not save the recorded take."
//
// It was worse than that: Escape called RETAKE, so it threw the take away
// WITHOUT closing — the quietest way in the app to lose a recording.
describe("AudioRecordingModal — an unsaved take is not lost quietly", () => {
  const stopped = () => {
    recorderState.value = {
      kind: "stopped",
      blob: new Blob(["x"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      ext: "webm",
      durationSec: 3,
    }
  }
  beforeEach(() => { attachmentsState.byCellId = new Map() })
  afterEach(() => { recorderState.value = { kind: "idle" } })

  function renderWithClose() {
    const onClose = vi.fn()
    render(
      <AudioRecordingModal
        open project={project} cells={[cellWith("bonjour")]} activeCellId="c1"
        username="sam" onActiveCellChange={() => {}} onClose={onClose}
      />,
    )
    return onClose
  }

  it("asks before closing on the X", () => {
    stopped()
    const onClose = renderWithClose()
    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    expect(screen.getByTestId("rec-confirm-close")).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  // The one Sam did not know about: this used to scrap the take on the spot.
  it("asks on Escape instead of throwing the take away", () => {
    stopped()
    const onClose = renderWithClose()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.getByTestId("rec-confirm-close")).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("leaves when the answer is to throw it away", () => {
    stopped()
    const onClose = renderWithClose()
    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    fireEvent.click(screen.getByTestId("rec-confirm-discard"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("keeps the take when the answer is to save it", async () => {
    stopped()
    renderWithClose()
    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    fireEvent.click(screen.getByTestId("rec-confirm-save"))
    // The recorder's ordinary save runs; nothing is discarded behind it.
    await waitFor(() => expect(emitAttach).toHaveBeenCalled())
  })

  // The question is only worth asking when there is something to lose.
  it("closes straight away when no take is waiting", () => {
    const onClose = renderWithClose()
    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    expect(screen.queryByTestId("rec-confirm-close")).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // ── …AND THE ARROWS ARE AN EXIT TOO (2026-08-27) ────────────────────────
  //
  // The guard above was wired to the X, Escape and clicking outside, and
  // stopped there. But ‹ › — and Alt+Arrow, which shares their handler — step
  // to another line, and the cell-change effect calls `resetToIdle()`, which
  // drops the pending blob. So the one control an operator presses over and
  // over while working through a file was the one that threw a take away
  // without asking. Sam's ruling: ask, exactly like the X does.
  const twoCells = () => [
    cellWith("bonjour"),
    { ...cellWith("salut"), id: "c2" } as CellData,
  ]

  function renderWithNav() {
    const onActiveCellChange = vi.fn()
    render(
      <AudioRecordingModal
        open project={project} cells={twoCells()} activeCellId="c1"
        username="sam" onActiveCellChange={onActiveCellChange} onClose={() => {}}
      />,
    )
    return onActiveCellChange
  }

  it("asks before stepping to the next line, instead of dropping the take", () => {
    stopped()
    const onActiveCellChange = renderWithNav()
    fireEvent.click(screen.getByTestId("rec-next"))
    expect(screen.getByTestId("rec-confirm-close")).toBeInTheDocument()
    expect(onActiveCellChange).not.toHaveBeenCalled()
  })

  // Alt+Arrow runs through the same helper, so it must inherit the same guard
  // rather than needing its own.
  it("asks on Alt+Arrow too", () => {
    stopped()
    const onActiveCellChange = renderWithNav()
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true })
    expect(screen.getByTestId("rec-confirm-close")).toBeInTheDocument()
    expect(onActiveCellChange).not.toHaveBeenCalled()
  })

  // Throwing it away goes WHERE THEY ASKED, not merely closing the dialog —
  // the confirmation performs the exit that was pending, whichever it was.
  it("moves on once the answer is to throw it away", () => {
    stopped()
    const onActiveCellChange = renderWithNav()
    fireEvent.click(screen.getByTestId("rec-next"))
    fireEvent.click(screen.getByTestId("rec-confirm-discard"))
    expect(onActiveCellChange).toHaveBeenCalledWith("c2")
  })

  it("steps back the same way", () => {
    stopped()
    const onActiveCellChange = vi.fn()
    render(
      <AudioRecordingModal
        open project={project} cells={twoCells()} activeCellId="c2"
        username="sam" onActiveCellChange={onActiveCellChange} onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId("rec-prev"))
    expect(screen.getByTestId("rec-confirm-close")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("rec-confirm-discard"))
    expect(onActiveCellChange).toHaveBeenCalledWith("c1")
  })

  // Unchanged where there is nothing to lose: the arrows must not start asking
  // on every line, which would make the guard worse than the bug.
  it("steps straight over when no take is waiting", () => {
    const onActiveCellChange = renderWithNav()
    fireEvent.click(screen.getByTestId("rec-next"))
    expect(screen.queryByTestId("rec-confirm-close")).toBeNull()
    expect(onActiveCellChange).toHaveBeenCalledWith("c2")
  })

  // The arrows stay PRESSABLE while a take is in preview — disabling them
  // would answer the question by refusing to pose it.
  it("leaves the arrows enabled so they can ask at all", () => {
    stopped()
    renderWithNav()
    expect(screen.getByTestId("rec-next")).toBeEnabled()
  })
})
