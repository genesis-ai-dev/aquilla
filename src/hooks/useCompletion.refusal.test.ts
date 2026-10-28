// AQU-2217 — regression guard: a model REFUSAL is never committed as a draft.
//
// A partner contributor drafted a verse with the per-cell sparkle and the cell
// came back holding the literal text "I'm sorry, but I cannot assist with that
// request.". The reply was non-empty, so the AQU-685 empty-result guard let it
// through and AQU-211's auto-commit turned it into a real target.cell.commit —
// which is why reload, re-login and Regenerate never cleared it.
//
// This file pins the fixed contract at the level where the bug escaped (the
// hook, with only fetch stubbed), for both auto-committing draft paths:
//   - completeSingle: nothing committed, error badge + message set, resolves
//     false so the sparkle flow shows no "Saved" confirmation;
//   - completeParagraph: a refusal inside a present <c id> tag is treated like
//     an empty tag — flagged, never committed, siblings unaffected;
//   - a real translation that merely contains "sorry" still commits;
//   - an `ai translation refused` PostHog event carries the provider and model.

import { describe, it, expect, vi, beforeEach } from "vitest"

interface MinimalCell {
  id: string
  fileId: string
  original: string
  translated: string
  status: string
  paragraphStart?: boolean
}

vi.mock("@/lib/parsers/paragraphs", () => ({
  paragraphGroupForCell: (cells: MinimalCell[], cellId: string) => {
    const target = cells.find((c) => c.id === cellId)
    if (!target) return []
    return cells.filter((c) => c.fileId === target.fileId).map((c) => c.id)
  },
}))
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
  incrementBatchCompletionFailed: vi.fn(),
  isBatchCompletionCancelled: vi.fn(() => false),
  getBatchCompletionSignal: vi.fn(() => new AbortController().signal),
  cancelBatchCompletion: vi.fn(),
}))

import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { encodeParagraphCells } from "@/lib/completion/paragraph-protocol"
import { renderHook, act } from "@testing-library/react"
import { useCompletion } from "./useCompletion"
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"
import posthog from "@/lib/posthog"

/** The exact string the partner's cell was left holding. */
const REFUSAL = "I'm sorry, but I cannot assist with that request."

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

const FILE_A = "file-a"
const CELL_1: MinimalCell = { id: "cell-1", fileId: FILE_A, original: "Verse one source", translated: "", status: "draft", paragraphStart: true }
const CELL_2: MinimalCell = { id: "cell-2", fileId: FILE_A, original: "Verse two source", translated: "", status: "draft" }

const searchMock = vi.fn().mockResolvedValue([])
const searchPassagesMock = vi.fn().mockResolvedValue([])

function mockFetchOk(content: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content } }] }),
      body: null,
    }),
  )
}

function renderCompletion(commitMock: ReturnType<typeof vi.fn>, cells: MinimalCell[]) {
  return renderHook(() =>
    useCompletion(
      SETTINGS, "English", "French",
      searchMock, searchPassagesMock,
      SESSION, commitMock as never, [],
      cells as never, undefined, DEFAULT_DRAFT_CONTEXT,
    ),
  )
}

describe("completeSingle never commits a model refusal (AQU-2217)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(posthog.capture).mockClear()
  })

  it("resolves false, skips the commit, and surfaces the refusal as an error", async () => {
    mockFetchOk(REFUSAL)
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, [CELL_1])

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await result.current.completeSingle(CELL_1 as never)
    })

    // The refusal must never become the cell's target text…
    expect(commitMock).not.toHaveBeenCalled()
    // …the sparkle flow must not report "Saved"…
    expect(outcome).toBe(false)
    // …and the contributor sees why, instead of a broken-looking translation.
    expect(result.current.completing.get("cell-1")).toBe("error")
    expect(result.current.errors.get("cell-1")).toContain("declined")
  })

  it("reports the refusal to PostHog with the provider and model, and not as a completion", async () => {
    mockFetchOk(REFUSAL)
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, [CELL_1])

    await act(async () => {
      await result.current.completeSingle(CELL_1 as never)
    })

    const events = vi.mocked(posthog.capture).mock.calls.map(([name]) => name)
    expect(events).toContain("ai translation refused")
    expect(events).not.toContain("ai translation completed")
    const refused = vi.mocked(posthog.capture).mock.calls.find(([name]) => name === "ai translation refused")
    expect(refused?.[1]).toMatchObject({ provider: "custom", model: "test-model", mode: "single" })
  })

  it("still commits a real translation that merely contains the word sorry", async () => {
    mockFetchOk("Il etait sorry pour son frere, et il pleura.")
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, [CELL_1])

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await result.current.completeSingle(CELL_1 as never)
    })

    expect(outcome).toBe(true)
    expect(commitMock).toHaveBeenCalledTimes(1)
    expect(commitMock.mock.calls[0][1]).toBe("Il etait sorry pour son frere, et il pleura.")
    expect(result.current.errors.get("cell-1")).toBeUndefined()
  })
})

describe("completeParagraph never commits a model refusal (AQU-2217)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(posthog.capture).mockClear()
  })

  it("flags the refused cell, commits its siblings, and leaves the refusal unwritten", async () => {
    mockFetchOk(encodeParagraphCells([
      { cellId: "cell-1", text: REFUSAL },
      { cellId: "cell-2", text: "Traduction deux" },
    ]))
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, [CELL_1, CELL_2])

    await act(async () => {
      await result.current.completeParagraph("cell-1")
    })

    const committed = commitMock.mock.calls.map((args: unknown[]) => args[1])
    expect(committed).not.toContain(REFUSAL)
    expect(committed).toEqual(["Traduction deux"])
    expect(result.current.errors.get("cell-1")).toContain("declined")
    expect(result.current.errors.get("cell-2")).toBeUndefined()
    expect(vi.mocked(posthog.capture).mock.calls.map(([name]) => name)).toContain("ai translation refused")
  })
})
