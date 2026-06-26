import { describe, it, expect } from "vitest"
import {
  buildSourceChip,
  serializeWithChips,
  serializeDocJSON,
  type ContextChip,
} from "./context-chip"

function chip(over: Partial<ContextChip> = {}): ContextChip {
  return {
    chipId: "c1", fileId: "f-uuid", cellId: "cell-uuid",
    canonicalRef: "GEN 1:1", side: "source",
    selection: "In the beginning", preview: "In the beginning",
    ...over,
  }
}

describe("buildSourceChip", () => {
  it("caps preview but keeps full selection", () => {
    const long = "x".repeat(400)
    const c = buildSourceChip({ chipId: "c1", fileId: "f", cellId: "z", selection: long })
    expect(c.selection).toHaveLength(400)
    expect(c.preview.length).toBeLessThanOrEqual(201) // 200 + ellipsis char
    expect(c.side).toBe("source")
  })

  it("captures coordinates and canonical ref", () => {
    const c = buildSourceChip({
      chipId: "x", fileId: "file-1", cellId: "cell-9",
      canonicalRef: "GEN 1:1", selection: "In the beginning",
    })
    expect(c).toMatchObject({ fileId: "file-1", cellId: "cell-9", canonicalRef: "GEN 1:1", side: "source" })
  })
})

describe("serializeWithChips", () => {
  it("passes text through unchanged when there are no chips", () => {
    const { wire, display } = serializeWithChips("hello world", [])
    expect(wire).toBe("hello world")
    expect(display).toBe("hello world")
  })

  it("replaces placeholders with ctx tokens (wire) and [ref] (display) and appends a legend", () => {
    const a = chip({ chipId: "a", canonicalRef: "GEN 1:1", selection: "In the beginning" })
    const b = chip({ chipId: "b", canonicalRef: "JHN 1:1", selection: "the Word", fileId: "f2", cellId: "z2" })
    const text = "compare ⟦chip:a⟧ and ⟦chip:b⟧"
    const { wire, display } = serializeWithChips(text, [a, b])
    expect(display).toBe("compare [GEN 1:1] and [JHN 1:1]")
    expect(wire).toContain("compare ⟦ctx:1⟧ and ⟦ctx:2⟧")
    expect(wire).toContain("## Context")
    expect(wire).toContain("⟦ctx:1⟧ GEN 1:1 · file_id=f-uuid cell_id=cell-uuid · source")
    expect(wire).toContain('"In the beginning"')
    expect(wire).toContain("⟦ctx:2⟧ JHN 1:1 · file_id=f2 cell_id=z2 · source")
  })

  it("inlines full text for short selections and truncates long ones in the legend", () => {
    const short = chip({ chipId: "s", selection: "short verse", preview: "short verse" })
    const long = chip({ chipId: "l", selection: "y".repeat(400), preview: "y".repeat(200) + "…" })
    const { wire } = serializeWithChips("⟦chip:s⟧ ⟦chip:l⟧", [short, long])
    expect(wire).toContain('"short verse"')
    expect(wire).toContain("y".repeat(200) + "…")
    expect(wire).not.toContain("y".repeat(400))
  })

  it("caps chip count at 8 and notes the overflow", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      chip({ chipId: `c${i}`, canonicalRef: `REF ${i}` }))
    const text = many.map((c) => `⟦chip:${c.chipId}⟧`).join(" ")
    const { wire } = serializeWithChips(text, many)
    expect(wire).toContain("⟦ctx:8⟧")
    expect(wire).not.toContain("⟦ctx:9⟧")
    expect(wire).toContain("…+3 more")
  })
})

describe("serializeDocJSON", () => {
  it("interleaves text and chip placeholders in order and de-dupes", () => {
    const a = chip({ chipId: "a" })
    const doc = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "look at " },
          { type: "contextChip", attrs: a },
          { type: "text", text: " here " },
          { type: "contextChip", attrs: a }, // duplicate node, same chip
        ],
      }],
    }
    const { text, chips } = serializeDocJSON(doc)
    expect(text).toBe("look at ⟦chip:a⟧ here ⟦chip:a⟧")
    expect(chips).toHaveLength(1)
    expect(chips[0].chipId).toBe("a")
  })

  it("joins multiple paragraphs with newlines", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "line one" }] },
        { type: "paragraph", content: [{ type: "text", text: "line two" }] },
      ],
    }
    expect(serializeDocJSON(doc).text).toBe("line one\nline two")
  })
})
