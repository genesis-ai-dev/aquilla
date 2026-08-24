// Tests for the batch transcribe-all / synth-all driver.
// Verifies: filtering logic, sequential execution, progress tracking, cancel.

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  runTranscribeAll,
  runSynthAll,
  getBatchProgress,
  cancelBatchTranscribe,
  cancelBatchSynth,
  needsTranscription,
  needsSynthesis,
} from "./batch-audio"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

// ---------------------------------------------------------------------------
// Mock the per-cell functions
// ---------------------------------------------------------------------------

vi.mock("./transcribe", () => ({
  transcribeCell: vi.fn(async () => 5),
}))

vi.mock("./voice-generate-helpers", () => ({
  generateCellVoice: vi.fn(async () => true),
}))

vi.mock("./transcribe-status", () => ({
  getTranscribeStatus: vi.fn(() => ({ kind: "idle" })),
  setTranscribeStatus: vi.fn(),
}))

vi.mock("./tts", () => ({
  ttsStatusKey: (id: string) => `synth:${id}`,
  getTtsStatus: vi.fn(() => ({ kind: "idle" })),
  setTtsStatus: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeCell = (overrides: Partial<CellData> = {}): CellData =>
  ({
    id: "c1",
    fileId: "f1",
    original: "Hello",
    translated: "Hola",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    context: "",
    group: "",
    type: "text",
    ...overrides,
  }) as CellData

const mockSession = { jwt: "tok", username: "user1" } as unknown as import("@/lib/frontier/types").FrontierSession
const mockProject = { id: "proj1", sourceLanguage: "en" } as unknown as ProjectRecord

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runTranscribeAll", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("skips cells without selectedAudioId", async () => {
    const { transcribeCell } = await import("./transcribe")
    const cells = [makeCell({ selectedAudioId: undefined })]
    await runTranscribeAll({ cells, projectId: "proj1", session: mockSession })
    expect(transcribeCell).not.toHaveBeenCalled()
  })

  it("skips cells that already have timings", async () => {
    const { transcribeCell } = await import("./transcribe")
    const cells = [
      makeCell({
        selectedAudioId: "a1",
        attachments: { a1: { url: "frontier-audio://p/f/a1.wav" } as unknown as import("@/lib/codex-editor/types").CodexCellAttachment },
        audioTimings: { a1: [{ word: "hi", start: 0, end: 2, t0: 0, t1: 0.5 }] },
      }),
    ]
    await runTranscribeAll({ cells, projectId: "proj1", session: mockSession })
    expect(transcribeCell).not.toHaveBeenCalled()
  })

  it("calls transcribeCell once per eligible cell", async () => {
    const { transcribeCell } = await import("./transcribe")
    const cells = [
      makeCell({
        id: "c1",
        selectedAudioId: "a1",
        attachments: { a1: { url: "frontier-audio://p/f/a1.wav" } as unknown as import("@/lib/codex-editor/types").CodexCellAttachment },
      }),
      makeCell({
        id: "c2",
        selectedAudioId: "a2",
        attachments: { a2: { url: "frontier-audio://p/f/a2.wav" } as unknown as import("@/lib/codex-editor/types").CodexCellAttachment },
      }),
    ]
    await runTranscribeAll({ cells, projectId: "proj1", session: mockSession })
    expect(transcribeCell).toHaveBeenCalledTimes(2)
  })

  it("reflects done count in progress store when complete", async () => {
    const cells = [
      makeCell({
        id: "c1",
        selectedAudioId: "a1",
        attachments: { a1: { url: "frontier-audio://p/f/a1.wav" } as unknown as import("@/lib/codex-editor/types").CodexCellAttachment },
      }),
    ]
    await runTranscribeAll({ cells, projectId: "proj1", session: mockSession })
    // Progress clears to null after completion.
    expect(getBatchProgress()).toBeNull()
  })
})

// AQU-928: the timeline's "transcribe these sections" row passes an explicit
// cell list, so "already transcribed" must not silently make the click a no-op
// — the per-cell Transcribe button re-runs, and so does a chosen scope.
describe("runTranscribeAll — force (an explicitly chosen scope)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const withAudio = (id: string, audioId: string, extra: Partial<CellData> = {}) =>
    makeCell({
      id,
      selectedAudioId: audioId,
      attachments: {
        [audioId]: { url: `frontier-audio://p/f/${audioId}.wav` } as unknown as import("@/lib/codex-editor/types").CodexCellAttachment,
      },
      ...extra,
    })

  it("re-transcribes a cell that already has timings", async () => {
    const { transcribeCell } = await import("./transcribe")
    const cells = [
      withAudio("c1", "a1", { audioTimings: { a1: [{ word: "hi", start: 0, end: 2, t0: 0, t1: 0.5 }] } }),
    ]
    await runTranscribeAll({ cells, projectId: "proj1", session: mockSession, force: true })
    expect(transcribeCell).toHaveBeenCalledTimes(1)
  })

  it("re-transcribes a media section that already has a transcript", async () => {
    const { transcribeCell } = await import("./transcribe")
    const cells = [withAudio("c1", "src-a1", { medium: "media", transcription: "already here" })]
    await runTranscribeAll({ cells, projectId: "proj1", session: mockSession, force: true })
    expect(transcribeCell).toHaveBeenCalledTimes(1)
  })

  it("still skips cells with no audio to transcribe", async () => {
    const { transcribeCell } = await import("./transcribe")
    const cells = [makeCell({ id: "c1", selectedAudioId: undefined })]
    await runTranscribeAll({ cells, projectId: "proj1", session: mockSession, force: true })
    expect(transcribeCell).not.toHaveBeenCalled()
  })

  it("still skips a cell whose transcription is already in flight", async () => {
    const { transcribeCell } = await import("./transcribe")
    const { getTranscribeStatus } = await import("./transcribe-status")
    vi.mocked(getTranscribeStatus).mockReturnValue({ kind: "transcribing" } as ReturnType<typeof getTranscribeStatus>)
    await runTranscribeAll({
      cells: [withAudio("c1", "a1")], projectId: "proj1", session: mockSession, force: true,
    })
    expect(transcribeCell).not.toHaveBeenCalled()
    vi.mocked(getTranscribeStatus).mockReturnValue({ kind: "idle" } as ReturnType<typeof getTranscribeStatus>)
  })

  it("runs ONLY the cells it was given — the rest of the file is untouched", async () => {
    const { transcribeCell } = await import("./transcribe")
    // The caller has already narrowed to the selection; the batch must not
    // widen it back out to every cell it could find work for.
    await runTranscribeAll({
      cells: [withAudio("c2", "a2")], projectId: "proj1", session: mockSession, force: true,
    })
    expect(transcribeCell).toHaveBeenCalledTimes(1)
    expect(vi.mocked(transcribeCell).mock.calls[0][0].cell.id).toBe("c2")
  })
})

describe("runSynthAll", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("skips cells without translated text", async () => {
    const { generateCellVoice } = await import("./voice-generate-helpers")
    const cells = [makeCell({ translated: "" })]
    await runSynthAll({ cells, project: mockProject, session: mockSession, username: "user1" })
    expect(generateCellVoice).not.toHaveBeenCalled()
  })

  it("skips cells that already have generated voice", async () => {
    const { generateCellVoice } = await import("./voice-generate-helpers")
    const cells = [makeCell({ translated: "Hola", selectedGeneratedVoiceAudioId: "g1" })]
    await runSynthAll({ cells, project: mockProject, session: mockSession, username: "user1" })
    expect(generateCellVoice).not.toHaveBeenCalled()
  })

  it("calls generateCellVoice for eligible cells", async () => {
    const { generateCellVoice } = await import("./voice-generate-helpers")
    const cells = [
      makeCell({ id: "c1", translated: "Hola" }),
      makeCell({ id: "c2", translated: "Adios" }),
    ]
    await runSynthAll({ cells, project: mockProject, session: mockSession, username: "user1" })
    expect(generateCellVoice).toHaveBeenCalledTimes(2)
  })
})

describe("cancel flags", () => {
  it("cancelBatchTranscribe and cancelBatchSynth are exported no-throw functions", () => {
    expect(() => cancelBatchTranscribe()).not.toThrow()
    expect(() => cancelBatchSynth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AQU-646: shared work predicates + per-cell ASR language
// ---------------------------------------------------------------------------

const att = (id: string) =>
  ({ [id]: { url: `frontier-audio://p/f/${id}.wav` } as unknown as import("@/lib/codex-editor/types").CodexCellAttachment })

describe("needsTranscription (AQU-646)", () => {
  it("is false without a selected recording", () => {
    expect(needsTranscription(makeCell({ selectedAudioId: undefined }))).toBe(false)
  })

  it("media segment: true until the cell has transcript TEXT (timings alone don't count)", () => {
    const base = { medium: "media" as const, selectedAudioId: "a1", attachments: att("a1") }
    expect(needsTranscription(makeCell(base))).toBe(true)
    expect(needsTranscription(makeCell({ ...base, transcription: "   " }))).toBe(true)
    expect(needsTranscription(makeCell({ ...base, transcription: "bonjour" }))).toBe(false)
  })

  it("recorded take: true until the recording has word timings", () => {
    const base = { selectedAudioId: "a1", attachments: att("a1") }
    expect(needsTranscription(makeCell(base))).toBe(true)
    expect(
      needsTranscription(
        makeCell({ ...base, audioTimings: { a1: [{ word: "hi", start: 0, end: 2, t0: 0, t1: 0.5 }] } }),
      ),
    ).toBe(false)
  })
})

describe("needsSynthesis (AQU-646)", () => {
  it("requires translated text and no generated voice", () => {
    expect(needsSynthesis(makeCell({ translated: "" }))).toBe(false)
    expect(needsSynthesis(makeCell({ translated: "Hola" }))).toBe(true)
    expect(needsSynthesis(makeCell({ translated: "Hola", selectedGeneratedVoiceAudioId: "g1" }))).toBe(false)
  })
})

describe("runTranscribeAll — language follows the audio (AQU-646)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("media segments get sourceLanguage, recorded takes get targetLanguage", async () => {
    const { transcribeCell } = await import("./transcribe")
    const cells = [
      makeCell({ id: "m1", medium: "media", selectedAudioId: "a1", attachments: att("a1") }),
      makeCell({ id: "t1", selectedAudioId: "a2", attachments: att("a2") }),
    ]
    await runTranscribeAll({
      cells,
      projectId: "proj1",
      session: mockSession,
      sourceLanguage: "fra",
      targetLanguage: "spa",
    })
    const calls = (transcribeCell as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as { cell: CellData; language?: string },
    )
    expect(calls.find((c) => c.cell.id === "m1")?.language).toBe("fra")
    expect(calls.find((c) => c.cell.id === "t1")?.language).toBe("spa")
  })

  it("media segments fall back to the target language when no sourceLanguage is given", async () => {
    const { transcribeCell } = await import("./transcribe")
    const cells = [makeCell({ id: "m1", medium: "media", selectedAudioId: "a1", attachments: att("a1") })]
    await runTranscribeAll({ cells, projectId: "proj1", session: mockSession, language: "spa" })
    const call = (transcribeCell as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { language?: string }
    expect(call.language).toBe("spa")
  })
})

describe("needsTranscription — dub take on a media cell (SUB-29)", () => {
  it("a take-selected media cell follows the TIMINGS rule, not the transcript rule", () => {
    const takeId = "audio-c1-1700000000-abcdefgh.webm"
    const base = {
      medium: "media" as const,
      transcription: "already transcribed source",
      selectedAudioId: takeId,
      attachments: { [takeId]: { url: `frontier-audio://${takeId}` } as unknown as import("@/lib/codex-editor/types").CodexCellAttachment },
    }
    // Transcript exists but the TAKE has no timings → still needs transcription.
    expect(needsTranscription(makeCell(base))).toBe(true)
    expect(
      needsTranscription(
        makeCell({ ...base, audioTimings: { [takeId]: [{ word: "hi", start: 0, end: 2, t0: 0, t1: 0.5 }] } }),
      ),
    ).toBe(false)
  })
})

// ── Batch progress, for whoever is reporting it (AQU-646, 2026-08-18) ────

describe("runTranscribeAll progress", () => {
  it("reports the total BEFORE any work, then counts up", async () => {
    const seen: [number, number][] = []
    await runTranscribeAll({
      cells: [
        makeCell({
          id: "c1",
          selectedAudioId: "a1",
          attachments: { a1: { url: "frontier-audio://p/f/a1.wav" } as unknown as import("@/lib/codex-editor/types").CodexCellAttachment },
        }),
        makeCell({
          id: "c2",
          selectedAudioId: "a2",
          attachments: { a2: { url: "frontier-audio://p/f/a2.wav" } as unknown as import("@/lib/codex-editor/types").CodexCellAttachment },
        }),
      ],
      projectId: "p1",
      session: null,
      onProgress: (done, total) => seen.push([done, total]),
    })
    // The zeroth call is the point: on a cold run the Whisper model download
    // happens inside the first cell, so without it the screen would sit empty
    // for most of the wait.
    expect(seen[0]).toEqual([0, 2])
    expect(seen[seen.length - 1]).toEqual([2, 2])
  })

  it("stays silent when nothing needs transcribing", async () => {
    const onProgress = vi.fn()
    await runTranscribeAll({ cells: [], projectId: "p1", session: null, onProgress })
    expect(onProgress).not.toHaveBeenCalled()
  })
})
