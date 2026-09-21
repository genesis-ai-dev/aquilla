import { describe, it, expect } from "vitest"
import type { DecorationSet } from "@tiptap/pm/view"
import { basicSchema } from "./test-schema"
import {
  findTermMatches,
  buildTerminologyChipDecorationSet,
  conceptChipStatus,
} from "./terminology-chip-plugin"
import type { Concept, TermRendering } from "@/lib/terminology/types"

function makeConcept(sourceTerm: string, status: Concept["status"] = "active"): Concept {
  return {
    id: sourceTerm,
    sourceTerm,
    renderings: [{ rendering: "foo", status: "preferred" }],
    status,
    createdAt: "2026-01-01",
  }
}

/** An active concept whose renderings (and so whose highlight status) we control. */
function makeConceptWith(sourceTerm: string, renderings: TermRendering[]): Concept {
  return { ...makeConcept(sourceTerm), renderings }
}

/**
 * An inline `Decoration` keeps its DOM attributes on its `type`, which is not in
 * ProseMirror's public typings. Narrow cast rather than `any` so the highlight's
 * attributes can be asserted.
 */
type InlineDecoration = { type: { attrs: Record<string, string> } }

/** The DOM attributes of every managed-term highlight in `set`, in doc order. */
function highlightAttrs(set: DecorationSet): Array<Record<string, string>> {
  return set
    .find()
    .sort((a, b) => a.from - b.from)
    .map((d) => (d as unknown as InlineDecoration).type.attrs)
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

  it("creates one inline highlight per match", () => {
    const doc = makeDoc("worship God today")
    const set = buildTerminologyChipDecorationSet(doc, [makeConcept("God")])
    expect(set.find()).toHaveLength(1)
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attrs = (inline as any).type.attrs
    expect(attrs.class).toContain("term-chip-host")
    expect(attrs["data-source-term"]).toBe("God")
  })

  it("creates decorations for multiple concepts", () => {
    const doc = makeDoc("love God and love your neighbor")
    const set = buildTerminologyChipDecorationSet(doc, [
      makeConcept("God"),
      makeConcept("love"),
    ])
    // "God" → 1 match; "love" → 2 matches.
    expect(set.find()).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// AQU-199 — the highlight tracks the concept's rendering status. The tinted dot
// this was written for is gone (AQU-1006/AQU-1110), so the status is carried
// by the inline highlight's attributes rather than by a widget's class.
// ---------------------------------------------------------------------------

describe("conceptChipStatus", () => {
  it("prefers 'preferred' over every other rendering status", () => {
    const concept = makeConceptWith("grace", [
      { rendering: "b", status: "forbidden" },
      { rendering: "c", status: "admitted" },
      { rendering: "a", status: "preferred" },
    ])
    expect(conceptChipStatus(concept)).toBe("preferred")
  })

  it("falls back to 'admitted' when no rendering is preferred", () => {
    const concept = makeConceptWith("grace", [
      { rendering: "b", status: "forbidden" },
      { rendering: "c", status: "admitted" },
    ])
    expect(conceptChipStatus(concept)).toBe("admitted")
  })

  it("is 'forbidden' when every rendering is forbidden (no acceptable option)", () => {
    const concept = makeConceptWith("grace", [
      { rendering: "b", status: "forbidden" },
      { rendering: "d", status: "forbidden" },
    ])
    expect(conceptChipStatus(concept)).toBe("forbidden")
  })

  it("reads neutral for a concept that carries no renderings yet", () => {
    expect(conceptChipStatus(makeConceptWith("grace", []))).toBe("admitted")
  })
})

describe("buildTerminologyChipDecorationSet — highlight status", () => {
  it("marks a preferred term's highlight as preferred", () => {
    const doc = makeDoc("by grace alone")
    const set = buildTerminologyChipDecorationSet(doc, [
      makeConceptWith("grace", [{ rendering: "gracia", status: "preferred" }]),
    ])
    const [attrs] = highlightAttrs(set)
    expect(attrs["data-status"]).toBe("preferred")
  })

  it("marks it forbidden once that term's only rendering is toggled to forbidden", () => {
    const doc = makeDoc("by grace alone")
    const set = buildTerminologyChipDecorationSet(doc, [
      makeConceptWith("grace", [{ rendering: "gracia", status: "forbidden" }]),
    ])
    const [attrs] = highlightAttrs(set)
    expect(attrs["data-status"]).toBe("forbidden")
  })

  it("keeps the single shared highlight class whatever the status", () => {
    const doc = makeDoc("by grace alone")
    const set = buildTerminologyChipDecorationSet(doc, [
      makeConceptWith("grace", [{ rendering: "gracia", status: "forbidden" }]),
    ])
    const [attrs] = highlightAttrs(set)
    expect(attrs.class).toBe("term-chip-host")
  })

  it("resolves each concept's status independently in the same doc", () => {
    const doc = makeDoc("grace and works")
    const set = buildTerminologyChipDecorationSet(doc, [
      makeConceptWith("grace", [{ rendering: "gracia", status: "preferred" }]),
      makeConceptWith("works", [{ rendering: "obras", status: "forbidden" }]),
    ])
    expect(highlightAttrs(set).map((attrs) => attrs["data-status"])).toEqual([
      "preferred",
      "forbidden",
    ])
  })

  it("spells the status into the accessible name", () => {
    const doc = makeDoc("by grace alone")
    const set = buildTerminologyChipDecorationSet(doc, [
      makeConceptWith("grace", [{ rendering: "gracia", status: "forbidden" }]),
    ])
    const [attrs] = highlightAttrs(set)
    expect(attrs["aria-label"]).toBe("Managed term: grace (forbidden)")
    expect(attrs.title).toBe("Managed term: grace (forbidden)")
  })

  it("still carries data-source-term for the AQU-204 lookup popover", () => {
    const doc = makeDoc("by grace alone")
    const set = buildTerminologyChipDecorationSet(doc, [
      makeConceptWith("grace", [{ rendering: "gracia", status: "admitted" }]),
    ])
    const [attrs] = highlightAttrs(set)
    expect(attrs["data-source-term"]).toBe("grace")
  })
})
