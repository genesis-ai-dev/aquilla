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

vi.mock("@/lib/posthog", () => ({ default: { scope() { return { ...this, enabled: () => true } }, capture: vi.fn(), captureException: vi.fn() } }))

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
  dismissBatchCompletionSummary,
  resumeBatchCompletion,
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

describe("completeBatch — coalesced chunk persistence (AQU-1145)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearBatchCompletionProgress()
  })

  it("commits one mapped model chunk through one batch callback and reports per-cell failures", async () => {
    const cells = Array.from({ length: 10 }, (_, i) =>
      makeCell(`cell-${i + 1}`, FILE_A, `Source sentence ${i + 1}`),
    )
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: encodeChunkResponse(cells) } }],
        }),
        body: null,
      }),
    )

    const scalarCommit = vi.fn().mockResolvedValue(undefined)
    const batchCommit = vi.fn().mockImplementation(async (drafts: unknown[]) =>
      drafts.map((_, index) => index === 4
        ? { status: "rejected" as const, reason: new Error("cell 5 enqueue failed") }
        : { status: "fulfilled" as const, value: undefined }),
    )
    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS, "English", "French",
        searchMock, searchPassagesMock,
        SESSION, scalarCommit, [],
        cells as never, undefined, DEFAULT_DRAFT_CONTEXT, "", batchCommit,
      ),
    )

    await act(async () => {
      await result.current.completeBatch(cells as never)
    })

    expect(batchCommit).toHaveBeenCalledTimes(1)
    expect(scalarCommit).not.toHaveBeenCalled()
    const drafts = batchCommit.mock.calls[0][0]
    expect(drafts).toHaveLength(10)
    expect(drafts.map((draft: { cell: MinimalCell }) => draft.cell.id)).toEqual(
      cells.map((cell) => cell.id),
    )
    expect(drafts[0]).toMatchObject({
      text: "Translated 1",
      author: "test-model",
      provenance: { mode: "batch", model: "test-model", provider: "custom" },
    })
    expect(result.current.errors.get("cell-5")).toBe("cell 5 enqueue failed")
    expect(result.current.errors.has("cell-1")).toBe(false)

    const finalProgress = getCompletionBatchProgress()
    expect(finalProgress?.total).toBe(10)
    expect(finalProgress?.done).toBe(9)
    expect(finalProgress?.failed).toBe(1)
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

describe("completeBatch — Luna context recipe", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearBatchCompletionProgress()
  })

  it("passes the five immediately preceding approved pairs through to the model prompt", async () => {
    const preceding = Array.from({ length: 6 }, (_, i) => ({
      ...makeCell(`previous-${i + 1}`, FILE_A, `Previous source ${i + 1}`),
      translated: `Previous target ${i + 1}`,
      status: "validated",
    }))
    const live = makeCell("live", FILE_A, "Live source")
    const cells = [...preceding, live]
    let userPrompt = ""

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
        userPrompt = body.messages.find((message) => message.role === "user")?.content ?? ""
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: "<v1>Translated live</v1>" } }] }),
          body: null,
        })
      }),
    )

    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS, "English", "French",
        searchMock, vi.fn().mockResolvedValue([]),
        SESSION, commitMock, [],
        cells as never, undefined, DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeBatch([live] as never)
    })

    expect(userPrompt).not.toContain("Source: Previous source 1\nTranslation: Previous target 1")
    for (let i = 2; i <= 6; i++) {
      expect(userPrompt).toContain(`Source: Previous source ${i}\nTranslation: Previous target ${i}`)
    }
    expect(userPrompt.indexOf("Previous target 6")).toBeLessThan(userPrompt.indexOf("<v1>Live source</v1>"))
    expect(commitMock).toHaveBeenCalledTimes(1)
  })
})

// AQU-2654: "Make batch drafting show progress and completion, and fail loudly
// if a batch dies." A customer's 362-cell run went silent twice for ~20
// minutes; nothing on screen distinguished "slow" from "dead". These lock the
// driver's side of that: every exit is a terminal state that names what is
// left, the loop is not paced by timers, and it does not need the editor.
describe("completeBatch — an honest run (AQU-2654)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    dismissBatchCompletionSummary()
  })

  const okResponse = (chunk: MinimalCell[]) => ({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content: encodeChunkResponse(chunk) } }] }),
    body: null,
  })
  const chunkFor = (body: string): MinimalCell[] => {
    const index = body.includes("Source sentence 21") ? 2 : body.includes("Source sentence 11") ? 1 : 0
    return THIRTY_CELLS.slice(index * 10, index * 10 + 10)
  }
  const bodyOf = (init?: RequestInit) => (typeof init?.body === "string" ? init.body : "")

  function renderBatchHook(opts: {
    commit?: ReturnType<typeof vi.fn>
    cells?: MinimalCell[] | (() => MinimalCell[])
    styleInstructionsFor?: () => string[]
  } = {}) {
    const commit = opts.commit ?? vi.fn().mockResolvedValue(undefined)
    const rendered = renderHook(() =>
      useCompletion(
        SETTINGS, "English", "French",
        searchMock, searchPassagesMock,
        SESSION, commit as never, [],
        (opts.cells ?? THIRTY_CELLS) as never, undefined, DEFAULT_DRAFT_CONTEXT, "",
        undefined,
        opts.styleInstructionsFor as never,
        undefined,
        undefined,
        { id: "project-1", files: [{ id: FILE_A, name: "file-a.docx" }] },
      ),
    )
    return { ...rendered, commit }
  }

  it("a failed chunk ends in a visible failed state that names the cells left to draft", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = bodyOf(init)
      if (body.includes("Source sentence 11")) {
        return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("upstream down") })
      }
      return Promise.resolve(okResponse(chunkFor(body)))
    }))
    const { result } = renderBatchHook()

    await act(async () => {
      await result.current.completeBatch(THIRTY_CELLS as never)
    })

    const progress = getCompletionBatchProgress()
    expect(progress).toMatchObject({
      finished: true,
      outcome: "failed",
      total: 30,
      done: 20,
      failed: 10,
      scope: { projectId: "project-1", fileId: FILE_A, fileName: "file-a.docx" },
    })
    const failedIds = Array.from({ length: 10 }, (_, i) => `cell-${i + 11}`)
    expect(progress?.failedCells.map((cell) => cell.cellId)).toEqual(failedIds)
    expect(progress?.failedCells[0].reason).toContain("503")
    expect(progress?.remainingCellIds).toEqual(failedIds)
  })

  it("a run that drafted everything ends in a visible done state — it does not just vanish", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(okResponse(chunkFor(bodyOf(init)))),
    ))
    const { result } = renderBatchHook()

    await act(async () => {
      await result.current.completeBatch(THIRTY_CELLS as never)
    })

    expect(getCompletionBatchProgress()).toMatchObject({
      finished: true, outcome: "done", total: 30, done: 30, failed: 0, remainingCellIds: [],
    })
  })

  it("cells that had streamed in before the request died are failed, not left uncounted", async () => {
    const cells = THIRTY_CELLS.slice(0, 10)
    const encoder = new TextEncoder()
    // Both attempts stream <v1>..<v3> and then the connection drops.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const content = "<v1>Un</v1><v2>Deux</v2><v3>Trois</v3>"
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`,
          ))
          controller.error(new Error("connection reset"))
        },
      }),
    })))
    const { result, commit } = renderBatchHook({ cells })

    await act(async () => {
      await result.current.completeBatch(cells as never)
    })

    // Nothing from a failed request is saved…
    expect(commit).not.toHaveBeenCalled()
    // …and every cell is accounted for: done + failed === total.
    expect(getCompletionBatchProgress()).toMatchObject({
      finished: true, outcome: "failed", total: 10, done: 0, failed: 10,
    })
    // No cell keeps a spinner or a preview of text that was never saved.
    expect(result.current.previews.size).toBe(0)
    for (const cell of cells) expect(result.current.completing.get(cell.id)).toBe("error")
  })

  it("a chunk that returns too few cells is not counted complete", async () => {
    const cells = THIRTY_CELLS.slice(0, 10)
    // The batch reply carries 7 of 10 tags; the per-cell fallback for the
    // other three returns nothing usable.
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const isBatchCall = bodyOf(init).includes("Source sentence 1\\n") || bodyOf(init).includes("<v1>")
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: isBatchCall ? encodeChunkResponse(cells.slice(0, 7)) : "" } }],
        }),
        body: null,
      })
    }))
    const { result, commit } = renderBatchHook({ cells })

    await act(async () => {
      await result.current.completeBatch(cells as never)
    })

    expect(commit).toHaveBeenCalledTimes(7)
    const progress = getCompletionBatchProgress()
    expect(progress).toMatchObject({ finished: true, outcome: "failed", total: 10, done: 7, failed: 3 })
    expect(progress?.remainingCellIds).toEqual(["cell-8", "cell-9", "cell-10"])
  })

  it("the loop itself dying is a failed run with a reason, not an unhandled rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(okResponse(chunkFor(bodyOf(init)))),
    ))
    let calls = 0
    const { result } = renderBatchHook({
      // Throws while the SECOND chunk's prompt is being built.
      styleInstructionsFor: () => {
        calls += 1
        if (calls > 10) throw new Error("style graph exploded")
        return []
      },
    })

    await act(async () => {
      await expect(result.current.completeBatch(THIRTY_CELLS as never)).resolves.toBeUndefined()
    })

    const progress = getCompletionBatchProgress()
    expect(progress).toMatchObject({
      finished: true, outcome: "failed", total: 30, done: 10, runError: "style graph exploded",
    })
    expect(progress?.remainingCellIds).toHaveLength(20)
    expect(result.current.completing.size).toBe(0)
  })

  it("does not wait on a timer between chunks", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(okResponse(chunkFor(bodyOf(init)))),
    ))
    const { result, commit } = renderBatchHook()

    // No timer is ever advanced. A sleep, a backoff or a rAF anywhere on the
    // chunk → chunk path would leave this promise pending — which is what a
    // background tab (timers throttled to one a minute) does to such a loop.
    await act(async () => {
      await result.current.completeBatch(THIRTY_CELLS as never)
    })

    expect(commit).toHaveBeenCalledTimes(30)
    expect(getCompletionBatchProgress()).toMatchObject({ finished: true, outcome: "done", done: 30 })
  })

  it("keeps drafting, and reports the outcome, after the editor that started it unmounts", async () => {
    let releaseSecondChunk: (() => void) | undefined
    const secondChunkGate = new Promise<void>((resolve) => { releaseSecondChunk = resolve })
    const twenty = THIRTY_CELLS.slice(0, 20)
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = bodyOf(init)
      if (body.includes("Source sentence 11")) await secondChunkGate
      return okResponse(chunkFor(body))
    }))
    const { result, commit, unmount } = renderBatchHook({ cells: twenty })

    let run: Promise<void> | undefined
    await act(async () => {
      run = result.current.completeBatch(twenty as never)
      // Let chunk 1 land; chunk 2's request is now in flight.
      await vi.waitFor(() => expect(getCompletionBatchProgress()?.done).toBe(10))
    })

    // The user navigates away: the component that owns the hook is gone.
    unmount()
    expect(getCompletionBatchProgress()).toMatchObject({ finished: false, done: 10, total: 20 })

    releaseSecondChunk?.()
    await run

    expect(commit).toHaveBeenCalledTimes(20)
    expect(getCompletionBatchProgress()).toMatchObject({
      finished: true, outcome: "done", done: 20, total: 20,
    })
  })

  it("retrying the remainder drafts only cells that still have no translation", async () => {
    const live: MinimalCell[] = THIRTY_CELLS.slice(0, 20).map((cell) => ({ ...cell }))
    const requests: string[] = []
    let failSecondChunk = true
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = bodyOf(init)
      requests.push(body)
      if (failSecondChunk && body.includes("Source sentence 11")) {
        return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("boom") })
      }
      // The retry run is ONE chunk holding only cells 11-20.
      return Promise.resolve(okResponse(THIRTY_CELLS.slice(0, 10)))
    }))
    const commit = vi.fn().mockImplementation(async (cell: MinimalCell, text: string) => {
      const target = live.find((candidate) => candidate.id === cell.id)
      if (target) target.translated = text
    })
    const { result } = renderBatchHook({ commit, cells: () => live })

    await act(async () => {
      await result.current.completeBatch(live as never)
    })
    expect(getCompletionBatchProgress()).toMatchObject({ outcome: "failed", done: 10, failed: 10 })

    failSecondChunk = false
    requests.length = 0
    await act(async () => {
      expect(resumeBatchCompletion()).toBe(true)
      await vi.waitFor(() => expect(getCompletionBatchProgress()?.outcome).toBe("done"))
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain("Source sentence 11")
    expect(requests[0]).not.toContain("Source sentence 5")
    expect(getCompletionBatchProgress()).toMatchObject({ total: 10, done: 10, failed: 0 })
    expect(commit).toHaveBeenCalledTimes(20)
  })
})
