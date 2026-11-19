import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { DEFAULT_COMPLETION_MAX_TOKENS, DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"
import { useCompletion } from "./useCompletion"
import { encodeParagraphCells } from "@/lib/completion/paragraph-protocol"

vi.mock("@/lib/posthog", () => ({
  default: { scope() { return { ...this, enabled: () => true } }, capture: vi.fn(), captureException: vi.fn() },
}))
vi.mock("@/lib/completion/frontier-health", () => ({
  useFrontierHealth: () => ({ available: true }),
}))
vi.mock("@/lib/store/user-provider-override", () => ({
  getUserProviderOverride: () => null,
  useUserProviderOverride: () => null,
}))
vi.mock("@/lib/store/user-api-keys", () => ({
  resolveApiKey: (_: string, key: string | undefined) => key ?? null,
  useUserApiKey: () => undefined,
}))
vi.mock("@/lib/completion/batch-completion", () => ({
  resetBatchCompletionState: vi.fn(() => "run-1"),
  clearBatchCompletionProgress: vi.fn(),
  incrementBatchCompletionDone: vi.fn(),
  incrementBatchCompletionFailed: vi.fn(),
  isBatchCompletionCancelled: vi.fn(() => false),
  getBatchCompletionSignal: vi.fn(() => new AbortController().signal),
  cancelBatchCompletion: vi.fn(),
  // AQU-2654 additions to the store surface the hook now calls.
  finishBatchCompletion: vi.fn(),
  recordBatchCompletionDone: vi.fn(),
  recordBatchCompletionFailed: vi.fn(),
  noteBatchCompletionActivity: vi.fn(),
  registerBatchCompletionResumer: vi.fn(() => () => {}),
  getCurrentBatchRunId: vi.fn(() => "run-1"),
  getCompletionBatchProgress: vi.fn(() => null),
}))
vi.mock("@/lib/completion/compress-examples", () => ({
  compressExampleSource: (source: string) => source,
  dedupeExamples: (examples: unknown[]) => examples,
  dropPrecedingContextDuplicates: (examples: unknown[]) => examples,
  dropValidatedPairDuplicates: (examples: unknown[]) => examples,
}))

const SETTINGS: CompletionSettings = {
  provider: "custom",
  endpoint: "http://localhost:9999",
  model: "test-model",
  maxTokens: DEFAULT_COMPLETION_MAX_TOKENS,
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}
const SESSION: FrontierSession = {
  jwt: "jwt-test",
  username: "tester",
  createdAt: new Date().toISOString(),
}
const search = vi.fn().mockResolvedValue([])
const searchPassages = vi.fn().mockResolvedValue([])

// AQU-2539 — a Word line's inline marks through AI drafting, end to end
// through the hook: what the model is sent, and what is committed.

describe("useCompletion — Word lines with inline marks (AQU-2539)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  const wordCell = (id: string, original: string, originalHtml?: string) => ({
    id,
    fileId: "file-docx",
    original,
    ...(originalHtml ? { originalHtml } : {}),
    translated: "",
    status: "empty",
    metadata: {
      aquillaImport: {
        sourceLocator: { kind: "package-block", memberPath: "word/document.xml", blockPath: "w:p[2]", segment: 1 },
      },
    },
  })

  it("sends a marked line's marks and commits the marked translation (single)", async () => {
    const cell = wordCell("c1", "Term: the definition", "<b>Term:</b> the definition")
    const bodies: string[] = []
    mockCompletion("<b>Terme :</b> la définition", bodies)
    const commit = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion([cell], commit)
    await act(async () => {
      await result.current.completeSingle(cell as never)
    })
    const prompt = JSON.parse(bodies[0]!).messages.at(-1).content as string
    // The marks reach the model (masked by AQU-2385's tag protection, or as is).
    expect(prompt).not.toContain("Source: Term: the definition")
    expect(prompt).toMatch(/(<b>|\[#[^\]]+#\])Term:(<\/b>|\[#[^\]]+#\]) the definition/)
    expect(commit).toHaveBeenCalledWith(cell, "<b>Terme :</b> la définition", "test-model", expect.anything())
  })

  it("leaves a line without marks exactly as before (batch)", async () => {
    const cells = [wordCell("c1", "Plain line one"), wordCell("c2", "Plain line two")]
    const bodies: string[] = []
    mockCompletion("<v1>Ligne un</v1>\n<v2>Ligne deux</v2>", bodies)
    const commit = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(cells, commit)
    await act(async () => {
      await result.current.completeBatch(cells as never)
    })
    const prompt = JSON.parse(bodies[0]!).messages.at(-1).content as string
    expect(prompt).toContain("<v1>Plain line one</v1>")
    expect(commit.mock.calls.map((call) => call[1])).toEqual(["Ligne un", "Ligne deux"])
  })

  it("commits the plain words when the model breaks the marks (batch)", async () => {
    const cells = [wordCell("c1", "Term: def", "<b>Term:</b> def")]
    mockCompletion("<v1><b>Terme :</i> déf</v1>", [])
    const commit = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(cells, commit)
    await act(async () => {
      await result.current.completeBatch(cells as never)
    })
    const committed = commit.mock.calls.map((call) => call[1] as string)
    expect(committed).toHaveLength(1)
    expect(committed[0]).not.toMatch(/<\/?[bi]>/)
    expect(committed[0]).toContain("déf")
  })
})

describe("useCompletion — marked Word lines among others (AQU-2539)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })
  const wordCell = (id: string, original: string, originalHtml?: string, paragraphStart?: boolean) => ({
    id,
    fileId: "file-docx",
    original,
    ...(originalHtml ? { originalHtml } : {}),
    translated: "",
    status: "empty",
    ...(paragraphStart ? { paragraphStart: true } : {}),
    metadata: {
      aquillaImport: {
        sourceLocator: { kind: "package-block", memberPath: "word/document.xml", blockPath: `w:p[${id.slice(1)}]`, segment: 1 },
      },
    },
  })

  it("a mixed batch: marked lines get their HTML, plain lines exactly what they got before", async () => {
    const cells = [
      wordCell("c1", "Term: rule", "<b>Term:</b> rule"),
      wordCell("c2", "Plain line"),
      wordCell("c3", "Use <Ctrl> + C"),
    ]
    const bodies: string[] = []
    mockCompletion("<v1><b>Terme :</b> règle</v1>\n<v2>Ligne simple</v2>\n<v3>Utilisez <Ctrl> + C</v3>", bodies)
    const commit = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(cells, commit)
    await act(async () => {
      await result.current.completeBatch(cells as never)
    })
    const prompt = JSON.parse(bodies[0]!).messages.at(-1).content as string
    expect(prompt).toMatch(/<v1>(<b>|\[#[^\]]+#\])Term:/)
    expect(prompt).toContain("<v2>Plain line</v2>")
    expect(commit.mock.calls.map((call) => call[1])).toEqual(["<b>Terme :</b> règle", "Ligne simple", "Utilisez <Ctrl> + C"])
  })

  it("the paragraph path carries the marks too", async () => {
    const cells = [wordCell("c1", "Term: rule", "<b>Term:</b> rule", true), wordCell("c2", "Plain follow-up")]
    mockCompletion(encodeParagraphCells([{ cellId: "c1", text: "<b>Terme :</b> règle" }, { cellId: "c2", text: "Suite simple" }]), [])
    const commit = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(cells, commit)
    await act(async () => {
      await result.current.completeParagraph("c1")
    })
    expect(commit.mock.calls.map((call) => call[1]).sort()).toEqual(["<b>Terme :</b> règle", "Suite simple"])
  })
})

function renderCompletion(cells: unknown[], commit: ReturnType<typeof vi.fn>) {
  return renderHook(() => useCompletion(
    SETTINGS,
    "English",
    "French",
    search,
    searchPassages,
    SESSION,
    commit as never,
    [],
    cells as never,
    undefined,
    DEFAULT_DRAFT_CONTEXT,
    "",
  ))
}

function mockCompletion(content: string, bodies: string[]) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    bodies.push(init.body as string)
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content } }] }),
      body: null,
    })
  }))
}
