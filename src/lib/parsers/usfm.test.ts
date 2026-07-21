import { describe, it, expect } from "vitest"
import { extractUsfmStrings } from "./usfm"
import ultTitRaw from "./__fixtures__/ult-tit-1.usfm?raw"
import ultPsaRaw from "./__fixtures__/ult-psa-1.usfm?raw"
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

  it("AQU-634: excludeFrontMatter drops the \\mt title but keeps \\ms/\\s + verses", () => {
    const usfm = `\\id GEN
\\mt Genesis
\\ms A major section
\\c 1
\\s The Creation
\\v 1 In the beginning.`

    const withFront = extractUsfmStrings(usfm)[0].strings.map((s) => s.original)
    expect(withFront).toContain("Genesis")

    const withoutFront = extractUsfmStrings(usfm, { excludeFrontMatter: true })[0].strings.map(
      (s) => s.original,
    )
    // \mt book title is front matter → dropped…
    expect(withoutFront).not.toContain("Genesis")
    // …but \ms/\s section headings and the verse remain.
    expect(withoutFront).toEqual(
      expect.arrayContaining(["A major section", "The Creation", "In the beginning."]),
    )
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

  it("sets section to '<BOOK> intro' for paratext (book-level front matter)", () => {
    const usfm = "\\id GEN\n\\mt1 Genesis\n\\c 1\n\\v 1 hi\n"
    const [book] = extractUsfmStrings(usfm)
    const paratext = book.strings.find(s => s.type === "paratext")
    expect(paratext?.section).toBe("GEN intro")
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
    expect(book.strings.length).toBeGreaterThanOrEqual(4)
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
    expect(book.strings.map((s) => s.original)).toEqual([
      "Genesis",
      "The Creation",
      "In the beginning God created the heavens , and the earth.",
      "The earth was without form.",
    ])
  })
})

// Real unfoldingWord OT content: verse text flows across \q1/\q2 poetry lines, the
// \v marker itself sits mid-line after the poetry marker, zaln milestones nest, and
// {curly braces} mark implied words that ARE part of ULT's translatable text.
// Before this fix every \q* line was dropped and Psalm 1:2 was not even detected.
describe("extractUsfmStrings — poetry (aligned ULT Psalm 1)", () => {
  it("reconstructs a full verse whose text spans \\q1/\\q2 poetry lines", () => {
    const [book] = extractUsfmStrings(ultPsaRaw)
    expect(book.bookId).toBe("PSA")
    const v1 = book.strings.find((s) => s.context === "PSA 1:1")
    expect(v1?.original).toBe(
      "The happinesses of the man who walks not in the advice of the wicked, and stands not in the pathway of sinners, and sits not in the seat of scoffers,",
    )
  })

  it("detects a verse whose \\v marker sits mid-line after \\q1, and keeps {braces}", () => {
    const [book] = extractUsfmStrings(ultPsaRaw)
    const v2 = book.strings.find((s) => s.context === "PSA 1:2")
    expect(v2).toBeDefined()
    expect(v2?.original).toContain("in the instruction of Yahweh")
    // Nested \zaln-s pairs around "but" must strip cleanly; the {is} implied-word
    // braces are ULT's translatable-text convention and must survive.
    expect(v2?.original).toContain("but in the instruction of Yahweh {is} his delight,")
    expect(v2?.original?.endsWith("he meditates day and night.")).toBe(true)
  })

  it("leaves no alignment or poetry markup in any cell", () => {
    const [book] = extractUsfmStrings(ultPsaRaw)
    for (const s of book.strings) {
      expect(s.original).not.toMatch(/\\zaln|\\w|\\q|x-occurrence|x-strong|\|/)
    }
  })
})

describe("extractUsfmStrings — footnotes, verse ranges, plain poetry", () => {
  it("strips \\f …\\f* footnotes (incl. inner \\fqa) leaving clean verse text", () => {
    const usfm = `\\id MAT
\\c 5
\\v 11 Blessed are you when they persecute you \\f + \\ft A few manuscripts do not include \\fqa lying.\\fqa*\\f* for my sake.`
    const [book] = extractUsfmStrings(usfm)
    const v11 = book.strings.find((s) => s.context === "MAT 5:11")
    expect(v11?.original).toBe("Blessed are you when they persecute you for my sake.")
    expect(v11?.original).not.toMatch(/\\f|\\ft|\\fqa/)
  })

  it("strips footnotes that span multiple lines, and \\x …\\x* cross-references", () => {
    const usfm = `\\id MAT
\\c 1
\\v 1 The book of the genealogy \\f + \\ft a note
that continues on the next line\\f* of Jesus Christ \\x + \\xo 1:1 \\xt Luke 3:23\\x* the son of David.`
    const [book] = extractUsfmStrings(usfm)
    expect(book.strings[0].original).toBe(
      "The book of the genealogy of Jesus Christ the son of David.",
    )
  })

  it("emits ref 'BOOK C:1-2' for verse ranges with clean text", () => {
    const usfm = `\\id MRK
\\c 1
\\v 1-2 The beginning of the gospel of Jesus Christ.`
    const [book] = extractUsfmStrings(usfm)
    const v = book.strings[0]
    expect(v.context).toBe("MRK 1:1-2")
    expect(v.globalReferences).toEqual(["MRK 1:1-2"])
    expect(v.original).toBe("The beginning of the gospel of Jesus Christ.")
  })

  it("keeps plain-USFM \\q continuation text and treats \\d as heading, \\b as skip", () => {
    const usfm = `\\id PSA
\\c 23
\\d A psalm of David.
\\q1
\\v 1 Yahweh is my shepherd;
\\q2 I shall not want.
\\b
\\q1
\\v 2 He makes me lie down in green pastures.`
    const [book] = extractUsfmStrings(usfm)
    const heading = book.strings.find((s) => s.type === "heading")
    expect(heading?.original).toBe("A psalm of David.")
    const v1 = book.strings.find((s) => s.context === "PSA 23:1")
    // The \q2 line's text is verse continuation, not a dropped marker line.
    expect(v1?.original).toBe("Yahweh is my shepherd; I shall not want.")
    const v2 = book.strings.find((s) => s.context === "PSA 23:2")
    expect(v2?.original).toBe("He makes me lie down in green pastures.")
  })
})

// Adversarial-review blockers (AQU-615): each test below encodes the exact failure
// the reviewer reported — malformed/edge USFM that silently lost or corrupted cells.
describe("extractUsfmStrings — unterminated footnotes must not swallow verses", () => {
  it("keeps all three verses when a dangling \\f pairs with a later verse's \\f*", () => {
    // Reviewer probe: the old /\\f\s[\s\S]*?\\f\*/ matched from v1's unterminated
    // opener to v3's closer, yielding ONE cell "alpha tail" — verses 2,3 vanished.
    const usfm = `\\id MAT
\\c 1
\\v 1 alpha \\f + \\ft dangling note
\\v 2 beta
\\v 3 gamma \\f + \\ft real\\f* tail`
    const [book] = extractUsfmStrings(usfm)
    const verses = book.strings.filter((s) => s.type === "verse")
    expect(verses.map((s) => s.context)).toEqual(["MAT 1:1", "MAT 1:2", "MAT 1:3"])
    expect(verses.map((s) => s.original)).toEqual(["alpha", "beta", "gamma tail"])
  })

  it("a dangling \\x cross-reference strips only to end-of-line", () => {
    const usfm = `\\id MAT
\\c 1
\\v 1 first \\x + \\xo 1:1 never closed
\\v 2 second \\x + \\xo 1:2 \\xt Luke 3:23\\x* survives`
    const [book] = extractUsfmStrings(usfm)
    const verses = book.strings.filter((s) => s.type === "verse")
    expect(verses.map((s) => s.original)).toEqual(["first", "second survives"])
  })
})

describe("extractUsfmStrings — \\qs (Selah) and \\qa (acrostic heading)", () => {
  it("keeps \\qs …\\qs* Selah text as part of the verse in plain USFM", () => {
    const usfm = `\\id PSA
\\c 3
\\q1
\\v 2 There is no salvation for him in God.
\\q2 \\qs Selah\\qs*`
    const [book] = extractUsfmStrings(usfm)
    const v2 = book.strings.find((s) => s.context === "PSA 3:2")
    expect(v2?.original).toBe("There is no salvation for him in God. Selah")
  })

  it("keeps Selah in aligned USFM3 where \\qs wraps a \\w word", () => {
    const usfm = `\\id PSA
\\c 3
\\q1
\\v 2 \\zaln-s |x-strong="H0430"\\*\\w God|x-occurrence="1"\\w*\\zaln-e\\*
\\q2 \\qs \\w Selah|x-occurrence="1"\\w*\\qs*`
    const [book] = extractUsfmStrings(usfm)
    const v2 = book.strings.find((s) => s.context === "PSA 3:2")
    expect(v2?.original).toBe("God Selah")
  })

  it("emits \\qa acrostic headings (Psalm 119 letter names) as heading cells", () => {
    const usfm = `\\id PSA
\\c 119
\\qa Aleph
\\q1
\\v 1 Blessed are those whose way is blameless.`
    const [book] = extractUsfmStrings(usfm)
    const heading = book.strings.find((s) => s.type === "heading")
    expect(heading?.original).toBe("Aleph")
    const v1 = book.strings.find((s) => s.context === "PSA 119:1")
    expect(v1?.original).toBe("Blessed are those whose way is blameless.")
  })
})

describe("extractUsfmStrings — ref normalization (deterministic DCS cell ids)", () => {
  it("'\\v 01' produces the same ref as '\\v 1'", () => {
    const usfm = "\\id PSA\n\\c 1\n\\v 01 The happinesses of the man.\n"
    const [book] = extractUsfmStrings(usfm)
    expect(book.strings[0].context).toBe("PSA 1:1")
    expect(book.strings[0].globalReferences).toEqual(["PSA 1:1"])
  })

  it("'\\v 01-02' normalizes each side of the range to 'PSA 1:1-2'", () => {
    const usfm = "\\id PSA\n\\c 1\n\\v 01-02 Combined verses.\n"
    const [book] = extractUsfmStrings(usfm)
    expect(book.strings[0].context).toBe("PSA 1:1-2")
    expect(book.strings[0].globalReferences).toEqual(["PSA 1:1-2"])
  })
})

describe("extractUsfmStrings — pre-verse container text must not mutate headings", () => {
  it("emits '\\q1 words' after a \\s heading (before any \\v) as a chapter text cell", () => {
    const usfm = `\\id PSA
\\c 5
\\s A morning prayer
\\q1 pre-verse poetry line
\\v 1 Give ear to my words, Yahweh.`
    const [book] = extractUsfmStrings(usfm)
    const heading = book.strings.find((s) => s.type === "heading")
    // The heading cell must be untouched — the old continuation path appended the
    // poetry line onto it.
    expect(heading?.original).toBe("A morning prayer")
    const text = book.strings.find((s) => s.type === "text")
    expect(text?.original).toBe("pre-verse poetry line")
    expect(text?.context).toBe("PSA 5")
    const v1 = book.strings.find((s) => s.context === "PSA 5:1")
    expect(v1?.original).toBe("Give ear to my words, Yahweh.")
  })

  it("does not append a post-\\c stray line to the previous chapter's last verse", () => {
    const usfm = `\\id PSA
\\c 1
\\v 6 For Yahweh knows the way of the righteous.
\\c 2
\\q1 orphan line
\\v 1 Why do the nations rage?`
    const [book] = extractUsfmStrings(usfm)
    const v6 = book.strings.find((s) => s.context === "PSA 1:6")
    expect(v6?.original).toBe("For Yahweh knows the way of the righteous.")
    const text = book.strings.find((s) => s.type === "text")
    expect(text?.context).toBe("PSA 2")
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
    const usfm = "\\id LUK\n\\mt1 Luke\n\\c 1\n\\s1 The Coming.\n\\v 1 First verse.\n"
    const [book] = extractUsfmStrings(usfm)
    const heading = book.strings.find(s => s.type === "heading")
    const paratext = book.strings.find(s => s.type === "paratext")
    expect(heading?.globalReferences).toBeUndefined()
    expect(paratext?.globalReferences).toBeUndefined()
  })
})
