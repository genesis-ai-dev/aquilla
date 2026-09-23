import { beforeEach, describe, expect, it, vi } from "vitest"

// Both dependencies are mocked: extraction must be exercised without a network
// or an LLM. The factories run before the module under test is imported.
vi.mock("@/lib/completion/completion-service", () => ({ complete: vi.fn() }))
vi.mock("@/lib/frontier/knowledge-base", () => ({ getKnowledgeDocumentContent: vi.fn() }))

import { complete } from "@/lib/completion/completion-service"
import { getKnowledgeDocumentContent, type KnowledgeNode } from "@/lib/frontier/knowledge-base"
import type { CompletionSettings } from "@/lib/parsers/types"
import {
  extractStyleRulesFromDoc,
  flattenLeafNodes,
  parseStyleRuleCandidates,
  validateCheckSpec,
} from "./style-rule-extractor"

const completeMock = vi.mocked(complete)
const contentMock = vi.mocked(getKnowledgeDocumentContent)

const SETTINGS = { model: "test-model", maxTokens: 8192, temperature: 0.7 } as CompletionSettings

function node(id: string, title = `Section ${id}`): KnowledgeNode {
  return { id, title, charStart: 0, charEnd: 100 }
}

function candidateJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    { instruction: "Render divine names in small caps.", category: "formatting", scopeHint: "global", ...overrides },
  ])
}

beforeEach(() => {
  completeMock.mockReset()
  contentMock.mockReset()
})

describe("parseStyleRuleCandidates", () => {
  it("parses a plain JSON array", () => {
    const parsed = parseStyleRuleCandidates(candidateJson())
    expect(parsed).toEqual([
      {
        instruction: "Render divine names in small caps.",
        category: "formatting",
        scopeHint: "global",
      },
    ])
  })

  it("strips markdown code fences", () => {
    expect(parseStyleRuleCandidates("```json\n" + candidateJson() + "\n```")).toHaveLength(1)
  })

  it("ignores prose surrounding the array", () => {
    const raw = `Here are the rules I found:\n${candidateJson()}\nLet me know if you need more.`
    expect(parseStyleRuleCandidates(raw)).toHaveLength(1)
  })

  it("returns [] for invalid JSON, a non-array, or no array at all", () => {
    expect(parseStyleRuleCandidates("[{oops}]")).toEqual([])
    expect(parseStyleRuleCandidates('{"instruction":"x"}')).toEqual([])
    expect(parseStyleRuleCandidates("no rules here")).toEqual([])
  })

  it("drops entries with an unknown category or a blank instruction", () => {
    const raw = JSON.stringify([
      { instruction: "Keep it formal.", category: "vibes", scopeHint: "global" },
      { instruction: "   ", category: "style", scopeHint: "global" },
      { instruction: "Keep numerals as digits.", category: "orthography", scopeHint: "global" },
    ])
    expect(parseStyleRuleCandidates(raw).map((c) => c.instruction)).toEqual([
      "Keep numerals as digits.",
    ])
  })

  it("drops entries whose scopeHint is missing or malformed", () => {
    const raw = JSON.stringify([
      { instruction: "A", category: "style" },
      { instruction: "B", category: "style", scopeHint: "chapter:3" },
      { instruction: "C", category: "style", scopeHint: "genre:" },
      { instruction: "D", category: "style", scopeHint: "genre:poetry" },
    ])
    expect(parseStyleRuleCandidates(raw).map((c) => c.instruction)).toEqual(["D"])
  })

  it("normalizes scopeHint case and uppercases book codes", () => {
    const raw = JSON.stringify([
      { instruction: "A", category: "style", scopeHint: "GLOBAL" },
      { instruction: "B", category: "style", scopeHint: "Book: psa" },
      { instruction: "C", category: "style", scopeHint: "Genre:Poetry" },
    ])
    expect(parseStyleRuleCandidates(raw).map((c) => c.scopeHint)).toEqual([
      "global",
      "book:PSA",
      "genre:Poetry",
    ])
  })

  it("keeps a valid checkSpec and strips an invalid one without dropping the rule", () => {
    const valid = parseStyleRuleCandidates(
      candidateJson({ checkSpec: { type: "target-forbids", targetPattern: "\\bLORD\\b" } }),
    )
    expect(valid[0].checkSpec).toEqual({ type: "target-forbids", targetPattern: "\\bLORD\\b" })

    const stripped = parseStyleRuleCandidates(
      candidateJson({ checkSpec: { type: "made-up-check", pattern: "x" } }),
    )
    expect(stripped).toHaveLength(1)
    expect(stripped[0].checkSpec).toBeUndefined()
  })

  it("strips a checkSpec whose regex does not compile", () => {
    const parsed = parseStyleRuleCandidates(
      candidateJson({ checkSpec: { type: "target-forbids", targetPattern: "([unclosed" } }),
    )
    expect(parsed).toHaveLength(1)
    expect(parsed[0].checkSpec).toBeUndefined()
  })

  it("keeps only well-formed examples and drops empty ones", () => {
    const parsed = parseStyleRuleCandidates(
      candidateJson({ examples: [{ before: "the LORD" }, {}, { note: "" }, { after: "the Lord" }] }),
    )
    expect(parsed[0].examples).toEqual([{ before: "the LORD" }, { after: "the Lord" }])
  })
})

describe("validateCheckSpec", () => {
  it("accepts each supported check type", () => {
    expect(validateCheckSpec({ type: "source-target-match", pattern: "\\d+" })).toEqual({
      type: "source-target-match",
      pattern: "\\d+",
    })
    expect(
      validateCheckSpec({ type: "source-requires-target", sourcePattern: "a", targetPattern: "b" }),
    ).toEqual({ type: "source-requires-target", sourcePattern: "a", targetPattern: "b" })
  })

  it("rejects unknown shapes, non-objects, and partial patterns", () => {
    expect(validateCheckSpec(null)).toBeNull()
    expect(validateCheckSpec("target-forbids")).toBeNull()
    expect(validateCheckSpec({ type: "builtin", checkId: "double-space" })).toBeNull()
    expect(validateCheckSpec({ type: "source-requires-target", sourcePattern: "a" })).toBeNull()
  })
})

describe("flattenLeafNodes", () => {
  it("returns leaves in document order and skips parents", () => {
    const tree: KnowledgeNode[] = [
      { ...node("n1"), children: [node("n1.1"), node("n1.2")] },
      node("n2"),
    ]
    expect(flattenLeafNodes(tree).map((n) => n.id)).toEqual(["n1.1", "n1.2", "n2"])
  })

  it("treats a node with an empty children array as a leaf", () => {
    expect(flattenLeafNodes([{ ...node("n1"), children: [] }]).map((n) => n.id)).toEqual(["n1"])
  })
})

describe("extractStyleRulesFromDoc", () => {
  const baseInput = {
    scope: { kind: "project" as const, id: "p1" },
    docId: "doc-1",
    jwt: "jwt",
    settings: SETTINGS,
  }

  it("cites each candidate with the node it came from and reports progress", async () => {
    contentMock.mockResolvedValue("Divine names are set in small caps throughout.")
    completeMock.mockResolvedValue(candidateJson())
    const progress: Array<[number, number, number]> = []

    const found = await extractStyleRulesFromDoc({
      ...baseInput,
      nodes: [node("n1", "Typography"), node("n2", "Names")],
      onProgress: (index, total, count) => progress.push([index, total, count]),
    })

    expect(found).toHaveLength(2)
    expect(found[0].nodeId).toBe("n1")
    expect(found[0].nodeTitle).toBe("Typography")
    expect(found[0].quote).toBe("Divine names are set in small caps throughout.")
    expect(found[1].nodeId).toBe("n2")
    expect(progress).toEqual([
      [0, 2, 0],
      [1, 2, 1],
      [2, 2, 2],
    ])
  })

  it("caps the token budget and pins a low temperature", async () => {
    contentMock.mockResolvedValue("text")
    completeMock.mockResolvedValue("[]")

    await extractStyleRulesFromDoc({ ...baseInput, nodes: [node("n1")] })

    const settings = completeMock.mock.calls[0][0].settings
    expect(settings.maxTokens).toBe(2048)
    expect(settings.temperature).toBe(0.1)
  })

  it("skips a blank section without calling the model", async () => {
    contentMock.mockResolvedValue("   ")
    completeMock.mockResolvedValue(candidateJson())

    const found = await extractStyleRulesFromDoc({ ...baseInput, nodes: [node("n1")] })

    expect(found).toEqual([])
    expect(completeMock).not.toHaveBeenCalled()
  })

  it("reports usage per completed node", async () => {
    contentMock.mockResolvedValue("text")
    completeMock.mockResolvedValue("[]")
    const onLlmCall = vi.fn()

    await extractStyleRulesFromDoc({ ...baseInput, nodes: [node("n1")], onLlmCall })

    expect(onLlmCall).toHaveBeenCalledWith(expect.objectContaining({ kind: "style-rule-extract" }))
  })

  it("stops at the next node when aborted and keeps what it already found", async () => {
    const controller = new AbortController()
    contentMock.mockResolvedValue("text")
    completeMock.mockImplementation(async () => {
      controller.abort()
      return candidateJson()
    })

    const found = await extractStyleRulesFromDoc({
      ...baseInput,
      nodes: [node("n1"), node("n2"), node("n3")],
      signal: controller.signal,
    })

    expect(found).toHaveLength(1)
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it("propagates a genuine failure rather than silently returning partial results", async () => {
    contentMock.mockResolvedValue("text")
    completeMock.mockRejectedValue(new Error("model unavailable"))

    await expect(
      extractStyleRulesFromDoc({ ...baseInput, nodes: [node("n1")] }),
    ).rejects.toThrow("model unavailable")
  })
})
