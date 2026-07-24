// Regression guard for the "Saved but empty" sparkle bug.
//
// A source cell carrying a USFM footnote made the model return an empty
// completion (the old prompt embedded footnote instructions inside `Source:`,
// contradicting the system prompt's "final source line only" rule), and
// completeSingle committed that empty string and resolved `true` — so the
// sparkle flow showed "Saved" over an empty target. This file pins the fixed
// contract at the level where the bug escaped (the hook), with only fetch
// stubbed:
//   - an empty/whitespace model result is NEVER committed; completeSingle
//     resolves false and records a per-cell error (D11 never-commit-empty);
//   - a footnoted cell's well-shaped reply is committed with real \f...\f*
//     markers rebuilt from the model's [n] lines — not [n] placeholder text;
//   - a footnote reply with no translated base counts as empty;
//   - the request keeps instructions out of the `Source:` payload (they ride
//     in the system prompt).

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
import { createUsfmFootnoteMarker } from "@/lib/footnotes/insert"
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

const PLAIN_CELL: MinimalCell = { id: "cell-1", fileId: "file-a", original: "Verse one source", translated: "", status: "draft" }
const FOOTNOTE_CELL: MinimalCell = {
  id: "cell-1",
  fileId: "file-a",
  original: `Base${createUsfmFootnoteMarker({ text: "source note" })} text.`,
  translated: "",
  status: "draft",
}

const searchMock = vi.fn().mockResolvedValue([])
const searchPassagesMock = vi.fn().mockResolvedValue([])

function mockFetchOk(content: string) {
  const fetchMock = vi.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content } }] }),
      body: null,
    }),
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function renderCompletion(commitMock: ReturnType<typeof vi.fn>, cell: MinimalCell) {
  return renderHook(() =>
    useCompletion(
      SETTINGS, "English", "French",
      searchMock, searchPassagesMock,
      SESSION, commitMock as never, [],
      [cell] as never, undefined, DEFAULT_DRAFT_CONTEXT,
    ),
  )
}

describe("completeSingle never commits an empty draft (D11)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("resolves false, skips the commit, and records an error when the model returns nothing", async () => {
    mockFetchOk("")
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, PLAIN_CELL)

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await result.current.completeSingle(PLAIN_CELL as never)
    })

    expect(outcome).toBe(false)
    expect(commitMock).not.toHaveBeenCalled()
    expect(result.current.errors.get("cell-1")).toBeTruthy()
  })

  it("treats a whitespace-only result as empty", async () => {
    mockFetchOk("  \n  ")
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, PLAIN_CELL)

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await result.current.completeSingle(PLAIN_CELL as never)
    })

    expect(outcome).toBe(false)
    expect(commitMock).not.toHaveBeenCalled()
  })
})

describe("completeSingle on a footnoted source cell", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("commits the reply with real \\f...\\f* markers rebuilt from the model's [n] lines", async () => {
    const fetchMock = mockFetchOk("Translated base [1] rest.\n[1] translated note")
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, FOOTNOTE_CELL)

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await result.current.completeSingle(FOOTNOTE_CELL as never)
    })

    expect(outcome).toBe(true)
    expect(commitMock).toHaveBeenCalledTimes(1)
    const committedText = commitMock.mock.calls[0][1] as string
    expect(committedText).toBe("Translated base \\f + \\ft translated note\\f* rest.")
    expect(committedText).not.toContain("[1]")

    // Prompt-shape regression at the request boundary: the raw marker is
    // decomposed, the live Source: line is just the base text, and the
    // footnote output contract rides in the system prompt — not inside the
    // Source: payload, where it used to contradict the "final source line
    // only" rule and make the model emit nothing.
    const requestInit = fetchMock.mock.calls[0][1] as { body: string }
    const body = JSON.parse(requestInit.body) as { messages: { role: string; content: string }[] }
    const sys = body.messages[0]
    const user = body.messages[body.messages.length - 1]
    expect(sys.content).toContain("Footnote output")
    expect(user.content).not.toContain("\\f")
    expect(user.content.endsWith("Source: Base[1] text.\nTranslation:")).toBe(true)
    expect(user.content).toContain("Source footnotes for the [n] markers")
  })

  it("treats a reply with only [n] lines and no translated base as empty — no commit, no 'Saved'", async () => {
    mockFetchOk("[1] translated note")
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, FOOTNOTE_CELL)

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await result.current.completeSingle(FOOTNOTE_CELL as never)
    })

    expect(outcome).toBe(false)
    expect(commitMock).not.toHaveBeenCalled()
    expect(result.current.errors.get("cell-1")).toBeTruthy()
  })
})
