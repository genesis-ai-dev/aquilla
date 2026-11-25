// The recording modal's takes list, saving, transcription and close/step guards.
// (Generating speech lives in the Voices sidebar, not here.)

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
const probeSpy = vi.hoisted(() => vi.fn(async () => 1000))
vi.mock("@/lib/import", () => ({
  probeDurationMsSafe: (...args: unknown[]) => probeSpy(...(args as [])),
}))
const injectOptimistic = vi.hoisted(() => vi.fn((..._args: unknown[]) => {}))
const injectDeselect = vi.hoisted(() => vi.fn((..._args: unknown[]) => {}))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  notifyAudioAttachmentsChanged: vi.fn(),
  injectOptimisticAudioAttachment: (...args: unknown[]) => injectOptimistic(...args),
  injectOptimisticAudioRemove: vi.fn(),
  injectOptimisticAudioDeselect: (...args: unknown[]) => injectDeselect(...args),
}))
const emitAttach = vi.fn(async (..._args: unknown[]) => "evt-attach")
const emitSelect = vi.fn(async (..._args: unknown[]) => "evt-select")
const emitDeselect = vi.fn(async (..._args: unknown[]) => "evt-deselect")
const emitMeasure = vi.fn(async (..._args: unknown[]) => "evt-measure")
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioMeasure: (...args: unknown[]) => emitMeasure(...args),
  emitCellAudioDeselect: (...args: unknown[]) => emitDeselect(...args),
  emitCellAudioValidate: vi.fn(async () => "evt"),
  emitCellAudioPlace: vi.fn(async () => "evt"),
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
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCacheGet: vi.fn(async () => null), audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("@/lib/audio/transcribe-status", () => ({ setTranscribeStatus: vi.fn(), waitAtTranscribeLimit: () => async () => {} }))
const transcribeCell = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}))
vi.mock("@/lib/audio/transcribe", () => ({
  transcribeCell: (...args: unknown[]) => transcribeCell(...args),
}))
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
import { resetRecordingAutoAdvanceCacheForTests } from "@/lib/store/recording-auto-advance-pref"

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
    emitMeasure.mockClear()
    injectOptimistic.mockClear()
  })

  // AQU-2491 (review, Nov 9): the heal used to RE-ATTACH the take, and an
  // attach chooses it and brings it back if deleted. On a slow network the
  // measure lands after the person has recorded a new take or deleted this
  // one, which then played again. It sends the fill-only length instead
  // (`cell.audio.measure`), which chooses nothing and keeps name and trims.
  it("fills in the SELECTED webm take's decoded length without choosing it again", async () => {
    seedEntry({
      "audio-c1-200-take.webm": att("audio-c1-200-take.webm", {
        mimeType: "audio/webm", durationMs: null, label: "Take 1", trimStartMs: 100, trimEndMs: 900,
      }),
    }, "audio-c1-200-take.webm")
    renderModal(cellWith("bonjour"))
    await waitFor(() => expect(emitMeasure).toHaveBeenCalledTimes(1))
    expect(emitMeasure).toHaveBeenCalledWith(expect.objectContaining({
      fileId: "f1",
      cellId: "c1",
      audioId: "audio-c1-200-take.webm",
      durationMs: 1000, // the mocked probe's decode result
    }))
    expect(emitAttach).not.toHaveBeenCalled()
    // Painted at its length at once, without claiming the slot.
    await waitFor(() => expect(injectOptimistic).toHaveBeenCalled())
    const paint = injectOptimistic.mock.calls.at(-1) as unknown[]
    expect(paint[2]).toMatchObject({ audioId: "audio-c1-200-take.webm", durationMs: 1000, label: "Take 1", trimStartMs: 100, trimEndMs: 900 })
    expect(paint[3]).toBe("evt-measure")
    expect(paint[4]).toEqual({ claimSelection: false })
  })

  it("does nothing when the selected take already has a duration", async () => {
    seedEntry({ "audio-c1-200-take.webm": att("audio-c1-200-take.webm") }, "audio-c1-200-take.webm")
    renderModal(cellWith("bonjour"))
    await new Promise((r) => setTimeout(r, 50))
    expect(emitAttach).not.toHaveBeenCalled()
    expect(emitMeasure).not.toHaveBeenCalled()
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

  it("transcribes the fresh take in the lane it was recorded in (AQU-1978)", async () => {
    // The timings land ~800ms after every take through a re-attach that
    // deselects within the lane it names. With no lane that was the `''`
    // lane's chosen take on this line, whichever lane the take was made in.
    recorderState.value = {
      kind: "stopped",
      blob: new Blob(["x"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      ext: "webm",
      durationSec: 2,
    }
    renderModal(cellWith("bonjour"), { laneTag: "fr" })
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))

    await waitFor(() => expect(transcribeCell).toHaveBeenCalledTimes(1))
    const [args] = transcribeCell.mock.calls[0] as unknown as [{ targetLang?: string }]
    expect(args.targetLang).toBe("fr")
  })

  it("asks Whisper for the LANE's language, not the retired project one (AQU-1978)", async () => {
    // A project made since AQU-1594 has no project-level language at all; the
    // take is in the open lane's language, read off that lane's row — never
    // its tag, which here is the lane's own id.
    const laneProject = {
      ...project,
      targetLanguage: "",
      lanes: [
        { id: "spa00001", role: "target", language: "Spanish", name: null, langCode: null, legacyTag: "Spanish", position: 0, archivedAt: null },
        { id: "a3f09c1e", role: "target", language: "Portuguese", name: null, langCode: null, legacyTag: "a3f09c1e", position: 1, archivedAt: null },
      ],
    } as unknown as ProjectRecord
    recorderState.value = {
      kind: "stopped",
      blob: new Blob(["x"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      ext: "webm",
      durationSec: 2,
    }
    renderModal(cellWith("olá"), { project: laneProject, laneTag: "a3f09c1e" })
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))

    await waitFor(() => expect(transcribeCell).toHaveBeenCalledTimes(1))
    const [args] = transcribeCell.mock.calls[0] as unknown as [{ language?: string }]
    expect(args.language).toBe("Portuguese")
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
    localStorage.removeItem("aq.recording-auto-advance.v2")
    resetRecordingAutoAdvanceCacheForTests()
    onActiveCellChange.mockClear()
    recorderState.value = { kind: "idle" }
  })
  afterEach(() => {
    recorderState.value = { kind: "idle" }
    localStorage.removeItem("aq.recording-auto-advance.v2")
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

  // Sam, 2026-09-28: the settings are real switches, and what each does is
  // said on hover, not in a line of its own.
  it("is a real switch: it toggles once, the row's name toggles it too, and no description line shows", () => {
    renderTwo()
    fireEvent.click(screen.getByTestId("rec-settings"))
    const sw = screen.getByTestId("rec-auto-advance")
    expect(sw).toHaveAttribute("role", "switch")
    fireEvent.click(sw)
    expect(screen.getByTestId("rec-auto-advance")).toHaveAttribute("aria-checked", "true")
    fireEvent.click(screen.getByText("Move on after saving a recording"))
    expect(screen.getByTestId("rec-auto-advance")).toHaveAttribute("aria-checked", "false")
    expect(screen.queryByText(/Saved recordings (jump|stay)/)).toBeNull()
  })

  // AQU-2620 (Matthew, 2026-11-16): off is the default now. Saving a take
  // leaves you on the line you are working, recorder open, for another take.
  it("defaults to off — saving stays on the same line for another take", async () => {
    recorderState.value = stopped
    renderTwo()
    fireEvent.click(screen.getByTestId("rec-settings"))
    expect(screen.getByTestId("rec-auto-advance")).toHaveAttribute("aria-checked", "false")
    // By testid, not by name: the settings popover is open at this point, and
    // AQU-1216 put the word "Saved" into the auto-advance description, so a
    // /Save/ role query matches that control too.
    fireEvent.click(screen.getByTestId("rec-save"))
    await waitFor(() => expect(emitAttach).toHaveBeenCalled()) // the save DID happen
    await new Promise((r) => setTimeout(r, 700)) // well past the 450ms advance window
    expect(onActiveCellChange).not.toHaveBeenCalled()
  })

  it("turned on, saving moves to the next line", async () => {
    recorderState.value = stopped
    renderTwo()
    fireEvent.click(screen.getByTestId("rec-settings"))
    fireEvent.click(screen.getByTestId("rec-auto-advance"))
    expect(screen.getByTestId("rec-auto-advance")).toHaveAttribute("aria-checked", "true")

    fireEvent.click(screen.getByTestId("rec-save"))
    await waitFor(() => expect(onActiveCellChange).toHaveBeenCalledWith("c2"))
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
    expect(screen.getByTestId("rec-auto-advance")).toHaveAttribute("aria-checked", "true")
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

  // Pressed inside the recorder, where the dialog's own Escape handling sees
  // it too (2026-09-28). The recorder's key handler owns Escape, so it closes
  // once, not once for the handler and again for the dialog.
  it("closes once on Escape pressed inside the recorder", () => {
    const onClose = renderWithClose()
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
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

  // Sam, 2026-09-28: ⌥← / ⌥→ were dead. The dialog's popup (Base UI 1.7)
  // stops arrow keys leaving it, and the test above sent its key straight to
  // the window, around the popup. These press it where focus is.
  it("steps to the next and previous line on Alt+Arrow pressed inside the recorder", () => {
    const onActiveCellChange = vi.fn()
    const { rerender } = render(
      <AudioRecordingModal
        open project={project} cells={twoCells()} activeCellId="c1"
        username="sam" onActiveCellChange={onActiveCellChange} onClose={() => {}}
      />,
    )
    const inside = screen.getByRole("dialog")
    fireEvent.keyDown(inside, { key: "ArrowRight", altKey: true })
    expect(onActiveCellChange).toHaveBeenLastCalledWith("c2")
    rerender(
      <AudioRecordingModal
        open project={project} cells={twoCells()} activeCellId="c2"
        username="sam" onActiveCellChange={onActiveCellChange} onClose={() => {}}
      />,
    )
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft", altKey: true })
    expect(onActiveCellChange).toHaveBeenLastCalledWith("c1")
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

  // The pencil beside "Read aloud" leaves the recorder too, so it asks the
  // same question and, on a discard, still goes where it was asked to.
  function renderWithEdit() {
    const onEditText = vi.fn()
    const onClose = vi.fn()
    render(
      <AudioRecordingModal
        open project={project} cells={[cellWith("bonjour")]} activeCellId="c1"
        username="sam" onActiveCellChange={() => {}} onEditText={onEditText} onClose={onClose}
      />,
    )
    return { onEditText, onClose }
  }

  it("asks before leaving to edit the text", () => {
    stopped()
    const { onEditText } = renderWithEdit()
    fireEvent.click(screen.getByTestId("rec-edit-text"))
    expect(screen.getByTestId("rec-confirm-close")).toBeInTheDocument()
    expect(onEditText).not.toHaveBeenCalled()
  })

  it("goes to edit the text once the answer is to throw the take away", () => {
    stopped()
    const { onEditText, onClose } = renderWithEdit()
    fireEvent.click(screen.getByTestId("rec-edit-text"))
    fireEvent.click(screen.getByTestId("rec-confirm-discard"))
    expect(onEditText).toHaveBeenCalledWith("c1")
    expect(onClose).not.toHaveBeenCalled()
  })

  it("goes straight to the text when no take is waiting", () => {
    const { onEditText } = renderWithEdit()
    fireEvent.click(screen.getByTestId("rec-edit-text"))
    expect(screen.queryByTestId("rec-confirm-close")).toBeNull()
    expect(onEditText).toHaveBeenCalledWith("c1")
  })
})

// AQU-1941: each generated take is labelled with the voice it was made in.
describe("AudioRecordingModal — generated takes name their voice", () => {
  const narrator = { id: "v-narrator", name: "Narrator", color: "#475569" }
  const chip = { id: "v-chip", name: "Chip Ingram", color: "#0e7490" }
  const clone = { id: "v-clone", name: "Test Arabic Chip", color: "#0d9488" }
  const castProject = (ttsSettings: Record<string, unknown>) =>
    ({ id: "p1", name: "P", ttsSettings: { voices: [narrator, chip, clone], defaultVoiceId: narrator.id, ...ttsSettings } }) as unknown as ProjectRecord

  beforeEach(() => {
    attachmentsState.byCellId = new Map()
  })

  it("names the voice each generated take was made in", () => {
    seedEntry({
      "audio-c1-200-take.webm": att("audio-c1-200-take.webm"),
      "audio-c1-300-tts.wav": att("audio-c1-300-tts.wav", { slot: "generatedVoice", voiceId: clone.id, label: "Take 2" }),
    }, "audio-c1-200-take.webm", "audio-c1-300-tts.wav")
    renderModal(cellWith("bonjour"), { project: castProject({}) })
    expect(screen.getByTestId("take-voice-audio-c1-300-tts.wav")).toHaveTextContent("Test Arabic Chip")
    // A recording is a person's — the row already names them.
    expect(screen.queryByTestId("take-voice-audio-c1-200-take.webm")).toBeNull()
  })

  // AQU-1941: the voice may be pruned from the project after the take was
  // made. A bare id is not a name, and a guess is worse.
  it("says nothing about a take whose voice has since been removed", () => {
    seedEntry({
      "audio-c1-300-tts.wav": att("audio-c1-300-tts.wav", { slot: "generatedVoice", voiceId: "v-deleted", label: "Take 1" }),
    }, null, "audio-c1-300-tts.wav")
    renderModal(cellWith("bonjour"), { project: castProject({}) })
    expect(screen.getByTestId("take-row-audio-c1-300-tts.wav")).toBeInTheDocument()
    expect(screen.queryByTestId("take-voice-audio-c1-300-tts.wav")).toBeNull()
  })
})
