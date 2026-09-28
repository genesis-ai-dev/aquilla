// AQU-153: regression guard for the per-cell example count.
//
// Symptom (2026-06-04 walkthrough): the first draft in a brand-new project
// reported that it "used 5 examples" although nothing in the project had been
// translated yet. Branching search ranks SOURCE cells, so an untranslated cell
// is a legitimate retrieval hit — it just is not a translation example, because
// there is no target for the model to imitate. The evidence surfaces counted
// raw hits, so they over-reported whenever the retriever handed back unpaired
// cells.
//
// The rule these tests pin: a hit becomes an example only once it carries a
// real source→target pair, in the single-cell path AND the batch path, and the
// committed provenance count agrees with what the editor shows.

import { describe, it, expect, vi, beforeEach } from "vitest"

interface MinimalCell {
  id: string
  fileId: string
  original: string
  translated: string
  status: string
}

vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn(), captureException: vi.fn() } }))
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
  isBatchCompletionCancelled: vi.fn(() => false),
  getBatchCompletionSignal: vi.fn(() => new AbortController().signal),
  cancelBatchCompletion: vi.fn(),
}))

import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { renderHook, act } from "@testing-library/react"
import { useCompletion } from "./useCompletion"
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"

const SESSION: FrontierSession = {
  jwt: "jwt-test",
  username: "tester",
  createdAt: new Date().toISOString(),
}

const SETTINGS: CompletionSettings = {
  provider: "custom",
  endpoint: "http://localhost:9999",
  model: "test-model",
  maxTokens: 512,
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

const CELL: MinimalCell = {
  id: "cell-1",
  fileId: "file-a",
  original: "In the beginning God created",
  translated: "",
  status: "draft",
}

const searchMock = vi.fn().mockResolvedValue([])
const searchPassagesMock = vi.fn().mockResolvedValue([])

function hit(cellId: string, source: string, target: string) {
  return { cellId, fileId: "file-a", source, target, score: 1, matchedTokens: ["beginning"], coverageWeight: 1 }
}

function mockFetchReturning(content = "Au commencement") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content } }] }),
        body: null,
      }),
    ),
  )
}

function renderCompletion(commitMock: ReturnType<typeof vi.fn>, cells: MinimalCell[] = [CELL]) {
  return renderHook(() =>
    useCompletion(
      SETTINGS, "English", "French",
      searchMock, searchPassagesMock,
      SESSION, commitMock as never, [],
      cells as never, undefined, DEFAULT_DRAFT_CONTEXT,
    ),
  )
}

describe("example evidence requires a real source→target pair (AQU-153)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    searchMock.mockReset()
    searchMock.mockResolvedValue([])
    searchPassagesMock.mockReset()
    searchPassagesMock.mockResolvedValue([])
  })

  it("reports no examples when every retrieval hit is an untranslated source cell", async () => {
    mockFetchReturning()
    // A brand-new project: the source is imported, so the query matches, but
    // nothing has been translated — every hit comes back with an empty target.
    searchMock.mockResolvedValue([
      hit("c1", "In the beginning", ""),
      hit("c2", "God created the heavens", ""),
      hit("c3", "And the earth was formless", ""),
      hit("c4", "Darkness was over the deep", ""),
      hit("c5", "And God said", ""),
    ])
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    await act(async () => {
      await result.current.completeSingle(CELL as never)
    })

    // The editor's per-cell evidence panel counts this map — it used to show
    // "5 examples" here.
    expect(result.current.examples.get("cell-1") ?? []).toEqual([])
    expect(commitMock.mock.calls[0][3]).toMatchObject({
      exampleIds: [],
      projectState: { approvedExampleCount: 0 },
    })
  })

  it("keeps the genuinely paired hits and drops the unpaired ones alongside them", async () => {
    mockFetchReturning()
    searchMock.mockResolvedValue([
      hit("paired", "In the beginning", "Au commencement"),
      hit("unpaired", "God created the heavens", ""),
      hit("blank-target", "And the earth was formless", "   "),
    ])
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    await act(async () => {
      await result.current.completeSingle(CELL as never)
    })

    expect((result.current.examples.get("cell-1") ?? []).map((e) => e.cellId)).toEqual(["paired"])
    expect(commitMock.mock.calls[0][3]).toMatchObject({
      exampleIds: ["paired"],
      projectState: { approvedExampleCount: 1 },
    })
  })

  it("applies the same pair requirement to the batch path's passage hits", async () => {
    mockFetchReturning("<v1>Au commencement</v1>")
    searchPassagesMock.mockResolvedValue([
      {
        fileId: "file-a",
        cells: [
          { cellId: "p-unpaired", source: "God created the heavens", target: "", hit: true },
          { cellId: "p-paired", source: "In the beginning", target: "Au commencement", hit: true },
        ],
      },
    ])
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    await act(async () => {
      await result.current.completeBatch([CELL] as never)
    })

    expect((result.current.examples.get("cell-1") ?? []).map((e) => e.cellId)).toEqual(["p-paired"])
  })
})
