// AQU-1656: every committed AI draft leaves an audit-trail record, and the
// record and the committed draft share one intervention id.
//
// That shared id is the whole contract: the history drawer decides whether a
// prompt explains the cell's CURRENT text or an older version by comparing the
// id on the committed draft with the id on the trail record. If the two ever
// diverge, every prompt reads as stale; if recording ran for a draft that
// never committed, the trail would explain text that does not exist.

import { describe, it, expect, vi, beforeEach } from "vitest"

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

import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { AiDraftProvenance } from "@/lib/sync/outbox-types"
import type { ModelCallRecord } from "@/lib/ai-interventions/client"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { renderHook, act } from "@testing-library/react"
import { useCompletion } from "./useCompletion"
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"

const SESSION: FrontierSession = { jwt: "jwt-test", username: "tester", createdAt: new Date().toISOString() }
const SETTINGS: CompletionSettings = {
  provider: "custom",
  endpoint: "http://localhost:9999",
  model: "test-model",
  maxTokens: 512,
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

const CELL = {
  id: "JHN 6:27", fileId: "JHN", original: "ἐργάζεσθε μὴ τὴν βρῶσιν", translated: "",
  status: "draft", targetEventId: "head-before",
}

function mockModel(content: string) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
    body: null,
  }))
}

function render(commit: ReturnType<typeof vi.fn>, record: ReturnType<typeof vi.fn>) {
  return renderHook(() =>
    useCompletion(
      SETTINGS, "Greek", "English",
      vi.fn().mockResolvedValue([]), vi.fn().mockResolvedValue([]),
      SESSION, commit as never, [],
      [CELL] as never, undefined, DEFAULT_DRAFT_CONTEXT,
      "", undefined, undefined,
      record as never,
    ),
  )
}

describe("useCompletion — AI intervention trail (AQU-1656)", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("records the prompt and output under the same id the committed draft carries", async () => {
    mockModel("Do not work for the food that perishes.”")
    const commit = vi.fn().mockResolvedValue(undefined)
    const record = vi.fn()
    const { result } = render(commit, record)

    await act(async () => { await result.current.completeSingle(CELL as never) })

    expect(commit).toHaveBeenCalledTimes(1)
    const provenance = commit.mock.calls[0][3] as AiDraftProvenance
    expect(provenance.interventionId).toBeTruthy()

    expect(record).toHaveBeenCalledTimes(1)
    const call = record.mock.calls[0][0] as ModelCallRecord
    expect(call.cells).toHaveLength(1)
    expect(call.cells[0]).toMatchObject({
      interventionId: provenance.interventionId,
      cellId: "JHN 6:27",
      fileId: "JHN",
      basedOnEventId: "head-before",
      output: commit.mock.calls[0][1],
    })
    expect(call).toMatchObject({ kind: "draft", mode: "single", model: "test-model" })
    expect(call.rawOutput).toBe("Do not work for the food that perishes.”")
    expect(call.messages.some((m) => m.content.includes("ἐργάζεσθε μὴ τὴν βρῶσιν"))).toBe(true)
  })

  it("records nothing when the draft fails to commit", async () => {
    mockModel("Do not work for the food that perishes.")
    const commit = vi.fn().mockRejectedValue(new Error("outbox full"))
    const record = vi.fn()
    const { result } = render(commit, record)

    await act(async () => { await result.current.completeSingle(CELL as never) })

    expect(record).not.toHaveBeenCalled()
  })
})
