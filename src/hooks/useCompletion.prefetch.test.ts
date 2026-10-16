// AQU-617: focus-time few-shot prefetch.
//
// Intent: retrieval is the one round trip a draft waits on before generation
// can start, so the editor starts it when an empty cell is focused and the
// Draft click reuses that in-flight result instead of searching again. The
// reuse must be exact and one-shot: a different source text gets its own
// search, and a second draft (regenerate) retrieves fresh rather than replaying
// a stale result.

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
vi.mock("@/lib/completion/compress-examples", () => ({
  compressExampleSource: (src: string) => src,
  dedupeExamples: (exs: unknown[]) => exs,
  dropPrecedingContextDuplicates: (exs: unknown[]) => exs,
  // AQU-617 added this to completeSingle's example pipeline; the mock must
  // provide it or completeSingle throws before ever calling the model.
  // The hook imports this too (AQU-617) — the mock shadows the real module,
  // so omitting it made completeSingle throw before fetch and every test in
  // this file fail on empty `bodies`.
  dropValidatedPairDuplicates: (exs: unknown[]) => exs,
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

// Configured (low) first-draft temperature, so the contrast with the raised
// regenerate temperature is unambiguous.
const SETTINGS: CompletionSettings = {
  provider: "custom",
  endpoint: "http://localhost:9999",
  model: "test-model",
  maxTokens: 512,
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

const CELL: MinimalCell = { id: "cell-1", fileId: "file-a", original: "Verse one source", translated: "", status: "draft" }

const searchMock = vi.fn().mockResolvedValue([])
const searchPassagesMock = vi.fn().mockResolvedValue([])

// Capture every outgoing request body so we can inspect the temperature sent to
// the provider. res.body:null makes complete() fall through to res.json().
function mockFetchCapturing(bodies: string[], content = "A translation") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      bodies.push(init.body as string)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content } }] }),
        body: null,
      })
    }),
  )
}

function renderCompletion(commitMock: ReturnType<typeof vi.fn>) {
  return renderHook(() =>
    useCompletion(
      SETTINGS, "English", "French",
      searchMock, searchPassagesMock,
      SESSION, commitMock as never, [],
      [CELL] as never, undefined, DEFAULT_DRAFT_CONTEXT,
    ),
  )
}

describe("completeSingle with a focus-time prefetch (AQU-617)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    searchMock.mockClear()
  })

  it("a draft right after focus reuses the prefetched search instead of searching again", async () => {
    mockFetchCapturing([])
    const { result } = renderCompletion(vi.fn().mockResolvedValue(undefined))

    act(() => result.current.prefetchSingleEvidence(CELL as never))
    expect(searchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      await result.current.completeSingle(CELL as never)
    })

    expect(searchMock).toHaveBeenCalledTimes(1)
  })

  it("the prefetch is used once: a second draft of the same cell searches fresh", async () => {
    mockFetchCapturing([])
    const { result } = renderCompletion(vi.fn().mockResolvedValue(undefined))

    act(() => result.current.prefetchSingleEvidence(CELL as never))
    await act(async () => {
      await result.current.completeSingle(CELL as never)
    })
    await act(async () => {
      await result.current.completeSingle(CELL as never, undefined, { regenerate: true })
    })

    expect(searchMock).toHaveBeenCalledTimes(2)
  })

  it("a prefetch for different source text is not reused", async () => {
    mockFetchCapturing([])
    const { result } = renderCompletion(vi.fn().mockResolvedValue(undefined))

    act(() => result.current.prefetchSingleEvidence({ ...CELL, original: "An earlier source" } as never))
    await act(async () => {
      await result.current.completeSingle(CELL as never)
    })

    expect(searchMock).toHaveBeenCalledTimes(2)
    expect(searchMock.mock.calls[1][0]).toBe("Verse one source")
  })
})
