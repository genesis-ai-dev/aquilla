import { describe, it, expect } from "vitest"
import { basicSchema } from "./test-schema"
import { findTermMatches, buildTerminologyChipDecorationSet, findApprovedRenderingMatches } from "./terminology-chip-plugin"
import { buildTermRegex } from "@/lib/terminology/match"
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

describe("findApprovedRenderingMatches (AQU-2654)", () => {
  // What the read-mode target column computed before: every approved rendering
  // of every active concept, run over the text one regex at a time.
  function reference(text: string, concepts: Concept[]) {
    const out: Array<{ start: number; end: number; term: string }> = []
    for (const concept of concepts) {
      if (concept.status !== "active") continue
      for (const rendering of concept.renderings) {
        if (rendering.status !== "preferred" && rendering.status !== "admitted") continue
        const re = buildTermRegex(rendering.rendering, "giu")
        if (!re || !text) continue
        let m: RegExpExecArray | null
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex += 1
            continue
          }
          out.push({ start: m.index, end: m.index + m[0].length, term: concept.sourceTerm })
        }
      }
    }
    return out
  }

  const concepts: Concept[] = [
    { ...makeConcept("grace"), renderings: [{ rendering: "gracia", status: "preferred" }, { rendering: "merced", status: "admitted" }, { rendering: "favor", status: "forbidden" }] },
    { ...makeConcept("word"), renderings: [{ rendering: "λόγος", status: "preferred" }, { rendering: "palabr*", status: "admitted" }, { rendering: "  ", status: "preferred" }] },
    { ...makeConcept("draft"), status: "draft", renderings: [{ rendering: "borrador", status: "preferred" }] },
    { ...makeConcept("any"), renderings: [{ rendering: "*", status: "admitted" }] },
    ...Array.from({ length: 40 }, (_, i) => ({ ...makeConcept(`filler${i}`), renderings: [{ rendering: `relleno${i}`, status: "preferred" as const }] })),
  ]

  it.each([
    "por gracia, Gracia y merced; favor",
    "Ὁ ΛΌΓΟΣ y las palabras de un borrador",
    "relleno7 relleno39 relleno400",
    "nada que ver",
    "",
  ])("finds what the per-rendering loop found, in the same order: %j", (text) => {
    expect(findApprovedRenderingMatches(text, concepts)).toEqual(reference(text, concepts))
  })

  it("the reference is not empty for the texts that carry renderings", () => {
    expect(reference("por gracia, Gracia y merced; favor", concepts.slice(0, 3)).map((m) => m.term)).toEqual(["grace", "grace", "grace"])
  })
})
