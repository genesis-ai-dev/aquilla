// AQU-361: completeBatch must not silently halt the whole run when one
// sub-batch (chunk) fails. Encodes the INTENT already stated in the code
// comments (a failing sub-batch "should not break the batch as a whole")
// but that the implementation violated: a non-abort error from complete()
// caused an early `return`, abandoning every subsequent chunk with no
// surfaced summary.
//
// Repro shape: 30 cells / research-aligned package size 10 → chunks
// [1-10],[11-20],[21-30]. Chunk 2 rejects. Chunks 1 and 3 must still run, and the
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
  // Needed by the per-cell fallback path (completeSingle) exercised below.
  dropValidatedPairDuplicates: (exs: unknown[]) => exs,
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

const THIRTY_CELLS: MinimalCell[] = Array.from({ length: 30 }, (_, i) =>
  makeCell(`cell-${i + 1}`, FILE_A, `Source sentence ${i + 1}`),
)

const searchMock = vi.fn().mockResolvedValue([])
const searchPassagesMock = vi.fn().mockResolvedValue([])

function encodeChunkResponse(chunk: MinimalCell[]): string {
  return chunk.map((_, i) => `<v${i + 1}>Translated ${i + 1}</v${i + 1}>`).join("\n")
}

describe("completeBatch — mid-run sub-batch failure (AQU-361)", () => {
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
        // Chunk 2 (cells 11-20) always fails — both the original attempt and
        // the one retry — to exercise the "retried twice, still failed, skip
        // and continue" path.
        if (body.includes("Source sentence 11")) {
          return Promise.resolve({ ok: false, status: 500, statusText: "Internal Server Error", text: () => Promise.resolve("boom") })
        }
        const chunkIndex = body.includes("Source sentence 21") ? 2 : 0
        const chunk = THIRTY_CELLS.slice(chunkIndex * 10, chunkIndex * 10 + 10)
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
        THIRTY_CELLS as never,
        undefined,
        DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeBatch(THIRTY_CELLS as never)
    })

    // Chunk 1 and chunk 3 must have committed despite
    // chunk 2 failing — the whole run must NOT have halted after chunk 1.
    const committedIds = new Set(commitMock.mock.calls.map((args: unknown[]) => (args[0] as MinimalCell).id))
    for (let i = 1; i <= 10; i++) expect(committedIds.has(`cell-${i}`)).toBe(true)
    for (let i = 21; i <= 30; i++) expect(committedIds.has(`cell-${i}`)).toBe(true)
    expect(commitMock).toHaveBeenCalledTimes(20)

    // Chunk 2's cells must be flagged as errored, not silently dropped.
    for (let i = 11; i <= 20; i++) {
      expect(result.current.errors.has(`cell-${i}`)).toBe(true)
    }

    // The run must surface an honest end-of-run summary (not silently
    // disappear as if everything succeeded).
    const finalProgress = getCompletionBatchProgress()
    expect(finalProgress).not.toBeNull()
    expect(finalProgress?.total).toBe(30)
    expect(finalProgress?.done).toBe(20)
    expect(finalProgress?.failed).toBe(10)
    expect(finalProgress?.finished).toBe(true)
  })
})

// D11 never-commit-empty, batch edition: a present-but-empty <vN></vN> is "no
// emitted content" just like a missing tag. It must fall through to the
// per-cell fallback rather than committing an empty draft — and when the
// fallback ALSO yields nothing, the cell ends errored and the run summary
// counts it failed, not done (the batch cousin of the sparkle "Saved but
// empty" bug).
describe("completeBatch — empty <vN> is never committed", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearBatchCompletionProgress()
  })

  it("routes an empty tag to the single-cell fallback and counts a doubly-empty cell as failed", async () => {
    const cells = [1, 2, 3].map((i) => makeCell(`cell-${i}`, FILE_A, `Source sentence ${i}`))
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? init.body : ""
        // The batch request frames cells as <vN>; cell 2 comes back empty.
        // The subsequent single-cell fallback request (no <v1> framing) for
        // cell 2 returns nothing as well.
        const content = body.includes("<v1>")
          ? "<v1>Translated 1</v1>\n<v2></v2>\n<v3>Translated 3</v3>"
          : ""
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content } }] }),
          body: null,
        })
      }),
    )

    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS, "English", "French",
        searchMock, searchPassagesMock,
        SESSION, commitMock, [],
        cells as never, undefined, DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeBatch(cells as never)
    })

    // Cells 1 and 3 commit; cell 2 must never be committed with "".
    const committedIds = commitMock.mock.calls.map((args: unknown[]) => (args[0] as MinimalCell).id)
    expect(committedIds.sort()).toEqual(["cell-1", "cell-3"])
    // The empty cell is flagged, and the summary counts it failed — not done.
    expect(result.current.errors.has("cell-2")).toBe(true)
    const finalProgress = getCompletionBatchProgress()
    expect(finalProgress?.total).toBe(3)
    expect(finalProgress?.done).toBe(2)
    expect(finalProgress?.failed).toBe(1)
    expect(finalProgress?.finished).toBe(true)
  })
})
