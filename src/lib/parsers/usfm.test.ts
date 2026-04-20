import { describe, it, expect } from "vitest"
import { extractUsfmStrings } from "./usfm"

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

  it("parses paratext markers", () => {
    const usfm = `\\id GEN
\\mt Genesis
\\c 1
\\v 1 In the beginning.`

    const result = extractUsfmStrings(usfm)
    const strings = result[0].strings
    expect(strings[0].original).toBe("Genesis")
    expect(strings[0].type).toBe("paratext")
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

  it("sets section to bookId for paratext (book-level)", () => {
    const usfm = "\\id GEN\n\\mt1 Genesis\n\\c 1\n\\v 1 hi\n"
    const [book] = extractUsfmStrings(usfm)
    const paratext = book.strings.find(s => s.type === "paratext")
    expect(paratext?.section).toBe("GEN")
  })
})
