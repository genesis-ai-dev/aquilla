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

// AQU-1978: the languages a voice is generated in come from the lanes. The
// project-level pair is retired (AQU-1594/1595) and empty on a new project, so
// Inworld was told no language and the default voice was picked for none — on
// every regenerate, voice-panel and batch generation.
describe("generateCellVoice — speaks in the lane's language (AQU-1978)", () => {
  const laneProject = {
    id: "p1",
    // A project made since AQU-1594: nothing at the project level.
    sourceLanguage: "",
    targetLanguage: "",
    ttsSettings: {},
    lanes: [
      { id: "src00001", role: "source", language: "English", name: null, langCode: null, legacyTag: null, position: 0, archivedAt: null },
      { id: "spa00001", role: "target", language: "Spanish", name: null, langCode: null, legacyTag: "Spanish", position: 0, archivedAt: null },
      { id: "a3f09c1e", role: "target", language: "Portuguese", name: null, langCode: null, legacyTag: "a3f09c1e", position: 1, archivedAt: null },
    ],
  } as unknown as ProjectRecord

  const contextOf = () =>
    ((generateAndAttachCellVoice.mock.calls[0] as unknown[])[0] as {
      geminiContext: { sourceLanguage?: string; targetLanguage?: string }
    }).geminiContext

  it("tells the engine the open lane's language and the source lane's", async () => {
    await generateCellVoice({ project: laneProject, cell: makeCell("c1"), session, username: "alice", targetLang: "Spanish" })
    expect(contextOf()).toMatchObject({ sourceLanguage: "English", targetLanguage: "Spanish" })
  })

  it("reads a lane tagged with its own id as its LANGUAGE, never the hex tag", async () => {
    await generateCellVoice({ project: laneProject, cell: makeCell("c1"), session, username: "alice", targetLang: "a3f09c1e" })
    expect(contextOf().targetLanguage).toBe("Portuguese")
  })

  it("an old project's default lane still speaks that lane's language", async () => {
    const old = {
      ...laneProject,
      lanes: [{ id: "swa00001", role: "target", language: "Swahili", name: null, langCode: null, legacyTag: "", position: 0, archivedAt: null }],
    } as unknown as ProjectRecord
    await generateCellVoice({ project: old, cell: makeCell("c1"), session, username: "alice" })
    expect(contextOf().targetLanguage).toBe("Swahili")
  })
})
