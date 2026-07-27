import { describe, it, expect } from "vitest"
import { parseTextFormat, TEXT_PARSE_FILE_TYPES } from "./parse-text-formats"

describe("parseTextFormat (worker-safe DOM-free parse core)", () => {
  it("parses a plain text file into strings", () => {
    const results = parseTextFormat({
      fileType: "txt",
      text: "First line.\n\nSecond line.",
      name: "sample.txt",
    })
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe("sample.txt")
    expect(results[0].strings.length).toBeGreaterThan(0)
  })

  it("splits a multi-book USFM file into one ImportResult per \\id, carrying raw source", () => {
    const usfm =
      "\\id GEN\n\\c 1\n\\v 1 In the beginning God created the heavens and the earth.\n" +
      "\\id EXO\n\\c 1\n\\v 1 These are the names of the sons of Israel.\n"
    const results = parseTextFormat({ fileType: "usfm", text: usfm, name: "books.usfm" })

    expect(results).toHaveLength(2)
    // Each book becomes its own result named by its \id book code.
    expect(results.map((r) => r.name)).toEqual(["GEN", "EXO"])
    // Round-trip side-car: each result keeps its own raw USFM section.
    expect(results[0].rawSourceFormat).toBe("usfm")
    expect(results[0].rawSource).toContain("\\id GEN")
    expect(results[1].rawSource).toContain("\\id EXO")
    // The verse text is extracted into a translatable string.
    expect(results[0].strings.some((s) => s.original.includes("In the beginning"))).toBe(true)
  })

  it("AQU-634: imports USFM front matter by default, excludes it when opted out", () => {
    const usfm =
      "\\id GEN\n\\h Genesis\n\\mt1 Genesis\n\\ip An introduction.\n" +
      "\\c 1\n\\s The Creation\n\\v 1 In the beginning.\n"

    const withFront = parseTextFormat({ fileType: "usfm", text: usfm, name: "gen.usfm" })
    const defaultTexts = withFront[0].strings.map((s) => s.original)
    expect(defaultTexts).toEqual(expect.arrayContaining(["Genesis", "An introduction.", "The Creation", "In the beginning."]))

    const withoutFront = parseTextFormat({
      fileType: "usfm",
      text: usfm,
      name: "gen.usfm",
      excludeFrontMatter: true,
    })
    const optedTexts = withoutFront[0].strings.map((s) => s.original)
    // Book name/title/intro dropped; section heading + verse still present.
    expect(optedTexts).not.toContain("An introduction.")
    expect(optedTexts.filter((t) => t === "Genesis")).toHaveLength(0)
    expect(optedTexts).toEqual(expect.arrayContaining(["The Creation", "In the beginning."]))
  })

  // AQU-585/AQU-634: with the per-project opt-out set, book names (running
  // header / TOC / main title) and the whole introduction block are dropped as
  // front matter, not imported as translatable source cells.
  it("filters book-name and book-introduction cells when excludeFrontMatter is set", () => {
    const usfm = [
      "\\id MAT",
      "\\h Matthew",              // running header (book name)
      "\\toc1 The Gospel of Matthew", // table-of-contents long name
      "\\toc2 Matthew",           // table-of-contents short name
      "\\mt1 The Gospel",         // main title (book name)
      "\\imt Introduction",       // intro main title
      "\\is Background",          // intro section heading
      "\\ip This book was written by Matthew.", // intro paragraph
      "\\io1 The genealogy",      // intro outline
      "\\c 1",
      "\\ms The Genealogy Section", // in-body major-section heading — KEPT
      "\\s1 The Genealogy",       // in-body section heading — KEPT
      "\\p",
      "\\v 1 The book of the genealogy of Jesus Christ.",
      "\\v 2 Abraham fathered Isaac.",
    ].join("\n")

    const [result] = parseTextFormat({
      fileType: "usfm",
      text: usfm,
      name: "MAT.usfm",
      excludeFrontMatter: true,
    })
    const originals = result.strings.map((s) => s.original)

    // Verses and in-body section headings survive…
    expect(originals).toEqual([
      "The Genealogy Section",
      "The Genealogy",
      "The book of the genealogy of Jesus Christ.",
      "Abraham fathered Isaac.",
    ])
    // …and none of the book-name / introduction front matter leaks through.
    for (const frontMatter of [
      "Matthew",
      "The Gospel of Matthew",
      "The Gospel",
      "Introduction",
      "Background",
      "This book was written by Matthew.",
      "The genealogy",
    ]) {
      expect(originals).not.toContain(frontMatter)
    }
  })

  it("declares exactly the DOM-free file types it can handle", () => {
    expect(TEXT_PARSE_FILE_TYPES.has("usfm")).toBe(true)
    expect(TEXT_PARSE_FILE_TYPES.has("txt")).toBe(true)
    expect(TEXT_PARSE_FILE_TYPES.has("csv")).toBe(true)
    expect(TEXT_PARSE_FILE_TYPES.has("json")).toBe(true)
    expect(TEXT_PARSE_FILE_TYPES.has("po")).toBe(true)
    expect(TEXT_PARSE_FILE_TYPES.has("properties")).toBe(true)
    expect(TEXT_PARSE_FILE_TYPES.has("sbv")).toBe(true)
    // DOM-bound (DOMParser) formats must NOT be routed here.
    expect(TEXT_PARSE_FILE_TYPES.has("docx")).toBe(false)
    expect(TEXT_PARSE_FILE_TYPES.has("xliff")).toBe(false)
  })

  it.each([
    ["json", "messages.json", '{"title":"Hello"}', "Hello"],
    ["po", "messages.po", 'msgid "Hello"\nmsgstr "Bonjour"\n', "Hello"],
    ["properties", "messages.properties", "title=Hello\n", "Hello"],
    ["sbv", "captions.sbv", "0:00:01.000,0:00:02.000\nHello\n", "Hello"],
  ] as const)("parses %s through its deterministic adapter", (fileType, name, text, expected) => {
    const [result] = parseTextFormat({ fileType, name, text })
    expect(result.strings[0].original).toBe(expected)
  })
})
