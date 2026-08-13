// Tests for completeParagraph (D3, D11) in useCompletion.
// Encode INTENT: the paragraph draft unit commits per-cell, flags missing/extra
// loudly (D11), and passes committed TARGET as left-context (D4).

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---- Minimal cell type ----
interface MinimalCell {
  id: string
  fileId: string
  original: string
  translated: string
  status: string
  paragraphStart?: boolean
}

// ---- Stub the paragraph-group helper ----
vi.mock("@/lib/parsers/paragraphs", () => ({
  paragraphGroupForCell: (cells: MinimalCell[], cellId: string) => {
    // Return the ids of cells that share the same fileId as the target cell.
    // This makes it trivial to build a 3-cell paragraph in tests.
    const target = cells.find((c) => c.id === cellId)
    if (!target) return []
    return cells.filter((c) => c.fileId === target.fileId).map((c) => c.id)
  },
}))

// ---- Stub paragraph-protocol parse so we can control the model response ----
// The real parseParagraphResponse works fine; we stub complete() instead.

// ---- Stub posthog ----
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn(), captureException: vi.fn() } }))

// ---- Stub frontier-health ----
vi.mock("@/lib/completion/frontier-health", () => ({
  useFrontierHealth: () => ({ available: true }),
}))

// ---- Stub user-provider-override ----
vi.mock("@/lib/store/user-provider-override", () => ({
  getUserProviderOverride: () => null,
}))

// ---- Stub user-api-keys ----
vi.mock("@/lib/store/user-api-keys", () => ({
  resolveApiKey: (_: string, key: string | undefined) => key ?? null,
}))

// ---- Stub batch-completion ----
vi.mock("@/lib/completion/batch-completion", () => ({
  resetBatchCompletionState: vi.fn(() => "run-1"),
  clearBatchCompletionProgress: vi.fn(),
  incrementBatchCompletionDone: vi.fn(),
  isBatchCompletionCancelled: vi.fn(() => false),
  getBatchCompletionSignal: vi.fn(() => new AbortController().signal),
  cancelBatchCompletion: vi.fn(),
}))

// ---- Stub compress-examples ----
vi.mock("@/lib/completion/compress-examples", () => ({
  compressExampleSource: (src: string) => src,
  dedupeExamples: (exs: unknown[]) => exs,
  dropPrecedingContextDuplicates: (exs: unknown[]) => exs,
}))

// We do NOT mock complete() at module level — we stub it per test via vi.stubGlobal("fetch").

import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { encodeParagraphCells } from "@/lib/completion/paragraph-protocol"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"

// Build a model response with <c id> tags for a set of cells.
function buildModelResponse(cells: { id: string; text: string }[]): string {
  return encodeParagraphCells(cells.map((c) => ({ cellId: c.id, text: c.text })))
}

// Wrap useCompletion in a simple synchronous runner (no React — we call the callback directly).
// useCompletion uses React hooks so we need renderHook from @testing-library/react.
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
  temperature: 0.0,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

function makeCell(id: string, fileId: string, original: string, translated = "", paragraphStart?: boolean): MinimalCell {
  return { id, fileId, original, translated, status: "draft", paragraphStart }
}

const FILE_A = "file-a"

// 3 cells in the same paragraph
const CELL_1 = makeCell("cell-1", FILE_A, "Verse one source", "", true)
const CELL_2 = makeCell("cell-2", FILE_A, "Verse two source")
const CELL_3 = makeCell("cell-3", FILE_A, "Verse three source")

const ALL_CELLS = [CELL_1, CELL_2, CELL_3]

function mockFetch(responseText: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: responseText } }],
        }),
      body: null,
    }),
  )
}

const searchMock = vi.fn().mockResolvedValue([])
const searchPassagesMock = vi.fn().mockResolvedValue([])

// ---- Tests ----

describe("completeParagraph (D3)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("commits 3 cells with ai_suggestion=true when model returns all 3 (D3)", async () => {
    const modelResponse = buildModelResponse([
      { id: "cell-1", text: "Translation one" },
      { id: "cell-2", text: "Translation two" },
      { id: "cell-3", text: "Translation three" },
    ])
    mockFetch(modelResponse)

    const commitMock = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS,
        "English",
        "French",
        searchMock,
        searchPassagesMock,
        SESSION,
        // The hook calls commitCompletedCell(cell, text, author). We verify call count + args.
        commitMock,
        [],
        ALL_CELLS as never,
        undefined,
        DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeParagraph("cell-1")
    })

    expect(commitMock).toHaveBeenCalledTimes(3)
    // Each call should carry the matching per-cell text.
    const calledTexts = commitMock.mock.calls.map((args: unknown[]) => args[1])
    expect(calledTexts).toContain("Translation one")
    expect(calledTexts).toContain("Translation two")
    expect(calledTexts).toContain("Translation three")
    // Author is the model id (or frontier-default).
    expect(commitMock.mock.calls[0][2]).toBe("test-model")
    expect(commitMock.mock.calls[0][3]).toMatchObject({
      model: "test-model",
      provider: "custom",
      mode: "paragraph",
      projectState: {
        sourceLanguage: "English",
        targetLanguage: "French",
        approvedExampleCount: 0,
      },
    })
    expect(commitMock.mock.calls[0][3].promptVersion).toMatch(/^translation-draft-v2:[0-9a-f]{8}$/)
  })

  it("does NOT commit a cell that is MISSING from the model response (D11)", async () => {
    // Model returns only cell-1 and cell-3, skipping cell-2.
    const modelResponse = buildModelResponse([
      { id: "cell-1", text: "Translation one" },
      { id: "cell-3", text: "Translation three" },
    ])
    mockFetch(modelResponse)

    const commitMock = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS, "English", "French",
        searchMock, searchPassagesMock,
        SESSION, commitMock, [],
        ALL_CELLS as never, undefined, DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeParagraph("cell-1")
    })

    // Only 2 commits (cell-1 and cell-3); cell-2 must be MISSING, never committed.
    expect(commitMock).toHaveBeenCalledTimes(2)
    const calledIds = commitMock.mock.calls.map((args: unknown[]) => (args[0] as MinimalCell).id)
    expect(calledIds).not.toContain("cell-2")
    // cell-2 should surface in errors
    expect(result.current.errors.has("cell-2")).toBe(true)
  })

  it("discards EXTRA/unknown tags from the response and does NOT commit them (D11)", async () => {
    // Model response includes a phantom cell id not in the paragraph.
    const modelResponse = [
      `<c id="cell-1">Translation one</c>`,
      `<c id="cell-2">Translation two</c>`,
      `<c id="cell-3">Translation three</c>`,
      `<c id="phantom-cell">Phantom translation</c>`,
    ].join("\n")
    mockFetch(modelResponse)

    const commitMock = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS, "English", "French",
        searchMock, searchPassagesMock,
        SESSION, commitMock, [],
        ALL_CELLS as never, undefined, DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeParagraph("cell-1")
    })

    // Exactly 3 commits — the phantom must not be committed.
    expect(commitMock).toHaveBeenCalledTimes(3)
    const calledIds = commitMock.mock.calls.map((args: unknown[]) => (args[0] as MinimalCell).id)
    expect(calledIds).not.toContain("phantom-cell")
    // Phantom surfaces in errors.
    expect(result.current.errors.has("phantom-cell")).toBe(true)
  })

  it("does NOT commit a cell whose tag is present but EMPTY/whitespace (D11 trust-killer)", async () => {
    // Model emits an empty tag for cell-2 (couldn't translate it) — this counts as
    // "no emitted content" and must be flagged, never committed as an empty cell.
    const modelResponse = [
      `<c id="cell-1">Translation one</c>`,
      `<c id="cell-2">   </c>`,
      `<c id="cell-3">Translation three</c>`,
    ].join("\n")
    mockFetch(modelResponse)

    const commitMock = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS, "English", "French",
        searchMock, searchPassagesMock,
        SESSION, commitMock, [],
        ALL_CELLS as never, undefined, DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeParagraph("cell-1")
    })

    // Only 2 commits — cell-2's empty tag must NOT produce an empty commit.
    expect(commitMock).toHaveBeenCalledTimes(2)
    const calledIds = commitMock.mock.calls.map((args: unknown[]) => (args[0] as MinimalCell).id)
    expect(calledIds).not.toContain("cell-2")
    // Empty cell surfaces in errors, flagged like a missing cell.
    expect(result.current.errors.has("cell-2")).toBe(true)
  })

  it("on a mid-fan-out commit failure, does NOT relabel already-committed cells as errored", async () => {
    // Model returns all 3; commit succeeds for cell-1 then throws on cell-2.
    const modelResponse = buildModelResponse([
      { id: "cell-1", text: "T1" },
      { id: "cell-2", text: "T2" },
      { id: "cell-3", text: "T3" },
    ])
    mockFetch(modelResponse)

    const commitMock = vi.fn()
      .mockResolvedValueOnce(undefined)         // cell-1 commits OK
      .mockRejectedValueOnce(new Error("boom")) // cell-2 commit throws

    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS, "English", "French",
        searchMock, searchPassagesMock,
        SESSION, commitMock, [],
        ALL_CELLS as never, undefined, DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeParagraph("cell-1")
    })

    // cell-1 was committed before the throw → it must NOT be marked errored.
    expect(result.current.errors.has("cell-1")).toBe(false)
    // cell-2 (failed) and cell-3 (never reached) are the still-uncommitted ones → errored.
    expect(result.current.errors.has("cell-2")).toBe(true)
    expect(result.current.errors.has("cell-3")).toBe(true)
  })

  it("forwards an AbortSignal to complete() — an aborted signal cancels without committing or erroring", async () => {
    // fetch honors the signal: reject with an AbortError when it's already aborted.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        if (init?.signal?.aborted) {
          return Promise.reject(new DOMException("Aborted", "AbortError"))
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: buildModelResponse([{ id: "cell-1", text: "T1" }]) } }],
            }),
          body: null,
        })
      }),
    )

    const commitMock = vi.fn().mockResolvedValue(undefined)
    const controller = new AbortController()
    controller.abort()

    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS, "English", "French",
        searchMock, searchPassagesMock,
        SESSION, commitMock, [],
        ALL_CELLS as never, undefined, DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeParagraph("cell-1", controller.signal)
    })

    // Aborted before any model output → nothing committed, and cells are cleared,
    // not errored (the AbortError branch).
    expect(commitMock).not.toHaveBeenCalled()
    expect(result.current.errors.has("cell-1")).toBe(false)
  })

  it("includes a preceding approved TARGET (not raw draft text) in the prompt (D4)", async () => {
    const precedingCell = {
      ...makeCell("cell-0", FILE_A, "Verse zero source", "Verse zero TARGET", true),
      status: "validated",
    }
    const allWithPreceding = [precedingCell, ...ALL_CELLS]

    // Capture the prompt sent to fetch so we can inspect it.
    let capturedBody: string | null = null
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = init.body as string
        const modelResponse = buildModelResponse([
          { id: "cell-1", text: "T1" },
          { id: "cell-2", text: "T2" },
          { id: "cell-3", text: "T3" },
        ])
        return {
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: modelResponse } }] }),
          body: null,
        }
      }),
    )

    const commitMock = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS, "English", "French",
        searchMock, searchPassagesMock,
        SESSION, commitMock, [],
        allWithPreceding as never, undefined, DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeParagraph("cell-1")
    })

    expect(capturedBody).not.toBeNull()
    const body = JSON.parse(capturedBody!)
    // Find the user message.
    const userMsg = body.messages.find((m: { role: string; content: string }) => m.role === "user")
    expect(userMsg).toBeDefined()
    // The TARGET of the preceding cell must appear in the prompt.
    expect(userMsg.content).toContain("Verse zero TARGET")
    // The preceding SOURCE may also appear (it's paired), but the TARGET is what matters for D4.
    // The live cells must also be present as <c id> tags.
    expect(userMsg.content).toContain(`<c id="cell-1">`)
  })

  it("falls back gracefully when preceding cell has no committed translation (D4)", async () => {
    // Preceding cell has empty translated field — no left-context should be added.
    const precedingCell = makeCell("cell-0", FILE_A, "Verse zero source", "" /* empty */, true)
    const allWithPreceding = [precedingCell, ...ALL_CELLS]

    let capturedBody: string | null = null
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = init.body as string
        const modelResponse = buildModelResponse([
          { id: "cell-1", text: "T1" },
          { id: "cell-2", text: "T2" },
          { id: "cell-3", text: "T3" },
        ])
        return {
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: modelResponse } }] }),
          body: null,
        }
      }),
    )

    const commitMock = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS, "English", "French",
        searchMock, searchPassagesMock,
        SESSION, commitMock, [],
        allWithPreceding as never, undefined, DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeParagraph("cell-1")
    })

    // Should still succeed and commit all 3 cells.
    expect(commitMock).toHaveBeenCalledTimes(3)

    // The empty preceding cell's source should NOT appear as a preceding context
    // (gatherPrecedingContext skips cells with empty translated).
    expect(capturedBody).not.toBeNull()
    const body = JSON.parse(capturedBody!)
    const userMsg = body.messages.find((m: { role: string; content: string }) => m.role === "user")
    expect(userMsg.content).not.toContain("Verse zero source\nTranslation:")
  })

  // Coordinator adjudication (p1-paragraph-ui-wiring, Task 3 follow-up): the
  // "Draft paragraph" confirm dialog promises "cells already validated are
  // skipped" — matching the single-cell UI, where Regenerate is hidden once
  // cell.status === "validated". completeParagraph must honor that: never
  // commit a validated cell's draft, never error it, and (cleanly achievable
  // here, per parseParagraphResponse's expectedIds-only reconciliation) never
  // even ask the model to translate it.
  it("skips an already-validated cell in the group: never commits it, never errors it, renders it IN POSITION as a locked segment (not a <c id> tag), and expectedIds exclude it (D3 + coordinator adjudication)", async () => {
    const validatedCell2 = { ...CELL_2, status: "validated", translated: "Verse two ALREADY TRANSLATED" }
    const cellsWithValidated = [CELL_1, validatedCell2, CELL_3]

    let capturedBody: string | null = null
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = init.body as string
        // The model only sees the two non-validated cells — respond to those.
        const modelResponse = buildModelResponse([
          { id: "cell-1", text: "Translation one" },
          { id: "cell-3", text: "Translation three" },
        ])
        return {
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: modelResponse } }] }),
          body: null,
        }
      }),
    )

    const commitMock = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS, "English", "French",
        searchMock, searchPassagesMock,
        SESSION, commitMock, [],
        cellsWithValidated as never, undefined, DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeParagraph("cell-1")
    })

    // Only cell-1 and cell-3 commit — the validated cell-2 is never touched.
    expect(commitMock).toHaveBeenCalledTimes(2)
    const calledIds = commitMock.mock.calls.map((args: unknown[]) => (args[0] as MinimalCell).id)
    expect(calledIds).not.toContain("cell-2")

    // Skipped (not missing, not errored) — a validated cell being excluded
    // from the request is not a model failure, so it must not appear in errors.
    expect(result.current.errors.has("cell-2")).toBe(false)

    // Never even asked the model to translate cell-2 — the paragraph tag for
    // it must not appear in the outgoing prompt.
    expect(capturedBody).not.toBeNull()
    const body = JSON.parse(capturedBody!)
    const userMsg = body.messages.find((m: { role: string; content: string }) => m.role === "user")
    expect(userMsg.content).not.toContain(`<c id="cell-2">`)

    // Instead it renders IN POSITION as a locked reference segment — source
    // text plus its existing committed target, clearly marked — so cell-1
    // and cell-3's tags don't read as artificially adjacent. (The living-
    // memory validated-pairs few-shot block may ALSO surface this same
    // committed pair earlier in the prompt as a reference example — that's
    // unrelated and expected; isolate the "Source paragraph:" block itself
    // to check the in-position ordering the locked-segment feature owns.)
    expect(userMsg.content).toContain(
      "Verse two source [already translated — do not output: Verse two ALREADY TRANSLATED]",
    )
    const liveParagraphBlock = (userMsg.content as string).split("Source paragraph:")[1]
    expect(liveParagraphBlock).toBeDefined()
    expect(liveParagraphBlock.indexOf(`<c id="cell-1">`))
      .toBeLessThan(liveParagraphBlock.indexOf("Verse two ALREADY TRANSLATED"))
    expect(liveParagraphBlock.indexOf("Verse two ALREADY TRANSLATED"))
      .toBeLessThan(liveParagraphBlock.indexOf(`<c id="cell-3">`))

    // No stuck pulsing ring on the skipped cell.
    expect(result.current.completing.has("cell-2")).toBe(false)
  })

  it("does nothing (no model call, no commits) when every cell in the group is already validated", async () => {
    const allValidated = ALL_CELLS.map((c) => ({ ...c, status: "validated" }))
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const commitMock = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useCompletion(
        SETTINGS, "English", "French",
        searchMock, searchPassagesMock,
        SESSION, commitMock, [],
        allValidated as never, undefined, DEFAULT_DRAFT_CONTEXT,
      ),
    )

    await act(async () => {
      await result.current.completeParagraph("cell-1")
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(commitMock).not.toHaveBeenCalled()
    expect(result.current.errors.size).toBe(0)
  })
})
