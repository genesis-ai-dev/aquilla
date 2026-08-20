// AQU-620: regression guard for the "regenerate" prediction path.
//
// Intent: a plain first draft uses the project's configured (low) temperature,
// while an explicit regenerate raises the sampling temperature so a second
// iteration varies instead of returning the same low-variance text. The
// regenerate reuses the normal commit path (last-write-wins replaces the draft;
// it does not stack a second draft).

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

describe("completeSingle regenerate (AQU-620)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    searchMock.mockClear()
  })

  it("a plain first draft uses the project's configured temperature", async () => {
    const bodies: string[] = []
    mockFetchCapturing(bodies)
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    await act(async () => {
      await result.current.completeSingle(CELL as never)
    })

    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0]).temperature).toBe(0.3)
  })

  it("an explicit regenerate raises the sampling temperature so the draft varies", async () => {
    const bodies: string[] = []
    mockFetchCapturing(bodies)
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    await act(async () => {
      await result.current.completeSingle(CELL as never, undefined, { regenerate: true })
    })

    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0]).temperature).toBe(0.8)
  })

  it("regenerate commits through the normal path (replaces the draft, does not stack)", async () => {
    const bodies: string[] = []
    mockFetchCapturing(bodies)
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    await act(async () => {
      await result.current.completeSingle(CELL as never, undefined, { regenerate: true })
    })

    // One commit per regenerate — the cell store applies last-write-wins, so the
    // suggestion is replaced rather than a second draft accumulated.
    expect(commitMock).toHaveBeenCalledTimes(1)
    expect(commitMock.mock.calls[0][0]).toMatchObject({ id: "cell-1" })
    // Author + provenance stay the standard single-cell draft shape.
    expect(commitMock.mock.calls[0][2]).toBe("test-model")
    expect(commitMock.mock.calls[0][3]).toMatchObject({ model: "test-model", provider: "custom", mode: "single" })
  })

  it("never lowers an already-hotter configured temperature on regenerate", async () => {
    const bodies: string[] = []
    mockFetchCapturing(bodies)
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useCompletion(
        { ...SETTINGS, temperature: 0.95 }, "English", "French",
        searchMock, searchPassagesMock,
        SESSION, commitMock as never, [],
        [CELL] as never, undefined, DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeSingle(CELL as never, undefined, { regenerate: true })
    })

    expect(JSON.parse(bodies[0]).temperature).toBe(0.95)
  })

  it("re-checks the ownership guard after generation and before commit", async () => {
    const bodies: string[] = []
    mockFetchCapturing(bodies)
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    let stillEligible = true
    await act(async () => {
      const promise = result.current.completeSingle(CELL as never, undefined, {
        mode: "read",
        commitGuard: () => stillEligible,
      })
      stillEligible = false
      expect(await promise).toBe(false)
    })

    expect(bodies).toHaveLength(1)
    expect(commitMock).not.toHaveBeenCalled()
  })

  it("records translate-as-read evidence in the committed provenance", async () => {
    const bodies: string[] = []
    mockFetchCapturing(bodies)
    searchMock.mockResolvedValueOnce([{
      cellId: "example-1",
      fileId: "file-a",
      source: "Verse one",
      target: "Verset un",
      score: 1,
      matchedTokens: ["verse", "one"],
      coverageWeight: 1,
    }])
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    await act(async () => {
      await result.current.completeSingle(CELL as never, undefined, { mode: "read" })
    })

    expect(commitMock.mock.calls[0][3]).toMatchObject({
      mode: "read",
      exampleIds: ["example-1"],
      projectState: {
        approvedExampleCount: 1,
        evidenceCoverage: 2 / 3,
        evidenceWeight: 0.2,
      },
    })
  })
})
