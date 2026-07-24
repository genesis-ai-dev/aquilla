// AQU-646: generateCellVoice must honor persisted cast assignments
// (diarization's Speaker N → cell mapping) — before this, castAssignments
// existed in settings but per-cell/batch generation ignored them, so cloned
// Speaker voices never actually spoke.

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

const generateAndAttachCellVoice = vi.fn(async (_args: unknown) => ({ blob: new Blob() }))
vi.mock("./generate-voice", () => ({
  generateAndAttachCellVoice: (a: unknown) => generateAndAttachCellVoice(a),
}))

import { generateCellVoice } from "./voice-generate-helpers"

const project = {
  id: "p1",
  sourceLanguage: "en",
  targetLanguage: "es",
  ttsSettings: {
    voices: [
      { id: "v-narr", name: "Narrator" },
      { id: "v-spk1", name: "Speaker 1", referenceAudioId: "ref-1.wav" },
    ],
    castAssignments: { "cell-assigned": "v-spk1" },
  },
} as unknown as ProjectRecord

const session = { jwt: "tok", username: "alice" } as unknown as FrontierSession

function makeCell(id: string, overrides: Partial<CellData> = {}): CellData {
  return {
    id,
    fileId: "f1",
    original: "hello",
    translated: "hola",
    context: "",
    group: "",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...overrides,
  } as CellData
}

function calledWithVoiceId(): string | undefined {
  const args = (generateAndAttachCellVoice.mock.calls[0] as unknown[])[0] as { cellVoiceId?: string }
  return args.cellVoiceId
}

beforeEach(() => {
  generateAndAttachCellVoice.mockClear()
})

describe("generateCellVoice — cast-aware voice resolution (AQU-646)", () => {
  it("a cast-assigned cell generates with its assigned Speaker voice", async () => {
    const ok = await generateCellVoice({
      project,
      cell: makeCell("cell-assigned"),
      session,
      username: "alice",
    })
    expect(ok).toBe(true)
    expect(calledWithVoiceId()).toBe("v-spk1")
  })

  it("an explicit caller voiceId override still wins over the assignment", async () => {
    await generateCellVoice({
      project,
      cell: makeCell("cell-assigned"),
      session,
      username: "alice",
      voiceId: "v-override",
    })
    expect(calledWithVoiceId()).toBe("v-override")
  })

  it("an unassigned cell falls back to its own voiceId", async () => {
    await generateCellVoice({
      project,
      cell: makeCell("cell-free", { ttsSettings: { voiceId: "v-narr" } } as Partial<CellData>),
      session,
      username: "alice",
    })
    expect(calledWithVoiceId()).toBe("v-narr")
  })
})
