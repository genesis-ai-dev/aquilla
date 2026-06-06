// Tests for the batch transcribe-all / synth-all driver.
// Verifies: filtering logic, sequential execution, progress tracking, cancel.

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  runTranscribeAll,
  runSynthAll,
  getBatchProgress,
  cancelBatchTranscribe,
  cancelBatchSynth,
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
