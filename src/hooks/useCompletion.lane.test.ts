// AQU-1025: the examples chip is session state keyed by cell id. Source cells
// share that id across lanes, so switching Spanish → French kept showing the
// previous lane's pairs until the next sparkle. Retrieval is already
// lane-scoped; this guards the chip (and switch-back).

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
}))
vi.mock("@/lib/store/user-api-keys", () => ({
  resolveApiKey: (_: string, key: string | undefined) => key ?? null,
}))
vi.mock("@/lib/completion/batch-completion", () => ({
  resetBatchCompletionState: vi.fn(() => "run-1"),
  clearBatchCompletionProgress: vi.fn(),
  incrementBatchCompletionDone: vi.fn(),
  isBatchCompletionCancelled: vi.fn(() => false),
  getBatchCompletionSignal: vi.fn(() => new AbortController().signal),
  cancelBatchCompletion: vi.fn(),
}))
vi.mock("@/lib/completion/compress-examples", () => ({
  compressExampleSource: (src: string) => src,
  dedupeExamples: (exs: unknown[]) => exs,
  dropPrecedingContextDuplicates: (exs: unknown[]) => exs,
  dropValidatedPairDuplicates: (exs: unknown[]) => exs,
}))

import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { renderHook, act } from "@testing-library/react"
import {
  sliceCompletionLaneMap,
  useCompletion,
} from "./useCompletion"
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
  original: "God called the light Day",
  translated: "",
  status: "draft",
}

const SPANISH_PAIR = {
  cellId: "ex-es",
  fileId: "file-a",
  source: "God called the light Day",
  target: "Dios llamó a la luz Día",
  score: 1,
  matchedTokens: [] as string[],
  coverageWeight: 1,
}

const searchMock = vi.fn()
const searchPassagesMock = vi.fn().mockResolvedValue([])

function mockFetchOk() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "A translation" } }] }),
      body: null,
    }),
  )
}

describe("sliceCompletionLaneMap", () => {
  it("returns only the requested lane's cell ids", () => {
    const store = new Map<string, string>([
      ["cell-1\u0000", "spanish"],
      ["cell-1\u0000French", "french"],
    ])
    expect(sliceCompletionLaneMap(store, "").get("cell-1")).toBe("spanish")
    expect(sliceCompletionLaneMap(store, "French").get("cell-1")).toBe("french")
    expect(sliceCompletionLaneMap(store, "French").has("cell-1\u0000")).toBe(false)
  })
})

describe("useCompletion examples are lane-scoped (AQU-1025)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    searchMock.mockReset()
    searchMock.mockResolvedValue([SPANISH_PAIR])
  })

  it("hides the previous lane's examples on switch and restores them on switch-back", async () => {
    mockFetchOk()
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result, rerender } = renderHook(
      ({ lane }: { lane: string }) =>
        useCompletion(
          SETTINGS, "English", "Spanish",
          searchMock, searchPassagesMock,
          SESSION, commitMock as never, [],
          [CELL] as never, undefined, DEFAULT_DRAFT_CONTEXT, lane,
        ),
      { initialProps: { lane: "" } },
    )

    await act(async () => {
      await result.current.completeSingle(CELL as never)
    })
    expect(result.current.examples.get("cell-1")?.map((e) => e.target)).toEqual([
      SPANISH_PAIR.target,
    ])

    rerender({ lane: "French" })
    expect(result.current.examples.get("cell-1")).toBeUndefined()

    rerender({ lane: "" })
    expect(result.current.examples.get("cell-1")?.map((e) => e.target)).toEqual([
      SPANISH_PAIR.target,
    ])
  })
})
