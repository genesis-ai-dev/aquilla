import { describe, it, expect, vi, beforeEach } from "vitest"
import { applyRegexFix, applyLiteralFix } from "./autofix"
import { parseBatchResponse, parsePerCellResponse } from "./autofix"
import { buildRegexProposal, buildPerCellProposal } from "./autofix"
import { requestBatchFix, requestSurgicalFix } from "./autofix"
import { buildOrthographyProposal, hasOrthographyFix } from "./autofix"
import { CANONICAL_APOSTROPHE, type OrthographyProfile } from "../../../db/shared/orthography"
import type { CellData } from "@/hooks/useCells"
import type { TranslationRule, CompletionSettings } from "@/lib/parsers/types"

// Mock the completion service so tests don't hit the network.
vi.mock("@/lib/completion/completion-service", () => ({
  complete: vi.fn(),
}))

import { complete } from "@/lib/completion/completion-service"

function cell(id: string, translated: string, original = ""): CellData {
  return {
    id, original, translated, fileId: "f1", status: "translated",
  } as unknown as CellData
}

describe("applyRegexFix", () => {
  it("replaces all matches with global flag", () => {
    const fix = { kind: "regex-replace" as const, pattern: "\\bfoo\\b", replacement: "bar", flags: "gi" }
    expect(applyRegexFix(fix, "foo and Foo and foobar")).toBe("bar and bar and foobar")
  })

  it("replaces first only without global flag", () => {
    const fix = { kind: "regex-replace" as const, pattern: "foo", replacement: "bar", flags: "i" }
    expect(applyRegexFix(fix, "foo and foo")).toBe("bar and foo")
  })

  it("supports capture-group backreferences", () => {
    const fix = { kind: "regex-replace" as const, pattern: "(\\d+) dollars", replacement: "$$$1", flags: "g" }
    expect(applyRegexFix(fix, "5 dollars and 10 dollars")).toBe("$5 and $10")
  })

  it("returns original text when pattern does not match", () => {
    const fix = { kind: "regex-replace" as const, pattern: "xyz", replacement: "q", flags: "g" }
    expect(applyRegexFix(fix, "abc")).toBe("abc")
  })

  it("throws for invalid regex", () => {
    const fix = { kind: "regex-replace" as const, pattern: "(", replacement: "x", flags: "g" }
    expect(() => applyRegexFix(fix, "anything")).toThrow()
  })
})

describe("applyLiteralFix", () => {
  it("replaces all occurrences literally", () => {
    expect(applyLiteralFix("don't", "do not", "I don't but you don't either")).toBe("I do not but you do not either")
  })

  it("preserves surrounding formatting (markdown-like)", () => {
    expect(applyLiteralFix("foo", "bar", "**foo** and _foo_")).toBe("**bar** and _bar_")
  })

  it("returns original when find not present", () => {
    expect(applyLiteralFix("x", "y", "abc")).toBe("abc")
  })

  it("is safe with regex metacharacters in find", () => {
    expect(applyLiteralFix("a.b", "ab", "a.b and a.b and axb")).toBe("ab and ab and axb")
  })
})

describe("parseBatchResponse", () => {
  it("parses a regex-replace response", () => {
    const raw = `{"kind":"regex-replace","pattern":"foo","replacement":"bar","flags":"gi","rationale":"r"}`
    expect(parseBatchResponse(raw)).toEqual({
      kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "gi", rationale: "r",
    })
  })

  it("parses a none response", () => {
    const raw = `{"kind":"none","reason":"too semantic"}`
    expect(parseBatchResponse(raw)).toEqual({ kind: "none", reason: "too semantic" })
  })

  it("strips markdown code fences", () => {
    const raw = "```json\n{\"kind\":\"none\",\"reason\":\"r\"}\n```"
    expect(parseBatchResponse(raw)).toEqual({ kind: "none", reason: "r" })
  })

  it("returns null for invalid JSON", () => {
    expect(parseBatchResponse("not json")).toBeNull()
  })

  it("returns null for unknown kind", () => {
    expect(parseBatchResponse(`{"kind":"ignore"}`)).toBeNull()
  })

  it("returns null when regex-replace is missing required fields", () => {
    expect(parseBatchResponse(`{"kind":"regex-replace","pattern":"p"}`)).toBeNull()
  })
})

describe("parsePerCellResponse", () => {
  it("parses valid fixes", () => {
    const raw = `{"kind":"per-cell","fixes":[{"cellId":"c1","find":"a","replace":"b","rationale":"r"}]}`
    const parsed = parsePerCellResponse(raw)
    expect(parsed?.kind).toBe("per-cell")
    expect(parsed?.kind === "per-cell" && parsed.fixes).toHaveLength(1)
  })

  it("parses none", () => {
    const raw = `{"kind":"none","reason":"r"}`
    expect(parsePerCellResponse(raw)).toEqual({ kind: "none", reason: "r" })
  })

  it("filters malformed fix entries", () => {
    const raw = JSON.stringify({
      kind: "per-cell",
      fixes: [
        { cellId: "c1", find: "a", replace: "b" },
        { cellId: "c2", find: "x" }, // missing replace
        { find: "a", replace: "b" },  // missing cellId
        "bad",
      ],
    })
    const parsed = parsePerCellResponse(raw)
    expect(parsed?.kind === "per-cell" && parsed.fixes.map((f) => f.cellId)).toEqual(["c1"])
  })

  it("returns null for invalid JSON", () => {
    expect(parsePerCellResponse("garbage")).toBeNull()
  })
})

describe("buildRegexProposal", () => {
  it("produces previews only for cells the regex changes", () => {
    const prop = buildRegexProposal(
      { kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g" },
      [cell("c1", "foo here"), cell("c2", "no match"), cell("c3", "another foo")],
      "llm",
    )
    expect(prop.kind).toBe("regex-replace")
    if (prop.kind !== "regex-replace") throw new Error("wrong kind")
    expect(prop.previews.map((p) => p.cellId)).toEqual(["c1", "c3"])
    expect(prop.previews[0]).toMatchObject({ before: "foo here", after: "bar here", source: "llm" })
  })

  it("marks source as cached-regex when flagged", () => {
    const prop = buildRegexProposal(
      { kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g" },
      [cell("c1", "foo")],
      "cached-regex",
    )
    if (prop.kind !== "regex-replace") throw new Error("wrong kind")
    expect(prop.previews[0].source).toBe("cached-regex")
  })
})

describe("buildPerCellProposal", () => {
  it("produces a preview per valid fix and filters hallucinated find strings", () => {
    const cells = [cell("c1", "I don't go"), cell("c2", "do nothing"), cell("c3", "hello world")]
    const response = {
      kind: "per-cell" as const,
      fixes: [
        { cellId: "c1", find: "don't", replace: "do not" },
        { cellId: "c2", find: "banana", replace: "x" },   // hallucinated — filter
        { cellId: "c3", find: "world", replace: "earth" },
        { cellId: "c999", find: "a", replace: "b" },       // unknown cell — filter
      ],
    }
    const prop = buildPerCellProposal(response, cells)
    if (prop.kind !== "per-cell") throw new Error("wrong kind")
    expect(prop.previews.map((p) => p.cellId)).toEqual(["c1", "c3"])
    expect(prop.previews[0]).toMatchObject({ before: "I don't go", after: "I do not go", find: "don't", replace: "do not" })
  })
})

const settings: CompletionSettings = {
  endpoint: "", model: "m", maxTokens: 1024, temperature: 0.2, systemPrompt: "",
}

const sampleRule: TranslationRule = {
  id: "r1", name: "No 'foo'", description: "", severity: "minor", source: "llm", scope: "project",
  check: { type: "target-forbids", targetPattern: "foo" }, enabled: true, createdAt: "",
}

describe("requestBatchFix", () => {
  beforeEach(() => vi.mocked(complete).mockReset())

  it("returns regex-replace when LLM returns a working regex", async () => {
    vi.mocked(complete).mockResolvedValueOnce(`{"kind":"regex-replace","pattern":"foo","replacement":"bar","flags":"g"}`)
    const cells = [cell("c1", "foo here"), cell("c2", "clean"), cell("c3", "foo again")]
    const passing = [cell("p1", "ok")]
    const prop = await requestBatchFix({ rule: sampleRule, violatingCells: cells, passingCells: passing, settings, session: null })
    expect(prop.kind).toBe("regex-replace")
    if (prop.kind !== "regex-replace") return
    expect(prop.previews.map((p) => p.cellId)).toEqual(["c1", "c3"])
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(1)
  })

  it("falls back to per-cell when LLM returns none and violations < 10", async () => {
    vi.mocked(complete)
      .mockResolvedValueOnce(`{"kind":"none","reason":"semantic"}`)
      .mockResolvedValueOnce(`{"kind":"per-cell","fixes":[{"cellId":"c1","find":"foo","replace":"bar"}]}`)
    const cells = [cell("c1", "foo here"), cell("c2", "clean foo")]
    const prop = await requestBatchFix({ rule: sampleRule, violatingCells: cells, passingCells: [], settings, session: null })
    expect(prop.kind).toBe("per-cell")
    if (prop.kind !== "per-cell") return
    expect(prop.previews).toHaveLength(1)
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(2)
  })

  it("does not attempt semantic when violations >= 10 and attempt 1 fails", async () => {
    vi.mocked(complete).mockResolvedValueOnce(`{"kind":"none","reason":"nope"}`)
    const cells = Array.from({ length: 10 }, (_, i) => cell(`c${i}`, `foo ${i}`))
    const prop = await requestBatchFix({ rule: sampleRule, violatingCells: cells, passingCells: [], settings, session: null })
    expect(prop.kind).toBe("none")
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(1)
  })

  it("returns none with safe reason when complete throws", async () => {
    vi.mocked(complete).mockRejectedValueOnce(new Error("boom"))
    const prop = await requestBatchFix({ rule: sampleRule, violatingCells: [cell("c1", "foo")], passingCells: [], settings, session: null })
    expect(prop).toEqual({ kind: "none", reason: "Could not apply fixes" })
  })

  it("coerces to none if regex does not change any breaking cell", async () => {
    vi.mocked(complete)
      .mockResolvedValueOnce(`{"kind":"regex-replace","pattern":"xyz","replacement":"q","flags":"g"}`)
      .mockResolvedValueOnce(`{"kind":"none","reason":"still nothing"}`)
    const prop = await requestBatchFix({ rule: sampleRule, violatingCells: [cell("c1", "foo")], passingCells: [], settings, session: null })
    // regex didn't change the cell → coerced to none → semantic fallback runs (1 violation < 10)
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(2)
    expect(prop.kind).toBe("none")
  })
})

describe("requestSurgicalFix", () => {
  beforeEach(() => vi.mocked(complete).mockReset())

  it("returns a per-cell proposal for a single cell", async () => {
    vi.mocked(complete).mockResolvedValueOnce(`{"kind":"per-cell","fixes":[{"cellId":"c1","find":"foo","replace":"bar"}]}`)
    const prop = await requestSurgicalFix({ rule: sampleRule, cell: cell("c1", "foo here"), settings, session: null })
    expect(prop.kind).toBe("per-cell")
    if (prop.kind !== "per-cell") return
    expect(prop.previews[0]).toMatchObject({ before: "foo here", after: "bar here" })
  })

  it("returns none on network error", async () => {
    vi.mocked(complete).mockRejectedValueOnce(new Error("net"))
    const prop = await requestSurgicalFix({ rule: sampleRule, cell: cell("c1", "foo"), settings, session: null })
    expect(prop).toEqual({ kind: "none", reason: "Could not apply fixes" })
  })
})

// ── AQU-2642 §1: the old-orthography fix is computed, not asked ───────────

const uzbek = {
  rules: [["sh", "ş"], ["ch", "ç"], ["oʻ", "ö"], ["gʻ", "ğ"]],
  apostrophe: CANONICAL_APOSTROPHE,
  exceptions: [{ word: "Isʼhoq", status: "approved" }],
} as const satisfies OrthographyProfile

function orthographyRule(orthography: OrthographyProfile | null): TranslationRule {
  return {
    id: "builtin:old-orthography", name: "Old orthography", description: "",
    severity: "major", source: "algorithmic", scope: "project", enabled: true, createdAt: "",
    check: { type: "builtin", checkId: "old-orthography", orthography },
  }
}

describe("buildOrthographyProposal", () => {
  it("corrects each flagged word from the lane's own rules", () => {
    const prop = buildOrthographyProposal(orthographyRule(uzbek), [cell("c1", "shahar va chiroq")])
    expect(prop?.kind).toBe("per-cell")
    if (prop?.kind !== "per-cell") return
    expect(prop.previews[0]).toMatchObject({
      cellId: "c1", before: "shahar va chiroq", after: "şahar va çiroq", source: "orthography",
    })
  })

  it("carries find/replace only when every flagged word is the same word", () => {
    const one = buildOrthographyProposal(orthographyRule(uzbek), [cell("c1", "shahar va shahar")])
    const two = buildOrthographyProposal(orthographyRule(uzbek), [cell("c2", "shahar va chiroq")])
    expect(one?.kind === "per-cell" && one.previews[0]).toMatchObject({ find: "shahar", replace: "şahar" })
    expect(two?.kind === "per-cell" && two.previews[0].find).toBeUndefined()
  })

  it("leaves an approved exception alone, as the check does", () => {
    expect(buildOrthographyProposal(orthographyRule(uzbek), [cell("c1", "Ishoqning kitobi")])).toBeNull()
  })

  it("is null for another check, and for a lane with no profile", () => {
    expect(buildOrthographyProposal(sampleRule, [cell("c1", "shahar")])).toBeNull()
    expect(buildOrthographyProposal(orthographyRule(null), [cell("c1", "shahar")])).toBeNull()
  })

  it("skips cells with nothing flagged rather than previewing a no-op", () => {
    const prop = buildOrthographyProposal(orthographyRule(uzbek), [cell("c1", "şahar"), cell("c2", "chiroq")])
    expect(prop?.kind === "per-cell" && prop.previews.map((p) => p.cellId)).toEqual(["c2"])
  })
})

describe("hasOrthographyFix", () => {
  it("is true only for the orthography check with a profile", () => {
    expect(hasOrthographyFix(orthographyRule(uzbek))).toBe(true)
    expect(hasOrthographyFix(orthographyRule(null))).toBe(false)
    expect(hasOrthographyFix(sampleRule)).toBe(false)
  })
})

describe("orthography fixes never reach the model", () => {
  beforeEach(() => vi.mocked(complete).mockReset())

  it("answers requestSurgicalFix without a completion call", async () => {
    const prop = await requestSurgicalFix({
      rule: orthographyRule(uzbek), cell: cell("c1", "shahar"), settings, session: null,
    })
    expect(vi.mocked(complete)).not.toHaveBeenCalled()
    expect(prop.kind === "per-cell" && prop.previews[0].after).toBe("şahar")
  })

  it("answers requestBatchFix with AI unconfigured", async () => {
    const prop = await requestBatchFix({
      rule: orthographyRule(uzbek), violatingCells: [cell("c1", "chiroq")], passingCells: [], session: null,
    })
    expect(vi.mocked(complete)).not.toHaveBeenCalled()
    expect(prop.kind === "per-cell" && prop.previews[0].after).toBe("çiroq")
  })

  it("still reports none for a non-orthography rule with AI unconfigured", async () => {
    const prop = await requestSurgicalFix({ rule: sampleRule, cell: cell("c1", "foo"), session: null })
    expect(vi.mocked(complete)).not.toHaveBeenCalled()
    expect(prop).toEqual({ kind: "none", reason: "Could not apply fixes" })
  })
})
