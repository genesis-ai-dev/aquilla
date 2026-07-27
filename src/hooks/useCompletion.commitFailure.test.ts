// AQU-670: regression guard for a failed AI single-cell draft commit.
//
// Intent: when the outbox enqueue behind commitCompletedCell fails, the AI
// completion path must NOT report success. completeSingle resolves `false`
// (the sparkle flow reads this to gate its "Saved" confirmation) and records
// the failure in the per-cell `errors` map so the translator sees it went
// wrong. A successful draft still resolves `true`. The optimistic-text revert
// itself lives in commitCompletedCell (ProjectWorkspace) — this guards the
// hook-level success/failure signal that the revert and the "Saved" gate hang
// off of.

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
  incrementBatchCompletionFailed: vi.fn(),
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

const CELL: MinimalCell = { id: "cell-1", fileId: "file-a", original: "Verse one source", translated: "", status: "draft" }

const searchMock = vi.fn().mockResolvedValue([])
const searchPassagesMock = vi.fn().mockResolvedValue([])

function mockFetchOk(content = "A translation") {
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

describe("completeSingle commit failure (AQU-670)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("resolves false and records the error when the commit (outbox enqueue) fails", async () => {
    mockFetchOk()
    // commitCompletedCell rethrows after reverting its optimistic patch when the
    // enqueue fails — model this by rejecting.
    const commitMock = vi.fn().mockRejectedValue(new Error("enqueue failed"))
    const { result } = renderCompletion(commitMock)

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await result.current.completeSingle(CELL as never)
    })

    // The prediction reached the commit path...
    expect(commitMock).toHaveBeenCalledTimes(1)
    // ...but the draft did not save: report failure, not success.
    expect(outcome).toBe(false)
    // The failure is legible per-cell (drives the inline error line).
    expect(result.current.errors.get("cell-1")).toBeTruthy()
  })

  it("resolves true and records no error on a successful draft (happy path)", async () => {
    mockFetchOk()
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await result.current.completeSingle(CELL as never)
    })

    expect(commitMock).toHaveBeenCalledTimes(1)
    expect(outcome).toBe(true)
    expect(result.current.errors.get("cell-1")).toBeUndefined()
  })
})
