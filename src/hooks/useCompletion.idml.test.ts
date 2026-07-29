import JSZip from "jszip"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  parseIdml,
  renderIdmlUnitHtml,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { DEFAULT_COMPLETION_MAX_TOKENS, DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"
import { useCompletion } from "./useCompletion"

vi.mock("@/lib/posthog", () => ({
  default: { capture: vi.fn(), captureException: vi.fn() },
}))
vi.mock("@/lib/completion/frontier-health", () => ({
  useFrontierHealth: () => ({ available: true }),
}))
vi.mock("@/lib/store/user-provider-override", () => ({
  getUserProviderOverride: () => null,
}))
vi.mock("@/lib/store/user-api-keys", () => ({
  resolveApiKey: (_: string, key: string | undefined) => key ?? null,
}))
vi.mock("@/lib/completion/batch-completion", () => ({
  resetBatchCompletionState: vi.fn(() => "run-1"),
  clearBatchCompletionProgress: vi.fn(),
  incrementBatchCompletionDone: vi.fn(),
  incrementBatchCompletionFailed: vi.fn(),
  isBatchCompletionCancelled: vi.fn(() => false),
  getBatchCompletionSignal: vi.fn(() => new AbortController().signal),
  cancelBatchCompletion: vi.fn(),
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

describe("useCompletion IDML protected-output boundary", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("prompts with canonical anchors and commits only an exact protected response", async () => {
    const unit = await parsedUnit()
    const cell = completionCell(unit)
    const targetHtml = renderIdmlUnitHtml({
      ...unit,
      slots: unit.slots.map((slot, index) => ({
        ...slot,
        text: index === 0 ? "Bon" : "JOUR",
      })),
    })
    const bodies: string[] = []
    mockCompletion(targetHtml, bodies)
    const commit = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(cell, commit)

    let saved = false
    await act(async () => {
      saved = await result.current.completeSingle(cell as never)
    })

    expect(saved).toBe(true)
    expect(commit).toHaveBeenCalledWith(
      cell,
      targetHtml,
      "test-model",
      expect.objectContaining({ mode: "single" }),
    )
    const request = JSON.parse(bodies[0]!) as {
      messages: Array<{ role: string; content: string }>
      max_tokens: number
    }
    expect(request.max_tokens).toBe(DEFAULT_COMPLETION_MAX_TOKENS)
    expect(request.messages[0]?.content).toContain("IDML protected-anchor output contract")
    expect(request.messages.at(-1)?.content).toContain(unit.sourceHtml)
  })

  it("rejects a model response that drops anchors and never calls persistence", async () => {
    const unit = await parsedUnit()
    const cell = completionCell(unit)
    mockCompletion("plain translation", [])
    const commit = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(cell, commit)

    let saved = true
    await act(async () => {
      saved = await result.current.completeSingle(cell as never)
    })

    expect(saved).toBe(false)
    expect(commit).not.toHaveBeenCalled()
    expect(result.current.errors.get(cell.id)).toMatch(/protected IDML anchor/i)
  })
})

function renderCompletion(cell: ReturnType<typeof completionCell>, commit: ReturnType<typeof vi.fn>) {
  return renderHook(() => useCompletion(
    SETTINGS,
    "English",
    "French",
    search,
    searchPassages,
    SESSION,
    commit as never,
    [],
    [cell] as never,
    undefined,
    DEFAULT_DRAFT_CONTEXT,
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

function completionCell(unit: IdmlTranslationUnit) {
  return {
    id: unit.id,
    fileId: "file-idml",
    original: unit.sourceText,
    originalHtml: unit.sourceHtml,
    translated: "",
    translatedHtml: renderIdmlUnitHtml({
      ...unit,
      slots: unit.slots.map((slot) => ({ ...slot, text: slot.editable ? "" : slot.text })),
    }),
    status: "empty",
    metadata: { idml: unit.metadata },
  }
}

async function parsedUnit(): Promise<IdmlTranslationUnit> {
  const mime = "application/vnd.adobe.indesign-idml-package"
  const namespace = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'
  const storyPath = "Stories/Story_u100.xml"
  const zip = new JSZip()
  zip.file("mimetype", mime, { compression: "STORE", createFolders: false })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0"?><Document ${namespace}><idPkg:Story src="${storyPath}"/></Document>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    storyPath,
    [
      `<?xml version="1.0"?><idPkg:Story ${namespace}><Story Self="u100">`,
      '<ParagraphStyleRange Self="mixed" AppliedParagraphStyle="ParagraphStyle/Body">',
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>Hello</Content></CharacterStyleRange>',
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Bold"><Content>WORLD</Content></CharacterStyleRange>',
      "</ParagraphStyleRange></Story></idPkg:Story>",
    ].join(""),
    { compression: "DEFLATE", createFolders: false },
  )
  const parsed = await parseIdml(await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  }))
  const unit = parsed.units[0]
  if (!unit) throw new Error("Missing IDML completion fixture unit")
  return unit
}
