import { describe, it, expect } from "vitest"
import {
  checkInputSize,
  parseCandidates,
  parseCandidatesDetailed,
  parseStructuredRule,
  chunkDocument,
  candidateKey,
  MAX_INPUT_BYTES,
  PASS1_CHUNK_BYTES,
} from "./rule-extractor"

describe("checkInputSize", () => {
  it("accepts text under 200 KB", () => {
    const text = "a".repeat(100 * 1024)
    expect(checkInputSize(text).ok).toBe(true)
  })

  it("rejects text over 200 KB", () => {
    const text = "a".repeat(MAX_INPUT_BYTES + 1)
    const result = checkInputSize(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toMatch(/too large/i)
    }
  })

  it("accepts text exactly at the limit", () => {
    const text = "a".repeat(MAX_INPUT_BYTES)
    expect(checkInputSize(text).ok).toBe(true)
  })
})

describe("parseCandidates", () => {
  it("parses a simple JSON array of strings", () => {
    const raw = `["Numbers must be preserved", "URLs must not be translated"]`
    expect(parseCandidates(raw)).toEqual([
      "Numbers must be preserved",
      "URLs must not be translated",
    ])
  })

  it("strips markdown code fences", () => {
    const raw = "```json\n[\"Rule A\", \"Rule B\"]\n```"
    expect(parseCandidates(raw)).toEqual(["Rule A", "Rule B"])
  })

  it("returns empty array for null/invalid JSON", () => {
    expect(parseCandidates("null")).toEqual([])
    expect(parseCandidates("not json")).toEqual([])
    expect(parseCandidates("{}")).toEqual([])
  })

  it("filters out non-string entries", () => {
    const raw = `["Valid rule", 42, null, "Another rule"]`
    expect(parseCandidates(raw)).toEqual(["Valid rule", "Another rule"])
  })

  it("returns empty array for empty array", () => {
    expect(parseCandidates("[]")).toEqual([])
  })
})

describe("parseStructuredRule", () => {
  it("parses a valid source-target-match rule", () => {
    const raw = JSON.stringify({
      name: "Number preservation",
      description: "All numbers must appear verbatim in the target",
      severity: "major",
      check: { type: "source-target-match", pattern: "\\d+" },
    })
    const result = parseStructuredRule(raw)
    expect(result).not.toBeNull()
    expect(result?.name).toBe("Number preservation")
    expect(result?.check.type).toBe("source-target-match")
  })

  it("parses a valid target-forbids rule", () => {
    const raw = JSON.stringify({
      name: "No ellipsis",
      description: "Targets must not end with ellipsis",
      severity: "minor",
      check: { type: "target-forbids", targetPattern: "\\.{3}$" },
    })
    const result = parseStructuredRule(raw)
    expect(result).not.toBeNull()
    expect(result?.check.type).toBe("target-forbids")
  })

  it("parses a valid source-requires-target rule", () => {
    const raw = JSON.stringify({
      name: "Church term",
      description: "The word church must be translated as ekklesia",
      severity: "major",
      check: {
        type: "source-requires-target",
        sourcePattern: "church",
        targetPattern: "ekklesia",
      },
    })
    const result = parseStructuredRule(raw)
    expect(result).not.toBeNull()
    expect(result?.check.type).toBe("source-requires-target")
  })

  it("returns null for 'null' response", () => {
    expect(parseStructuredRule("null")).toBeNull()
  })

  it("returns null for missing required fields", () => {
    const raw = JSON.stringify({ name: "Incomplete", severity: "major" })
    expect(parseStructuredRule(raw)).toBeNull()
  })

  it("returns null for invalid check type", () => {
    const raw = JSON.stringify({
      name: "Bad",
      description: "x",
      severity: "major",
      check: { type: "unknown-type" },
    })
    expect(parseStructuredRule(raw)).toBeNull()
  })

  it("strips markdown code fences before parsing", () => {
    const inner = JSON.stringify({
      name: "Test",
      description: "desc",
      severity: "minor",
      check: { type: "target-forbids", targetPattern: "foo" },
    })
    const wrapped = "```json\n" + inner + "\n```"
    expect(parseStructuredRule(wrapped)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AQU-466 — hardening for real organisation style guides
// ---------------------------------------------------------------------------

/**
 * Shaped like a real org style guide: numbered sections, prose, a glossary
 * table, and the same conventions restated in more than one place.
 */
function styleGuideFixture(sections: number): string {
  const out: string[] = [
    "BIBLE TRANSLATION STYLE GUIDE",
    "",
    "1. GENERAL PRINCIPLES",
    "",
    "Translations should read naturally in the receptor language while",
    "preserving the meaning of the source. Numerals in the source text must be",
    "carried over exactly; do not spell them out.",
    "",
  ]
  for (let i = 0; i < sections; i++) {
    out.push(
      `${i + 2}. SECTION ${i + 2} — TERMINOLOGY AND PUNCTUATION`,
      "",
      "Divine names are rendered with the agreed receptor-language equivalent",
      "and are never transliterated from the source script. Footnote markers",
      "must be retained in the same order as the source. Quotation marks follow",
      "the receptor language's own convention, not the source's.",
      "",
      "Numerals in the source text must be carried over exactly.",
      "",
      "Glossary:",
      "  church        ->  ekklesia",
      "  covenant      ->  perjanjian",
      "  righteousness ->  kebenaran",
      "",
    )
  }
  return out.join("\n")
}

describe("chunkDocument (AQU-466)", () => {
  it("returns a short guide as a single chunk", () => {
    const doc = styleGuideFixture(1)
    expect(new TextEncoder().encode(doc).length).toBeLessThan(PASS1_CHUNK_BYTES)
    expect(chunkDocument(doc)).toEqual([doc.trim()])
  })

  it("returns no chunks for empty or whitespace-only input", () => {
    expect(chunkDocument("")).toEqual([])
    expect(chunkDocument("   \n\n  ")).toEqual([])
  })

  it("splits a full-length style guide into several budget-sized chunks", () => {
    const doc = styleGuideFixture(200)
    expect(new TextEncoder().encode(doc).length).toBeGreaterThan(PASS1_CHUNK_BYTES * 3)

    const chunks = chunkDocument(doc)
    expect(chunks.length).toBeGreaterThan(3)
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(PASS1_CHUNK_BYTES)
    }
  })

  it("preserves every non-blank line across the chunk boundaries", () => {
    const doc = styleGuideFixture(200)
    const lines = (s: string) =>
      s
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)

    expect(lines(chunkDocument(doc).join("\n"))).toEqual(lines(doc))
  })

  it("never cuts a line in half at a chunk boundary", () => {
    const doc = styleGuideFixture(200)
    const sourceLines = new Set(doc.split("\n").map((l) => l.trim()).filter(Boolean))
    for (const chunk of chunkDocument(doc)) {
      for (const line of chunk.split("\n").map((l) => l.trim()).filter(Boolean)) {
        expect(sourceLines.has(line)).toBe(true)
      }
    }
  })

  it("splits a guide that arrived as one giant line (PDF/DOCX extraction)", () => {
    // Text extracted from PDF often loses newlines entirely.
    const oneLine = styleGuideFixture(200).replace(/\n+/g, " ")
    const chunks = chunkDocument(oneLine)

    expect(chunks.length).toBeGreaterThan(3)
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(PASS1_CHUNK_BYTES)
    }
    // Words survive the split — nothing is dropped or glued together.
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(oneLine.replace(/\s+/g, " ").trim())
  })

  it("honours the byte budget for multi-byte scripts", () => {
    // Indonesian/Burmese guides are common here; multi-byte chars must not
    // push a chunk over budget, and surrogate pairs must not be split.
    const doc = ("မြန်မာဘာသာပြန် စံနှုန်း 📖 ကိန်းဂဏန်းများကို အတိအကျ ရေးရမည်။\n").repeat(400)
    for (const chunk of chunkDocument(doc)) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(PASS1_CHUNK_BYTES)
      expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
      expect(chunk).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    }
  })

  it("hard-splits a single token larger than the budget", () => {
    const blob = "A".repeat(PASS1_CHUNK_BYTES * 2 + 17)
    const chunks = chunkDocument(blob)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(PASS1_CHUNK_BYTES)
    }
    expect(chunks.join("")).toBe(blob)
  })
})

describe("parseCandidates — truncated pass-1 output (AQU-466)", () => {
  it("salvages candidates when the array is cut off by the output cap", () => {
    // What pass 1 actually returns on a long guide: it hits maxTokens and the
    // JSON array is never closed. This used to parse to [] — a real style
    // guide imported as zero rules with no error shown.
    const truncated =
      '["Numbers must be preserved exactly as in the source", ' +
      '"The term \'church\' must be translated as \'ekklesia\'", ' +
      '"Footnote markers must be retained in the same order", ' +
      '"Divine names must not be transl'

    expect(parseCandidates(truncated)).toEqual([
      "Numbers must be preserved exactly as in the source",
      "The term 'church' must be translated as 'ekklesia'",
      "Footnote markers must be retained in the same order",
    ])
  })

  it("drops the trailing entry that was cut mid-word", () => {
    const truncated = '["Complete rule", "Half a ru'
    expect(parseCandidates(truncated)).toEqual(["Complete rule"])
  })

  it("salvages from a truncated fenced block", () => {
    const truncated = '```json\n["Rule A", "Rule B", "Rule C'
    expect(parseCandidates(truncated)).toEqual(["Rule A", "Rule B"])
  })

  it("keeps escaped characters intact when salvaging", () => {
    const truncated = '["Do not use the \\"smart\\" quote character", "Unfinis'
    expect(parseCandidates(truncated)).toEqual(['Do not use the "smart" quote character'])
  })

  it("still prefers a strict parse when the array is well-formed", () => {
    const raw = '["Rule A", "Rule B"]'
    expect(parseCandidates(raw)).toEqual(["Rule A", "Rule B"])
  })

  it("returns [] when the truncation left no complete entry", () => {
    expect(parseCandidates('["Nothing complete he')).toEqual([])
    expect(parseCandidates("[")).toEqual([])
  })
})

describe("parseCandidatesDetailed — truncation is reported, not just survived (AQU-1254)", () => {
  // Salvaging the complete entries (AQU-466) stopped the silent zero-rule
  // import, but the caller still could not tell a document with nothing
  // checkable in it from an answer the output cap cut in half. Both arrive as
  // a short list; only this flag separates them, and the import dialog shows
  // "no rules found in this document" off the difference.

  it("flags an array cut off mid-string, keeping what completed", () => {
    // Real pass-1 output against a long style guide: maxTokens hit mid-entry.
    const truncated =
      '["Numbers must be preserved exactly as in the source", ' +
      '"The term \'church\' must be rendered as \'jemaat\'", ' +
      '"Divine names must use the approved capitalis'

    expect(parseCandidatesDetailed(truncated)).toEqual({
      candidates: [
        "Numbers must be preserved exactly as in the source",
        "The term 'church' must be rendered as 'jemaat'",
      ],
      truncated: true,
    })
  })

  it("flags an array cut off after a complete entry", () => {
    expect(parseCandidatesDetailed('["Rule one", "Rule two", "Rule three"')).toEqual({
      candidates: ["Rule one", "Rule two", "Rule three"],
      truncated: true,
    })
  })

  it("flags a cut-off answer that left no complete entry at all", () => {
    // The case that reads as "your style guide has no rules" without the flag.
    expect(parseCandidatesDetailed('["Nothing complete he')).toEqual({
      candidates: [],
      truncated: true,
    })
    expect(parseCandidatesDetailed("[")).toEqual({ candidates: [], truncated: true })
  })

  it("does not flag a well-formed array", () => {
    expect(parseCandidatesDetailed('["Rule one", "Rule two"]')).toEqual({
      candidates: ["Rule one", "Rule two"],
      truncated: false,
    })
  })

  it("does not flag a genuinely empty result", () => {
    // A document with nothing checkable in it. "No rules found" is honest here.
    expect(parseCandidatesDetailed("[]")).toEqual({ candidates: [], truncated: false })
  })

  it("does not flag an answer that contains no array at all", () => {
    // Prose instead of JSON is a different failure — nothing says candidates
    // were lost to the output cap, so it must not claim truncation.
    expect(parseCandidatesDetailed("not json")).toEqual({ candidates: [], truncated: false })
    expect(parseCandidatesDetailed("null")).toEqual({ candidates: [], truncated: false })
  })

  it("keeps parseCandidates as the candidates half of the same parse", () => {
    for (const raw of ['["A", "B"]', '["A", "B", "C', "[]", "not json", "["]) {
      expect(parseCandidates(raw)).toEqual(parseCandidatesDetailed(raw).candidates)
    }
  })
})

describe("candidateKey (AQU-466)", () => {
  it("treats restatements of the same rule as one candidate", () => {
    expect(candidateKey("Numbers must be preserved exactly.")).toBe(
      candidateKey("numbers  must be   preserved exactly"),
    )
  })

  it("keeps genuinely different rules distinct", () => {
    expect(candidateKey("Numbers must be preserved")).not.toBe(
      candidateKey("URLs must be preserved"),
    )
  })
})

describe("parseStructuredRule — regex validation (AQU-466)", () => {
  it("rejects a rule whose pattern does not compile", () => {
    // The rule engine caches a failed compile as null and skips the rule, so
    // this used to import as a rule that looks enabled but never fires.
    const raw = JSON.stringify({
      name: "Unbalanced group",
      description: "x",
      severity: "major",
      check: { type: "source-target-match", pattern: "(unclosed" },
    })
    expect(parseStructuredRule(raw)).toBeNull()
  })

  it("rejects an empty target-forbids pattern", () => {
    // An empty pattern matches every string — it would flag every cell.
    const raw = JSON.stringify({
      name: "Empty",
      description: "x",
      severity: "minor",
      check: { type: "target-forbids", targetPattern: "" },
    })
    expect(parseStructuredRule(raw)).toBeNull()
  })

  it("rejects a source-requires-target rule with one bad side", () => {
    const raw = JSON.stringify({
      name: "Half bad",
      description: "x",
      severity: "major",
      check: {
        type: "source-requires-target",
        sourcePattern: "church",
        targetPattern: "ekklesia[",
      },
    })
    expect(parseStructuredRule(raw)).toBeNull()
  })

  it("accepts the regexes a style-guide import actually produces", () => {
    const cases = ["\\d+", "\\.{3}$", "\\bchurch\\b", "[‘’“”]", "^\\s+|\\s+$"]
    for (const pattern of cases) {
      const raw = JSON.stringify({
        name: "Valid",
        description: "x",
        severity: "minor",
        check: { type: "target-forbids", targetPattern: pattern },
      })
      expect(parseStructuredRule(raw), pattern).not.toBeNull()
    }
  })
})
