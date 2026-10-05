// AQU-1573: every copilot drafting path sends the cited verses. A sermon cell
// that quotes "Isaiah 40:25" must reach the model with the reference Bible's
// wording whichever way it is drafted — the sparkle (single), Translate
// selection (batch, including the per-cell fallback when the model drops a
// segment) and paragraph drafting — and a failed verse lookup must never stop
// the draft.

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
// One paragraph = every cell of the file (the real grouping reads markers).
vi.mock("@/lib/parsers/paragraphs", () => ({
  paragraphGroupForCell: (cells: MinimalCell[], cellId: string) => {
    const target = cells.find((c) => c.id === cellId)
    return target ? cells.filter((c) => c.fileId === target.fileId).map((c) => c.id) : []
  },
}))

import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { renderHook, act } from "@testing-library/react"
import { useCompletion } from "./useCompletion"
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { clearBatchCompletionProgress } from "@/lib/completion/batch-completion"
import { encodeParagraphCells } from "@/lib/completion/paragraph-protocol"
import type { CellData } from "./useCells"

const SESSION: FrontierSession = { jwt: "jwt-test", username: "tester", createdAt: new Date().toISOString() }
const SETTINGS: CompletionSettings = {
  provider: "custom",
  endpoint: "http://localhost:9999",
  model: "test-model",
  maxTokens: 512,
  temperature: 0,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

const CELLS: MinimalCell[] = [
  { id: "c1", fileId: "f", original: 'Isaiah 40:25 says, "To whom will you compare me?"', translated: "", status: "draft" },
  { id: "c2", fileId: "f", original: "God is beyond compare.", translated: "", status: "draft" },
  { id: "c3", fileId: "f", original: "Read John 3:16 again.", translated: "", status: "draft" },
]

/** Stand-in for useReferenceBible.blockFor: one line per cell that cites a verse. */
function fakeBlockFor() {
  return vi.fn(async (cells: CellData[]) => {
    const cited = cells.filter((c) => /\d+:\d+/.test(c.original)).map((c) => `VERSES-FOR-${c.id}`)
    return cited.length ? `Scripture quotations — copy from Test (MUST follow):\n${cited.join("\n")}` : undefined
  })
}

type Sent = { system: string; user: string }
let sent: Sent[] = []

/** The model: answers in whichever protocol the request speaks. */
function stubModel(opts: { dropSegment?: number } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
      const system = body.messages.find((m) => m.role === "system")?.content ?? ""
      const user = body.messages.find((m) => m.role === "user")?.content ?? ""
      sent.push({ system, user })
      let content = "ترجمة"
      if (user.includes("<v1>")) {
        const count = (user.match(/<v\d+>/g) ?? []).length
        content = Array.from({ length: count }, (_, i) => i + 1)
          .filter((n) => n !== opts.dropSegment)
          .map((n) => `<v${n}>ترجمة ${n}</v${n}>`)
          .join("\n")
      } else if (user.includes('<c id="')) {
        const ids = [...user.matchAll(/<c id="([^"]+)">/g)].map((m) => m[1])
        content = encodeParagraphCells(ids.map((cellId) => ({ cellId, text: `ترجمة ${cellId}` })))
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content } }] }),
        body: null,
      })
    }),
  )
}

function render(referenceBlockFor?: (cells: CellData[]) => Promise<string | undefined>) {
  const commit = vi.fn().mockResolvedValue(undefined)
  const commitMany = vi.fn(async (drafts: unknown[]) => drafts.map(() => ({ status: "fulfilled" as const, value: undefined })))
  const { result } = renderHook(() =>
    useCompletion(
      SETTINGS,
      "English",
      "Arabic",
      vi.fn().mockResolvedValue([]),
      vi.fn().mockResolvedValue([]),
      SESSION,
      commit,
      [],
      CELLS as never,
      undefined,
      DEFAULT_DRAFT_CONTEXT,
      "",
      commitMany,
      undefined,
      referenceBlockFor,
    ),
  )
  return { result, commit, commitMany }
}

describe("useCompletion — reference verses (AQU-1573)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearBatchCompletionProgress()
    sent = []
  })

  it("single: the cell's verses ride the system prompt", async () => {
    stubModel()
    const blockFor = fakeBlockFor()
    const { result, commit } = render(blockFor)
    await act(async () => {
      await result.current.completeSingle(CELLS[0] as never)
    })
    expect(blockFor).toHaveBeenCalledWith([CELLS[0]])
    expect(sent).toHaveLength(1)
    expect(sent[0].system).toContain("VERSES-FOR-c1")
    expect(sent[0].user).not.toContain("VERSES-FOR")
    expect(commit).toHaveBeenCalled()
  })

  it("single: a cell that cites nothing sends the prompt it always did", async () => {
    stubModel()
    const { result } = render(fakeBlockFor())
    await act(async () => {
      await result.current.completeSingle(CELLS[1] as never)
    })
    stubModel()
    const plain = render(undefined)
    await act(async () => {
      await plain.result.current.completeSingle(CELLS[1] as never)
    })
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual(sent[1])
    expect(sent[0].system).not.toContain("Scripture quotations")
  })

  it("batch: one call carries the union of its cells' verses", async () => {
    stubModel()
    const blockFor = fakeBlockFor()
    const { result } = render(blockFor)
    await act(async () => {
      await result.current.completeBatch(CELLS as never)
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].user).toContain("<v1>")
    expect(sent[0].system).toContain("VERSES-FOR-c1")
    expect(sent[0].system).toContain("VERSES-FOR-c3")
  })

  it("batch fallback: a dropped segment is redrafted alone with only its own verses", async () => {
    stubModel({ dropSegment: 3 })
    const { result } = render(fakeBlockFor())
    await act(async () => {
      await result.current.completeBatch(CELLS as never)
    })
    // The chunk, then the per-cell fallback for c3.
    expect(sent).toHaveLength(2)
    expect(sent[1].user).not.toContain("<v1>")
    expect(sent[1].user).toContain("Read John 3:16 again.")
    expect(sent[1].system).toContain("VERSES-FOR-c3")
    expect(sent[1].system).not.toContain("VERSES-FOR-c1")
  })

  it("paragraph: the draftable cells' verses ride the system prompt", async () => {
    stubModel()
    const blockFor = fakeBlockFor()
    const { result } = render(blockFor)
    await act(async () => {
      await result.current.completeParagraph("c2")
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].user).toContain('<c id="c1">')
    expect(sent[0].system).toContain("VERSES-FOR-c1")
    expect(sent[0].system).toContain("VERSES-FOR-c3")
  })

  it("a failed verse lookup still drafts, without the block", async () => {
    stubModel()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { result, commit } = render(vi.fn().mockRejectedValue(new Error("offline")))
    let ok = false
    await act(async () => {
      ok = await result.current.completeSingle(CELLS[0] as never)
    })
    expect(ok).toBe(true)
    expect(commit).toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    expect(sent[0].system).not.toContain("Scripture quotations")
    expect(warn).toHaveBeenCalledWith("[useCompletion] reference verses lookup failed:", expect.any(Error))
    warn.mockRestore()
  })
})
