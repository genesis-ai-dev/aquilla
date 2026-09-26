// AQU-1377: clicking Translate on a selection must never be a silent no-op.
//
// `completeBatch` used to `return` the moment the cached health probe said
// "unavailable". After an offline → online cycle that cached value was a stale
// negative (a probe forced by the focus handler while the Wi-Fi was off), so the
// click produced no progress banner, no drafts, no error and no completion
// request — the feature looked broken until the page was reloaded.
//
// Two behaviours are pinned here:
//   1. a stale negative self-heals — the click forces a fresh probe, and when the
//      service answers it, the run proceeds and drafts land; and
//   2. when the service really is unreachable the refusal is EXPLICIT — the batch
//      progress store carries `unavailable` so the banner can say so.

import { describe, it, expect, vi, beforeEach } from "vitest"

interface MinimalCell {
  id: string
  fileId: string
  original: string
  translated: string
  status: string
}

vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn(), captureException: vi.fn() } }))

// The hook reports "unavailable" — the stale-negative state the bug left behind.
// `checkFrontierHealth` is the on-demand re-probe the fix adds; each test decides
// what it answers, which is the whole distinction between the two cases.
const checkFrontierHealthMock = vi.fn()
vi.mock("@/lib/completion/frontier-health", () => ({
  useFrontierHealth: () => ({ available: false, checking: false }),
  checkFrontierHealth: (force?: boolean) => checkFrontierHealthMock(force),
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
  dropValidatedPairDuplicates: (exs: unknown[]) => exs,
}))

// Asserting against the REAL progress store, so a silent early exit is caught.
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { renderHook, act } from "@testing-library/react"
import { useCompletion } from "./useCompletion"
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import {
  getCompletionBatchProgress,
  dismissBatchCompletionSummary,
} from "@/lib/completion/batch-completion"

const SESSION: FrontierSession = {
  jwt: "jwt-test",
  username: "tester",
  createdAt: new Date().toISOString(),
}

// provider "frontier" is the only path health-gated — the bug does not exist on a
// custom endpoint or a personal OpenRouter override.
const FRONTIER_SETTINGS: CompletionSettings = {
  provider: "frontier",
  endpoint: "",
  model: "frontier-default",
  maxTokens: 512,
  temperature: 0.0,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

const CELLS: MinimalCell[] = Array.from({ length: 3 }, (_, i) => ({
  id: `cell-${i + 1}`,
  fileId: "file-a",
  original: `Source sentence ${i + 1}`,
  translated: "",
  status: "draft",
}))

const searchMock = vi.fn().mockResolvedValue([])
const searchPassagesMock = vi.fn().mockResolvedValue([])

function renderCompletion(commitMock: ReturnType<typeof vi.fn>) {
  return renderHook(() =>
    useCompletion(
      FRONTIER_SETTINGS,
      "English",
      "French",
      searchMock,
      searchPassagesMock,
      SESSION,
      commitMock as never,
      [],
      CELLS as never,
      undefined,
      DEFAULT_DRAFT_CONTEXT,
    ),
  )
}

describe("completeBatch — AI availability after an offline → online cycle (AQU-1377)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    dismissBatchCompletionSummary()
    checkFrontierHealthMock.mockReset()
  })

  it("self-heals a stale negative: re-probes on click and runs when the service answers", async () => {
    // The service is actually fine — the cached "unavailable" was left by a probe
    // that fired while the network was down.
    checkFrontierHealthMock.mockResolvedValue(true)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: CELLS.map((_, i) => `<v${i + 1}>Translated ${i + 1}</v${i + 1}>`).join("\n"),
            },
          }],
        }),
        body: null,
      }),
    )

    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    await act(async () => {
      await result.current.completeBatch(CELLS as never)
    })

    // The re-probe must be FORCED — an unforced call would be served the very
    // stale negative we are trying to get past.
    expect(checkFrontierHealthMock).toHaveBeenCalledWith(true)
    // And the run must actually have happened: drafts committed, no reload.
    expect(commitMock).toHaveBeenCalled()
    expect(getCompletionBatchProgress()?.unavailable).toBeFalsy()
  })

  it("refuses explicitly when the service really is unreachable, instead of doing nothing", async () => {
    checkFrontierHealthMock.mockResolvedValue(false)
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock)

    await act(async () => {
      await result.current.completeBatch(CELLS as never)
    })

    // No run started and no completion request — but the refusal is VISIBLE:
    // the store carries `unavailable`, which the banner renders as a message.
    expect(commitMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    const progress = getCompletionBatchProgress()
    expect(progress).not.toBeNull()
    expect(progress?.unavailable).toBe(true)
    expect(progress?.finished).toBe(true)
  })
})
