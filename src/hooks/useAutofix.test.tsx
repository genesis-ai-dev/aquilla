import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import * as Y from "yjs"

vi.mock("@/lib/rules/autofix", async (orig) => {
  const actual = await orig<typeof import("@/lib/rules/autofix")>()
  return { ...actual, requestBatchFix: vi.fn(), requestSurgicalFix: vi.fn() }
})
vi.mock("@/lib/store/project-index", () => ({ updateProject: vi.fn(async () => {}) }))

import { useAutofix } from "./useAutofix"
import { requestBatchFix, requestSurgicalFix } from "@/lib/rules/autofix"
import { updateProject } from "@/lib/store/project-index"
import type { ProjectRecord, TranslationRule } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"

function baseProject(rule?: TranslationRule): ProjectRecord {
  return {
    id: "p1", name: "Demo", sourceLanguage: "en", targetLanguage: "fr",
    files: [], members: [], createdAt: "", updatedAt: "", rules: rule ? [rule] : [],
    completionSettings: {
      endpoint: "", model: "m", maxTokens: 1024, temperature: 0.2,
      systemPrompt: "", llmHealthPenalty: 0.1, provider: "frontier",
    },
  } as ProjectRecord
}

const rule: TranslationRule = {
  id: "r1", name: "r", description: "", severity: "minor", source: "llm", scope: "project",
  check: { type: "target-forbids", targetPattern: "foo" }, enabled: true, createdAt: "",
}

function makeCell(id: string, translated: string): CellData {
  return { id, original: "src", translated, fileId: "f1", status: "unvalidated" } as unknown as CellData
}

function setupDoc(cells: { id: string; value: string }[]): Y.Doc {
  const doc = new Y.Doc()
  const map = doc.getMap("cells")
  for (const c of cells) {
    const cell = new Y.Map()
    cell.set("translated", c.value)
    map.set(c.id, cell)
  }
  return doc
}

describe("useAutofix.tryFixAll", () => {
  beforeEach(() => {
    vi.mocked(requestBatchFix).mockReset()
    vi.mocked(requestSurgicalFix).mockReset()
    vi.mocked(updateProject).mockReset()
  })

  it("uses cached regex when rule.autofix exists and it changes at least one cell", async () => {
    const ruleWithFix: TranslationRule = { ...rule, autofix: { kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g" } }
    const project = baseProject(ruleWithFix)
    const cells = [makeCell("c1", "foo here"), makeCell("c2", "no match")]
    const doc = setupDoc([{ id: "c1", value: "foo here" }, { id: "c2", value: "no match" }])

    const { result } = renderHook(() => useAutofix({ project, doc, username: "alice", refresh: () => {}, cellsByFile: new Map([["f1", cells]]) }))
    let proposal: any
    await act(async () => {
      proposal = await result.current.tryFixAll(ruleWithFix)
    })
    expect(proposal.kind).toBe("regex-replace")
    expect(proposal.previews.map((p: any) => p.cellId)).toEqual(["c1"])
    expect(proposal.previews[0].source).toBe("cached-regex")
    expect(vi.mocked(requestBatchFix)).not.toHaveBeenCalled()
  })

  it("falls back to LLM when cached regex produces no previews", async () => {
    const ruleWithFix: TranslationRule = { ...rule, autofix: { kind: "regex-replace", pattern: "xyz", replacement: "q", flags: "g" } }
    const project = baseProject(ruleWithFix)
    const cells = [makeCell("c1", "foo here")]
    vi.mocked(requestBatchFix).mockResolvedValueOnce({
      kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g",
      previews: [{ cellId: "c1", fileId: "f1", before: "foo here", after: "bar here", source: "llm" }],
    })
    const doc = setupDoc([{ id: "c1", value: "foo here" }])
    const { result } = renderHook(() => useAutofix({ project, doc, username: "alice", refresh: () => {}, cellsByFile: new Map([["f1", cells]]) }))
    await act(async () => { await result.current.tryFixAll(ruleWithFix) })
    expect(vi.mocked(requestBatchFix)).toHaveBeenCalledTimes(1)
  })

  it("applies selected previews, commits to Yjs, saves autofix on first apply, and increments counters", async () => {
    const project = baseProject(rule)
    const cells = [makeCell("c1", "foo here"), makeCell("c2", "foo again")]
    vi.mocked(requestBatchFix).mockResolvedValueOnce({
      kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g",
      previews: [
        { cellId: "c1", fileId: "f1", before: "foo here", after: "bar here", source: "llm" },
        { cellId: "c2", fileId: "f1", before: "foo again", after: "bar again", source: "llm" },
      ],
    })
    const doc = setupDoc([{ id: "c1", value: "foo here" }, { id: "c2", value: "foo again" }])
    const { result } = renderHook(() => useAutofix({ project, doc, username: "alice", refresh: () => {}, cellsByFile: new Map([["f1", cells]]) }))
    let proposal: any
    await act(async () => { proposal = await result.current.tryFixAll(rule) })

    await act(async () => {
      await result.current.applyProposal(rule, proposal, new Set(["c1", "c2"]))
    })

    // Yjs cells updated
    const c1 = (doc.getMap("cells").get("c1") as Y.Map<unknown>).get("translated")
    expect(c1).toBe("bar here")
    // updateProject called with rule.autofix set and usage counters incremented
    expect(vi.mocked(updateProject)).toHaveBeenCalled()
    const saved = vi.mocked(updateProject).mock.calls.at(-1)![0]
    const savedRule = saved.rules!.find((r) => r.id === "r1")!
    expect(savedRule.autofix).toEqual({ kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g" })
    expect(saved.usage?.fixesApplied).toBe(1)
  })

  it("skips cells whose text changed between preview and apply (staleness)", async () => {
    const project = baseProject(rule)
    const cells = [makeCell("c1", "foo here")]
    const doc = setupDoc([{ id: "c1", value: "foo here" }])
    const proposal = {
      kind: "regex-replace" as const, pattern: "foo", replacement: "bar", flags: "g",
      previews: [{ cellId: "c1", fileId: "f1", before: "foo here", after: "bar here", source: "llm" as const }],
    }
    // Mutate cell externally before apply so regex no longer matches.
    ;(doc.getMap("cells").get("c1") as Y.Map<unknown>).set("translated", "nothing to match")
    const { result } = renderHook(() => useAutofix({ project, doc, username: "alice", refresh: () => {}, cellsByFile: new Map([["f1", cells]]) }))
    let report: any
    await act(async () => {
      report = await result.current.applyProposal(rule, proposal, new Set(["c1"]))
    })
    expect(report.applied).toBe(0)
    expect(report.skipped).toBe(1)
  })
})
