// AQU-685: regression guard for the "silent no-show" prediction failure.
//
// Intent: when a single-cell completion succeeds at the HTTP level but the
// model returns no content (empty/whitespace body, or a streamed 200 that
// carried only an error/usage frame), the hook must NOT commit an empty draft
// and silently clear the spinner. Instead it surfaces the failure — the cell's
// `completing` entry becomes "error" and an `errors` message is set — so the UI
// renders a visible error instead of a blank cell.

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
// NB: compress-examples is intentionally NOT mocked — the real module is cheap
// and deterministic on the empty example set these tests use. (A partial mock
// that omits an export makes completeSingle throw for an unrelated reason and
// masks what we're actually guarding here.)

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

// res.body:null makes complete() fall through to res.json(); `content` drives
// what the model "returns". body:null path returns content.trim() || "".
function mockFetchReturning(content: string) {
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

describe("completeSingle empty-result handling (AQU-685)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("does not commit an empty draft and marks the cell as errored when the model returns nothing", async () => {
    mockFetchReturning("")
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    await act(async () => {
      await result.current.completeSingle(CELL as never)
    })

    // The empty completion must never be persisted as a translation…
    expect(commitMock).not.toHaveBeenCalled()
    // …and the failure is surfaced visibly rather than silently cleared.
    expect(result.current.completing.get("cell-1")).toBe("error")
    expect(result.current.errors.get("cell-1")).toBeTruthy()
  })

  it("treats a whitespace-only completion as a failure (no blank draft committed)", async () => {
    mockFetchReturning("   \n  ")
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    await act(async () => {
      await result.current.completeSingle(CELL as never)
    })

    expect(commitMock).not.toHaveBeenCalled()
    expect(result.current.completing.get("cell-1")).toBe("error")
  })

  it("commits normally and sets no error when the model returns real content", async () => {
    mockFetchReturning("Une traduction")
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    await act(async () => {
      await result.current.completeSingle(CELL as never)
    })

    expect(commitMock).toHaveBeenCalledTimes(1)
    expect(commitMock.mock.calls[0][1]).toBe("Une traduction")
    expect(result.current.completing.get("cell-1")).toBeUndefined()
    expect(result.current.errors.get("cell-1")).toBeUndefined()
  })
})
