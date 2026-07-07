// FRO-361: completeBatch must not silently halt the whole run when one
// sub-batch (chunk) fails. Encodes the INTENT already stated in the code
// comments (a failing sub-batch "should not break the batch as a whole")
// but that the implementation violated: a non-abort error from complete()
// caused an early `return`, abandoning every subsequent chunk with no
// surfaced summary.
//
// Repro shape: 90 cells / MAX_CELLS_PER_CALL=30 → chunks [1-30],[31-60],[61-90].
// Chunk 2 (cells 31-60) rejects. Chunks 1 and 3 must still run, and the
// end-of-run progress must report the failure count instead of just
// disappearing.

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

vi.mock("@/lib/completion/compress-examples", () => ({
  compressExampleSource: (src: string) => src,
  dedupeExamples: (exs: unknown[]) => exs,
  dropPrecedingContextDuplicates: (exs: unknown[]) => exs,
}))

// Deliberately NOT mocking @/lib/completion/batch-completion — this test
// asserts against the REAL progress store so we catch a silent early exit.

import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { renderHook, act } from "@testing-library/react"
import { useCompletion } from "./useCompletion"
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import {
  getCompletionBatchProgress,
  clearBatchCompletionProgress,
} from "@/lib/completion/batch-completion"

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
  temperature: 0.0,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

function makeCell(id: string, fileId: string, original: string): MinimalCell {
  return { id, fileId, original, translated: "", status: "draft" }
}

const FILE_A = "file-a"

// 90 cells → 3 chunks of 30 under MAX_CELLS_PER_CALL.
const NINETY_CELLS: MinimalCell[] = Array.from({ length: 90 }, (_, i) =>
  makeCell(`cell-${i + 1}`, FILE_A, `Source sentence ${i + 1}`),
)

const searchMock = vi.fn().mockResolvedValue([])
const searchPassagesMock = vi.fn().mockResolvedValue([])

function encodeChunkResponse(chunk: MinimalCell[]): string {
  return chunk.map((_, i) => `<v${i + 1}>Translated ${i + 1}</v${i + 1}>`).join("\n")
}

describe("completeBatch — mid-run sub-batch failure (FRO-361)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearBatchCompletionProgress()
  })

  it("continues to chunk 3 after chunk 2 rejects, and reports a failure summary instead of stopping silently", async () => {
    // Match on the request body's cell count/content isn't practical here
    // (buildBatchPrompt renders a full prompt), so key off which cells'
    // source text appears in the request body to identify the chunk,
    // regardless of how many attempts (incl. retries) each chunk consumes.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? init.body : ""
        // Chunk 2 (cells 31-60) always fails — both the original attempt and
        // the one retry — to exercise the "retried twice, still failed, skip
        // and continue" path.
        if (body.includes("Source sentence 31")) {
          return Promise.resolve({ ok: false, status: 500, statusText: "Internal Server Error", text: () => Promise.resolve("boom") })
        }
        const chunkIndex = body.includes("Source sentence 61") ? 2 : 0
        const chunk = NINETY_CELLS.slice(chunkIndex * 30, chunkIndex * 30 + 30)
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: encodeChunkResponse(chunk) } }] }),
          body: null,
        })
      }),
    )

    const commitMock = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS,
        "English",
        "French",
        searchMock,
        searchPassagesMock,
        SESSION,
        commitMock,
        [],
        NINETY_CELLS as never,
        undefined,
        DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeBatch(NINETY_CELLS as never)
    })

    // Chunk 1 (30 cells) and chunk 3 (30 cells) must have committed despite
    // chunk 2 failing — the whole run must NOT have halted after chunk 1.
    const committedIds = new Set(commitMock.mock.calls.map((args: unknown[]) => (args[0] as MinimalCell).id))
    for (let i = 1; i <= 30; i++) expect(committedIds.has(`cell-${i}`)).toBe(true)
    for (let i = 61; i <= 90; i++) expect(committedIds.has(`cell-${i}`)).toBe(true)
    expect(commitMock).toHaveBeenCalledTimes(60)

    // Chunk 2's cells must be flagged as errored, not silently dropped.
    for (let i = 31; i <= 60; i++) {
      expect(result.current.errors.has(`cell-${i}`)).toBe(true)
    }

    // The run must surface an honest end-of-run summary (not silently
    // disappear as if everything succeeded).
    const finalProgress = getCompletionBatchProgress()
    expect(finalProgress).not.toBeNull()
    expect(finalProgress?.total).toBe(90)
    expect(finalProgress?.done).toBe(60)
    expect(finalProgress?.failed).toBe(30)
    expect(finalProgress?.finished).toBe(true)
  })
})
