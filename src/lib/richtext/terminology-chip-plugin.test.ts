import { describe, it, expect } from "vitest"
import { basicSchema } from "./test-schema"
import { findTermMatches, buildTerminologyChipDecorationSet } from "./terminology-chip-plugin"
import type { Concept } from "@/lib/terminology/types"

function makeConcept(sourceTerm: string, status: Concept["status"] = "active"): Concept {
  return {
    id: sourceTerm,
    sourceTerm,
    renderings: [{ rendering: "foo", status: "preferred" }],
    status,
    createdAt: "2026-01-01",
  }
}

function makeDoc(text: string) {
  return basicSchema.node("doc", null, [
    basicSchema.node("paragraph", null, [basicSchema.text(text)]),
  ])
}

// ---------------------------------------------------------------------------
// findTermMatches — pure function, no ProseMirror needed
// ---------------------------------------------------------------------------

describe("findTermMatches", () => {
  it("finds a simple exact match", () => {
    const matches = findTermMatches("hello world", "world")
    expect(matches).toHaveLength(1)
    expect(matches[0]).toEqual({ start: 6, end: 11 })
  })

  it("is case-insensitive", () => {
    const matches = findTermMatches("Hello WORLD world", "world")
    // "WORLD" and "world" both match — "Hello" does not match "world"
    expect(matches).toHaveLength(2)
  })

  it("respects word boundaries — does not match substring", () => {
    const matches = findTermMatches("worldwide", "world")
    expect(matches).toHaveLength(0)
  })

  it("matches at the start of string", () => {
    const matches = findTermMatches("God is good", "God")
    expect(matches).toHaveLength(1)
    expect(matches[0]).toEqual({ start: 0, end: 3 })
  })

  it("matches at the end of string", () => {
    const matches = findTermMatches("worship God", "God")
    expect(matches).toHaveLength(1)
    expect(matches[0]).toEqual({ start: 8, end: 11 })
  })

  it("returns empty for no match", () => {
    expect(findTermMatches("hello", "xyz")).toHaveLength(0)
  })

  it("returns empty for empty term", () => {
    expect(findTermMatches("hello", "")).toHaveLength(0)
  })

  it("handles multiple occurrences", () => {
    const matches = findTermMatches("love God and love your neighbor", "love")
    expect(matches).toHaveLength(2)
  })

  it("escapes regex special characters in term", () => {
    const matches = findTermMatches("cost is $10 today", "$10")
    expect(matches).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// buildTerminologyChipDecorationSet — ProseMirror integration
// ---------------------------------------------------------------------------

describe("buildTerminologyChipDecorationSet", () => {
  it("returns empty set when no active concepts", () => {
    const doc = makeDoc("hello world")
    const set = buildTerminologyChipDecorationSet(doc, [])
    expect(set.find()).toHaveLength(0)
  })

  it("ignores draft and deprecated concepts", () => {
    const doc = makeDoc("hello world")
    const set = buildTerminologyChipDecorationSet(doc, [
      makeConcept("hello", "draft"),
      makeConcept("world", "deprecated"),
    ])
    expect(set.find()).toHaveLength(0)
  })

  it("creates two decorations per match (host inline + widget chip)", () => {
    const doc = makeDoc("worship God today")
    const set = buildTerminologyChipDecorationSet(doc, [makeConcept("God")])
    // One inline (host) + one widget = 2
    expect(set.find()).toHaveLength(2)
  })

  it("inline decoration covers the matched word positions", () => {
    const doc = makeDoc("worship God today")
    // "worship God today" — "God" starts at plain offset 8, ends at 11
    // PM paragraph node: text starts at pos 1, so pm offset = plain + 1
    const set = buildTerminologyChipDecorationSet(doc, [makeConcept("God")])
    const decorations = set.find()
    // Find the inline decoration (has .from < .to spanning the word)
    const inline = decorations.find(d => d.from !== d.to)
    expect(inline).toBeDefined()
    expect(inline!.from).toBe(9)  // 8 + 1
    expect(inline!.to).toBe(12)   // 11 + 1
  })

  it("creates decorations for multiple concepts", () => {
    const doc = makeDoc("love God and love your neighbor")
    const set = buildTerminologyChipDecorationSet(doc, [
      makeConcept("God"),
      makeConcept("love"),
    ])
    // "God" → 1 match → 2 decorations; "love" → 2 matches → 4 decorations = 6 total
    expect(set.find()).toHaveLength(6)
  })
})
