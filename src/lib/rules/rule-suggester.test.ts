import { describe, it, expect, vi, beforeEach } from "vitest"
import { candidateWindow, parseRuleSuggestions, suggestRulesFromCandidates, suggestRulesFromPairs } from "./rule-suggester"
import type { EditCandidate } from "./edit-miner"

vi.mock("@/lib/completion/completion-service", () => ({ complete: vi.fn() }))
import { complete } from "@/lib/completion/completion-service"

describe("parseRuleSuggestions", () => {
  it("parses a valid JSON array", () => {
    const raw = `[{"name":"Preserve numbers","description":"Numbers must match","severity":"major","check":{"type":"source-target-match","pattern":"\\\\d+"}}]`
    const result = parseRuleSuggestions(raw)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Preserve numbers")
    expect(result[0].severity).toBe("major")
    expect(result[0].check.type).toBe("source-target-match")
  })

  it("strips markdown code fences", () => {
    const raw = "```json\n[{\"name\":\"Test\",\"description\":\"d\",\"severity\":\"minor\",\"check\":{\"type\":\"target-forbids\",\"targetPattern\":\"bad\"}}]\n```"
    const result = parseRuleSuggestions(raw)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Test")
  })

  it("handles surrounding prose", () => {
    const raw = `Here are the rules:\n\n[{"name":"R","description":"d","severity":"minor","check":{"type":"target-forbids","targetPattern":"x"}}]\n\nThat's all.`
    const result = parseRuleSuggestions(raw)
    expect(result).toHaveLength(1)
  })

  it("returns empty array for invalid JSON", () => {
    expect(parseRuleSuggestions("not json")).toEqual([])
    expect(parseRuleSuggestions("[unclosed")).toEqual([])
  })

  it("returns empty array for missing array", () => {
    expect(parseRuleSuggestions("{}")).toEqual([])
  })

  it("filters out invalid suggestions", () => {
    const raw = JSON.stringify([
      { name: "Valid", description: "d", severity: "major", check: { type: "target-forbids", targetPattern: "x" } },
      { name: "", description: "", severity: "major", check: { type: "target-forbids", targetPattern: "x" } }, // empty name
      { name: "Bad severity", description: "", severity: "critical", check: { type: "target-forbids", targetPattern: "x" } },
      { name: "Missing check", description: "", severity: "major" },
      { name: "Wrong check type", description: "", severity: "major", check: { type: "unknown" } },
    ])
    const result = parseRuleSuggestions(raw)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Valid")
  })

  it("validates source-requires-target needs both patterns", () => {
    const raw = JSON.stringify([
      { name: "Complete", description: "", severity: "major", check: { type: "source-requires-target", sourcePattern: "\\d+", targetPattern: "\\d+" } },
      { name: "Missing target", description: "", severity: "major", check: { type: "source-requires-target", sourcePattern: "\\d+" } },
    ])
    const result = parseRuleSuggestions(raw)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Complete")
  })
})

describe("suggestRulesFromPairs usage callback", () => {
  beforeEach(() => vi.mocked(complete).mockReset())

  it("invokes onLlmCall with kind=rule-suggestion after a successful call", async () => {
    vi.mocked(complete).mockResolvedValueOnce("[]")
    const onLlmCall = vi.fn()
    await suggestRulesFromPairs(
      [{ source: "a", target: "b" }],
      { endpoint: "", model: "m", maxTokens: 512, temperature: 0.2, systemPrompt: "", llmHealthPenalty: 0.1, provider: "custom" },
      null,
      onLlmCall,
    )
    expect(onLlmCall).toHaveBeenCalledTimes(1)
    expect(onLlmCall.mock.calls[0][0]).toMatchObject({ kind: "rule-suggestion", provider: "custom", model: "m" })
  })
})

// "Suggest more" in the rules list asks the LLM again and again. Each batch
// must look at different edits and must not re-propose rules already in the
// list, or the button just hands back the same handful forever.
describe("suggestRulesFromCandidates batching", () => {
  beforeEach(() => vi.mocked(complete).mockReset())

  const settings = { endpoint: "", model: "m", maxTokens: 512, temperature: 0.2, systemPrompt: "", llmHealthPenalty: 0.1, provider: "custom" as const }
  const candidates: EditCandidate[] = Array.from({ length: 50 }, (_, i) => ({
    kind: "human-authored",
    evidence: `edit ${i}`,
    score: 50 - i,
    sourceSample: `source-${i}`,
    targetSample: `target-${i}`,
    key: `k${i}`,
  }))
  const promptOf = () => vi.mocked(complete).mock.calls[0][0].messages[1].content

  it("a later batch shows the model different edits than the first", async () => {
    vi.mocked(complete).mockResolvedValue("[]")
    await suggestRulesFromCandidates(candidates, settings, null, undefined, { offset: 20 })
    expect(promptOf()).toContain('"source-20"')
    expect(promptOf()).not.toContain('"source-0"')
  })

  it("tells the model which rules already exist so it proposes new ones", async () => {
    vi.mocked(complete).mockResolvedValue("[]")
    await suggestRulesFromCandidates(candidates, settings, null, undefined, { exclude: ["Preserve verse numbers"] })
    expect(promptOf()).toMatch(/Do not propose them again[\s\S]*Preserve verse numbers/)
  })

  it("a focused ask names the focus and widens the window", async () => {
    vi.mocked(complete).mockResolvedValue("[]")
    await suggestRulesFromCandidates(candidates, settings, null, undefined, { focus: "punctuation" })
    expect(promptOf()).toContain('rules about: "punctuation"')
    expect(promptOf()).toContain('"source-39"')
  })
})

describe("candidateWindow", () => {
  it("wraps past the end so a late batch on a small corpus is never empty", () => {
    expect(candidateWindow([1, 2, 3, 4, 5], 4, 3)).toEqual([5, 1, 2])
  })
  it("returns everything when the corpus fits in one window", () => {
    expect(candidateWindow([1, 2], 7, 20)).toEqual([1, 2])
  })
})
