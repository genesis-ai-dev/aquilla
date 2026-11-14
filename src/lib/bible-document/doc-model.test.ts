// AQU-2559: the document the translator edits and the values the cells store
// must be two views of one thing. If reading a freshly built document gave a
// different value than the cell holds, opening the view would rewrite the book.

import { describe, expect, it } from "vitest"
import { buildDoc, layoutOf, readDoc, type ParaJSON } from "./doc-model"
import type { DocUnit } from "./units"

function verse(n: number, target: string, opts: Partial<DocUnit> = {}): DocUnit {
  return {
    cellId: `v${n}`, kind: "verse", ref: `GEN 1:${n}`, chapter: 1, label: String(n), headingMarker: null,
    source: `Source ${n}.`, sourceParagraphStart: false, sourceParagraphMarker: null, target, ...opts,
  }
}

const heading: DocUnit = {
  cellId: "h1", kind: "heading", ref: "GEN 1:s1:1", chapter: 1, label: "", headingMarker: "s1",
  source: "Creation", sourceParagraphStart: false, sourceParagraphMarker: null, target: "La creación",
}

describe("bible document model", () => {
  it("reads back exactly what each cell holds", () => {
    const units: DocUnit[] = [
      heading,
      verse(1, "En el principio.", { sourceParagraphStart: true, sourceParagraphMarker: "p" }),
      verse(2, ""),
      verse(3, "Y dijo Dios:\n\\q1 Sea la luz\n\\q2 y fue la luz.", { sourceParagraphStart: true, sourceParagraphMarker: "p" }),
      verse(4, "\\s1 La luz\n\\p\nVio Dios \\f + \\ft nota\\f* que era buena."),
      verse(5, "\\q1\nPoesía."),
      verse(6, "\\nb\nSin salto.", { sourceParagraphStart: true, sourceParagraphMarker: "p" }),
      verse(7, "\\p"),
    ]
    const reading = readDoc(buildDoc(units), layoutOf(units))
    for (const unit of units) expect(reading.values.get(unit.cellId), unit.cellId).toBe(unit.target)
    expect(reading.skeleton).toEqual(["h1", "#chapter:1", "v1", "v2", "v3", "v4", "v5", "v6", "v7"])
    expect(reading.orphanText).toBe(false)
  })

  it("lays an untranslated book out in the source's paragraphs", () => {
    const units = [
      verse(1, "", { sourceParagraphStart: true, sourceParagraphMarker: "p" }),
      verse(2, ""),
      verse(3, "", { sourceParagraphStart: true, sourceParagraphMarker: "q1" }),
    ]
    const paras = buildDoc(units).content.filter((b): b is ParaJSON => b.type === "para")
    expect(paras.map((p) => [p.attrs.marker, (p.content ?? []).length])).toEqual([["p", 2], ["q1", 1]])
  })

  it("writes layout the translator changes into the verse that follows it", () => {
    const units = [
      verse(1, "Uno.", { sourceParagraphStart: true, sourceParagraphMarker: "p" }),
      verse(2, "Dos."),
      verse(3, "Tres.", { sourceParagraphStart: true, sourceParagraphMarker: "p" }),
    ]
    const doc = buildDoc(units)
    const [label, first, second] = doc.content as [unknown, ParaJSON, ParaJSON]
    // Break the first paragraph before verse 2, add a heading there, and join
    // verse 3 onto verse 2's paragraph.
    const edited = {
      type: "doc" as const,
      content: [
        label as never,
        { ...first, content: (first.content ?? []).slice(0, 2) },
        { type: "addedHeading" as const, attrs: { marker: "s1" }, content: [{ type: "text" as const, text: "Título" }] },
        { type: "para" as const, attrs: { marker: "p" }, content: [...(first.content ?? []).slice(2), ...(second.content ?? [])] },
      ],
    }
    const values = readDoc(edited, layoutOf(units)).values
    expect(values.get("v1")).toBe("Uno.")
    expect(values.get("v2")).toBe("\\s1 Título\n\\p\nDos.")
    expect(values.get("v3")).toBe("\\nb\nTres.")
  })

  it("flags words that no verse can own", () => {
    const units = [verse(1, "Uno.")]
    const doc = buildDoc(units)
    const para = doc.content[1] as ParaJSON
    const edited = { ...doc, content: [doc.content[0], { ...para, content: [{ type: "text" as const, text: "stray" }, ...(para.content ?? [])] }] }
    expect(readDoc(edited, layoutOf(units)).orphanText).toBe(true)
  })
})
