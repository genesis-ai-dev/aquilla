import { describe, it, expect } from "vitest"
import {
  flattenHelloaoContent,
  parseHelloaoChapterStrings,
  parseHelloaoComplete,
  type HelloaoChapter,
  type HelloaoComplete,
} from "./helloao"
import { parseCanonicalRef } from "@/components/ParallelBiblesSidebar"

function chapter(number: number, content: HelloaoChapter["content"]): HelloaoChapter {
  return { number, content }
}

describe("flattenHelloaoContent", () => {
  it("joins strings and formatted-text objects, dropping notes and breaks", () => {
    expect(
      flattenHelloaoContent([
        "In the beginning",
        { noteId: 1 },
        { text: "God created", poem: 1 },
        { lineBreak: true },
        { text: "the heavens and the earth.", wordsOfJesus: false },
      ])
    ).toBe("In the beginning God created the heavens and the earth.")
  })

  it("collapses runs of whitespace from joined pieces", () => {
    expect(flattenHelloaoContent(["a ", { text: " b" }])).toBe("a b")
  })
})

describe("parseHelloaoChapterStrings", () => {
  const ch = chapter(1, [
    { type: "heading", content: ["The Creation"] },
    { type: "verse", number: 1, content: ["In the beginning God created the heavens and the earth."] },
    { type: "line_break" },
    { type: "verse", number: 2, content: [{ text: "Now the earth was formless", poem: 1 }, { noteId: 0 }] },
    { type: "verse", number: 3, content: [] }, // empty — must be skipped, not emitted blank
  ])

  it("emits verse cells with USFM-style refs matching the editor's canonicalRef scheme", () => {
    const out = parseHelloaoChapterStrings("GEN", ch)
    const verses = out.filter((s) => s.type === "verse")
    // The ref drives target-import matching and sidebar tracking — it must be
    // exactly "BOOK C:V" or cross-feature ref joins silently miss.
    expect(verses.map((v) => v.context)).toEqual(["GEN 1:1", "GEN 1:2"])
    expect(verses[0].group).toBe("GEN 1:1")
    expect(verses[0].globalReferences).toEqual(["GEN 1:1"])
    expect(verses[0].section).toBe("GEN 1")
    expect(verses[1].original).toBe("Now the earth was formless")
  })

  it("keeps headings as heading cells scoped to the chapter, without verse refs", () => {
    const out = parseHelloaoChapterStrings("GEN", ch)
    expect(out[0].type).toBe("heading")
    expect(out[0].original).toBe("The Creation")
    expect(out[0].section).toBe("GEN 1")
    // Headings aren't verses — a globalReference would pollute ref-keyed joins.
    expect(out[0].globalReferences).toBeUndefined()
  })

  it("preserves document order (heading before its verses)", () => {
    const out = parseHelloaoChapterStrings("GEN", ch)
    expect(out.map((s) => s.type)).toEqual(["heading", "verse", "verse"])
  })
})

describe("parseHelloaoComplete", () => {
  const complete = {
    translation: { id: "TST" },
    books: [
      // Deliberately out of order — the parser must sort by `order` so the
      // imported file reads in canonical book order.
      {
        id: "MAT",
        order: 40,
        chapters: [
          { chapter: chapter(1, [{ type: "verse", number: 1, content: ["The genealogy."] }]) },
        ],
      },
      {
        id: "GEN",
        order: 1,
        chapters: [
          { chapter: chapter(1, [{ type: "verse", number: 1, content: ["In the beginning."] }]) },
          { chapter: chapter(2, [{ type: "verse", number: 1, content: ["Thus were completed."] }]) },
        ],
      },
    ],
  } as unknown as HelloaoComplete

  it("imports every book in canonical order when no selection is given", () => {
    const out = parseHelloaoComplete(complete, null)
    expect(out.map((s) => s.context)).toEqual(["GEN 1:1", "GEN 2:1", "MAT 1:1"])
  })

  it("filters to the selected books — the book/testament picker contract", () => {
    const out = parseHelloaoComplete(complete, new Set(["MAT"]))
    expect(out.map((s) => s.context)).toEqual(["MAT 1:1"])
  })

  it("treats an empty selection as no filter (whole bible)", () => {
    const out = parseHelloaoComplete(complete, new Set())
    expect(out).toHaveLength(3)
  })
})

describe("parseCanonicalRef", () => {
  it("parses verse, chapter-only, and numbered-book refs", () => {
    expect(parseCanonicalRef("GEN 1:1")).toEqual({ book: "GEN", chapter: 1, verse: 1 })
    expect(parseCanonicalRef("GEN 1")).toEqual({ book: "GEN", chapter: 1, verse: null })
    expect(parseCanonicalRef("1SA 17:4")).toEqual({ book: "1SA", chapter: 17, verse: 4 })
  })

  it("treats USFM heading refs (GEN 1:s:1) as chapter-scoped, not a verse", () => {
    // Heading cells carry refs like "GEN 1:s:1" — the sidebar must keep
    // tracking the chapter without inventing a verse number from "s".
    expect(parseCanonicalRef("GEN 1:s:1")).toEqual({ book: "GEN", chapter: 1, verse: null })
  })

  it("returns null for non-scripture groups (uuid groups from prose files)", () => {
    expect(parseCanonicalRef("3f9c2a10-aaaa-bbbb-cccc-000000000000")).toBeNull()
    expect(parseCanonicalRef("")).toBeNull()
  })
})
