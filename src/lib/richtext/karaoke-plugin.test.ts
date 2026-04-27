import { describe, expect, it } from "vitest"
import { Schema } from "@tiptap/pm/model"
import { buildKaraokeDecorationSet } from "./karaoke-plugin"
import type { WordTiming } from "@/lib/codex-editor/types"

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
  },
})

function paragraph(text: string) {
  return schema.node("doc", null, [
    schema.node("paragraph", null, text ? [schema.text(text)] : []),
  ])
}

function multiParagraph(...lines: string[]) {
  return schema.node(
    "doc",
    null,
    lines.map((t) => schema.node("paragraph", null, t ? [schema.text(t)] : [])),
  )
}

const timings: WordTiming[] = [
  { word: "hello", t0: 0, t1: 0.4, start: 0, end: 5 },
  { word: "world", t0: 0.4, t1: 0.9, start: 6, end: 11 },
]

describe("buildKaraokeDecorationSet", () => {
  it("returns an empty set when there's no active word", () => {
    const doc = paragraph("hello world")
    expect(buildKaraokeDecorationSet(doc, timings, -1).find().length).toBe(0)
    expect(buildKaraokeDecorationSet(doc, timings, 99).find().length).toBe(0)
    expect(buildKaraokeDecorationSet(doc, undefined, 0).find().length).toBe(0)
  })

  it("decorates the active word at the right ProseMirror offsets", () => {
    const doc = paragraph("hello world")
    const set = buildKaraokeDecorationSet(doc, timings, 0)
    const decos = set.find()
    expect(decos.length).toBe(1)
    // For a single paragraph, plain offset N maps to PM position N + 1.
    expect(decos[0].from).toBe(1)
    expect(decos[0].to).toBe(6)
  })

  it("moves the decoration as activeIdx changes", () => {
    const doc = paragraph("hello world")
    const setA = buildKaraokeDecorationSet(doc, timings, 0)
    const setB = buildKaraokeDecorationSet(doc, timings, 1)
    expect(setA.find()[0].from).toBe(1)
    expect(setB.find()[0].from).toBe(7)
    expect(setB.find()[0].to).toBe(12)
  })

  it("returns empty when the timing extends past the doc", () => {
    const doc = paragraph("hi")
    const out = buildKaraokeDecorationSet(
      doc,
      [{ word: "hi there", t0: 0, t1: 1, start: 0, end: 8 }],
      0,
    )
    expect(out.find().length).toBe(0)
  })

  it("decorates words across paragraph boundaries (\\n separator counted)", () => {
    // Plain text: "hello\nworld" — 5 + 1 (\n) + 5 = 11 chars
    const doc = multiParagraph("hello", "world")
    const para1Timings: WordTiming[] = [
      { word: "hello", t0: 0, t1: 0.5, start: 0, end: 5 },
      { word: "world", t0: 0.5, t1: 1.0, start: 6, end: 11 },
    ]
    // Word 0: "hello" → PM positions [1, 6] (inside paragraph 1)
    expect(buildKaraokeDecorationSet(doc, para1Timings, 0).find()[0]).toMatchObject({
      from: 1, to: 6,
    })
    // Word 1: "world" → PM positions [8, 13] (paragraph 2 contents start at 8,
    // not 7 as the old single-paragraph builder assumed)
    const second = buildKaraokeDecorationSet(doc, para1Timings, 1).find()[0]
    expect(second.from).toBe(8)
    expect(second.to).toBe(13)
  })
})
