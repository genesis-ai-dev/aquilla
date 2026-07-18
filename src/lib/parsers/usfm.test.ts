import { describe, it, expect } from "vitest"
import { extractUsfmStrings } from "./usfm"
import ultTitRaw from "./__fixtures__/ult-tit-1.usfm?raw"
import uhbExoRaw from "./__fixtures__/uhb-exo-1.usfm?raw"

describe("extractUsfmStrings", () => {
  it("parses verses with book/chapter/verse context", () => {
    const usfm = `\\id GEN
\\c 1
\\p
\\v 1 In the beginning God created the heavens and the earth.
\\v 2 The earth was without form and void.`

    const result = extractUsfmStrings(usfm)
    expect(result).toHaveLength(1)
    expect(result[0].bookId).toBe("GEN")
    expect(result[0].strings).toHaveLength(2)
    expect(result[0].strings[0].original).toBe(
      "In the beginning God created the heavens and the earth."
    )
    expect(result[0].strings[0].context).toBe("GEN 1:1")
    expect(result[0].strings[0].type).toBe("verse")
    expect(result[0].strings[1].context).toBe("GEN 1:2")
  })

  it("splits multiple books by \\id marker", () => {
    const usfm = `\\id GEN
\\c 1
\\v 1 First verse of Genesis.

\\id EXO
\\c 1
\\v 1 First verse of Exodus.`

    const result = extractUsfmStrings(usfm)
    expect(result).toHaveLength(2)
    expect(result[0].bookId).toBe("GEN")
    expect(result[1].bookId).toBe("EXO")
  })

  it("parses section headings", () => {
    const usfm = `\\id GEN
\\c 1
\\s The Creation
\\v 1 In the beginning.`

    const result = extractUsfmStrings(usfm)
    const strings = result[0].strings
    expect(strings[0].original).toBe("The Creation")
    expect(strings[0].type).toBe("heading")
    expect(strings[1].type).toBe("verse")
  })

  it("keeps in-body paratext markers (major section / parallel ref)", () => {
    const usfm = `\\id GEN
\\c 1
\\ms Primeval History
\\v 1 In the beginning.`

    const result = extractUsfmStrings(usfm)
    const strings = result[0].strings
    expect(strings[0].original).toBe("Primeval History")
    expect(strings[0].type).toBe("paratext")
  })

  it("filters the book name (\\mt) out of source cells (AQU-585)", () => {
    const usfm = `\\id GEN
\\mt Genesis
\\c 1
\\v 1 In the beginning.`

    const result = extractUsfmStrings(usfm)
    const strings = result[0].strings
    // The \mt book title is front matter, not a translatable cell.
    expect(strings.map((s) => s.original)).toEqual(["In the beginning."])
    expect(strings.some((s) => s.type === "paratext")).toBe(false)
  })

  it("treats file without \\id as single document", () => {
    const usfm = `\\c 1
\\v 1 A verse without book ID.`

    const result = extractUsfmStrings(usfm)
    expect(result).toHaveLength(1)
    expect(result[0].bookId).toBe("unknown")
  })

  it("handles chapter transitions", () => {
    const usfm = `\\id GEN
\\c 1
\\v 1 Chapter one verse one.
\\c 2
\\v 1 Chapter two verse one.`

    const result = extractUsfmStrings(usfm)
    const strings = result[0].strings
    expect(strings[0].context).toBe("GEN 1:1")
    expect(strings[1].context).toBe("GEN 2:1")
  })

  it("sets translated equal to original", () => {
    const usfm = `\\id GEN
\\c 1
\\v 1 Test verse.`

    const result = extractUsfmStrings(usfm)
    expect(result[0].strings[0].translated).toBe("")
  })
})

describe("extractUsfmStrings — section labels", () => {
  it("sets section to 'BOOK CHAPTER' for verses", () => {
    const usfm = "\\id GEN\n\\c 1\n\\v 1 In the beginning.\n\\c 2\n\\v 1 The heavens.\n"
    const [book] = extractUsfmStrings(usfm)
    expect(book.bookId).toBe("GEN")
    expect(book.strings[0].section).toBe("GEN 1")
    expect(book.strings[1].section).toBe("GEN 2")
  })

  it("sets section to 'BOOK CHAPTER' for headings", () => {
    const usfm = "\\id GEN\n\\c 3\n\\s1 The Fall\n\\v 1 Now the serpent.\n"
    const [book] = extractUsfmStrings(usfm)
    const heading = book.strings.find(s => s.type === "heading")
    expect(heading?.section).toBe("GEN 3")
  })

  it("does not emit a cell for book-level front matter (\\mt1) — AQU-585", () => {
    const usfm = "\\id GEN\n\\mt1 Genesis\n\\c 1\n\\v 1 hi\n"
    const [book] = extractUsfmStrings(usfm)
    expect(book.strings.find(s => s.type === "paratext")).toBeUndefined()
    expect(book.strings.map(s => s.original)).toEqual(["hi"])
  })
})

// unfoldingWord's aligned repos (en_ult/en_ust/hbo_uhb/el-x-koine_ugnt) wrap every word
// in \zaln-s ...\* / \zaln-e\* milestones and \w word|attrs\w* on its own physical line.
// Before AQU-615 the line-based parser dropped every continuation line starting with "\",
// importing one word per verse (and losing hbo_uhb's bare "\v N" verses entirely).
describe("extractUsfmStrings — aligned USFM3 (unfoldingWord)", () => {
  it("reconstructs the full ULT verse text from word-per-line alignment markup", () => {
    const [book] = extractUsfmStrings(ultTitRaw)
    expect(book.bookId).toBe("TIT")
    const v1 = book.strings.find((s) => s.context === "TIT 1:1")
    // Full verse — words joined with spaces, punctuation attached (no space before
    // the commas that sit outside the \w...\w* wrappers).
    expect(v1?.original).toBe(
      "Paul, a servant of God and an apostle of Jesus Christ, for the faith of the chosen people of God and knowledge of the truth that agrees with godliness,",
    )
    // Hyphenated compound split across two \w wrappers must not gain spaces.
    const v2 = book.strings.find((s) => s.context === "TIT 1:2")
    expect(v2?.original).toContain("the non-lying God promised")
    expect(v2?.original?.endsWith("all the ages of time.")).toBe(true)
  })

  it("leaves no alignment markup or attribute residue in any cell", () => {
    const [book] = extractUsfmStrings(ultTitRaw)
    // Verse cells only — the \mt1/\h/\toc book-name front matter is filtered
    // out on import (AQU-585), leaving the three excerpted Titus verses.
    expect(book.strings.length).toBeGreaterThanOrEqual(3)
    expect(book.strings.every((s) => s.type === "verse")).toBe(true)
    for (const s of book.strings) {
      expect(s.original).not.toMatch(/\\zaln|\\w|x-occurrence|x-strong|\|/)
      expect(s.original).not.toMatch(/\s[,.;:!?]/)
    }
  })

  it("parses UHB bare \\v markers whose Hebrew words follow on separate lines", () => {
    const [book] = extractUsfmStrings(uhbExoRaw)
    expect(book.bookId).toBe("EXO")
    const verses = book.strings.filter((s) => s.type === "verse")
    // All six verses of the excerpt survive even though every "\v N" line is bare.
    expect(verses.map((s) => s.context)).toEqual([
      "EXO 1:1",
      "EXO 1:2",
      "EXO 1:3",
      "EXO 1:4",
      "EXO 1:5",
      "EXO 1:6",
    ])
    // Hebrew content untouched: word-joiners (⁠) intact, maqqef (־) still binds its
    // word pair without inserted spaces, sof pasuq (׃) attached to the last word.
    // "רְאוּבֵ֣ן שִׁמְע֔וֹן לֵוִ֖י וִ⁠יהוּדָֽה׃" — written as escapes so editors cannot
    // reorder the combining marks away from the fixture's byte order.
    expect(verses[1].original).toBe(
      "\u{5e8}\u{5b0}\u{5d0}\u{5d5}\u{5bc}\u{5d1}\u{5b5}\u{5a3}\u{5df}\u{20}\u{5e9}\u{5c1}\u{5b4}\u{5de}\u{5b0}\u{5e2}\u{594}\u{5d5}\u{5b9}\u{5df}\u{20}\u{5dc}\u{5b5}\u{5d5}\u{5b4}\u{596}\u{5d9}\u{20}\u{5d5}\u{5b4}\u{2060}\u{5d9}\u{5d4}\u{5d5}\u{5bc}\u{5d3}\u{5b8}\u{5bd}\u{5d4}\u{5c3}",
    )
    // "כָּל־נֶ֛פֶשׁ" as escapes (same editor-normalization hazard as above).
    expect(verses[4].original).toContain(
      "\u{5db}\u{5bc}\u{5b8}\u{5dc}\u{5be}\u{5e0}\u{5b6}\u{59b}\u{5e4}\u{5b6}\u{5e9}\u{5c1}",
    )
    for (const v of verses) {
      expect(v.original.endsWith("׃")).toBe(true)
      expect(v.original).not.toMatch(/lemma=|strong=|x-morph/)
    }
  })

  it("does not alter plain (non-aligned) USFM output — byte-identical regression", () => {
    // Continuation lines, space-before-punctuation, and bare formatting are all
    // preserved exactly: normalization must skip files without alignment markup,
    // because src/lib/dcs/routes/usfm.ts seeds stable cell ids from these strings.
    const plain = `\\id GEN
\\mt Genesis
\\c 1
\\s The Creation
\\p
\\v 1 In the beginning God created
the heavens , and the earth.
\\v 2 The earth was without form.`
    const [book] = extractUsfmStrings(plain)
    // \mt Genesis (book name) is filtered out per AQU-585; the section heading
    // and verse bodies are preserved byte-for-byte.
    expect(book.strings.map((s) => s.original)).toEqual([
      "The Creation",
      "In the beginning God created the heavens , and the earth.",
      "The earth was without form.",
    ])
  })
})

describe("extractUsfmStrings — globalReferences", () => {
  it("tags verse cells with [vref]", () => {
    const usfm = "\\id LUK\n\\c 1\n\\v 1 First verse.\n\\v 2 Second verse.\n"
    const [book] = extractUsfmStrings(usfm)
    const verses = book.strings.filter(s => s.type === "verse")
    expect(verses[0].globalReferences).toEqual(["LUK 1:1"])
    expect(verses[1].globalReferences).toEqual(["LUK 1:2"])
  })

  it("does not tag headings or paratext with globalReferences", () => {
    // \ms (major section) is in-body paratext that survives the AQU-585 filter,
    // unlike the \mt book title.
    const usfm = "\\id LUK\n\\c 1\n\\ms The Coming Age\n\\s1 The Coming.\n\\v 1 First verse.\n"
    const [book] = extractUsfmStrings(usfm)
    const heading = book.strings.find(s => s.type === "heading")
    const paratext = book.strings.find(s => s.type === "paratext")
    expect(heading?.globalReferences).toBeUndefined()
    expect(paratext?.globalReferences).toBeUndefined()
  })
})
