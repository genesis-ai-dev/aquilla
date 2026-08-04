import { describe, it, expect } from "vitest"
import {
  parseUsfmLossless,
  serializeUsfmLossless,
  hasIntraVerseMarkers,
  stripBom,
  isBookTitleOrIntroMarker,
} from "./usfm-lossless"

// AQU-585: classifies book-name/introduction front matter that import must not
// turn into translatable cells, while leaving in-body headings alone.
describe("isBookTitleOrIntroMarker", () => {
  it("matches book-name markers (running header, TOC, main title)", () => {
    for (const m of ["h", "h1", "h2", "h3", "toc1", "toc2", "toc3", "toca1",
                     "mt", "mt1", "mt2", "mt3", "mt4", "mte", "mte1", "mte2"]) {
      expect(isBookTitleOrIntroMarker(m)).toBe(true)
    }
  })

  it("matches every introduction marker (all begin with 'i')", () => {
    for (const m of ["imt", "imt1", "is", "is1", "ip", "ipi", "ipq", "im", "imi",
                     "iq", "iq1", "io", "io1", "io2", "iot", "ior", "iex", "ib", "ie", "ili", "ili1"]) {
      expect(isBookTitleOrIntroMarker(m)).toBe(true)
    }
  })

  it("does NOT match in-body section headings or Psalm titles", () => {
    for (const m of ["s", "s1", "s2", "ms", "ms1", "sr", "mr", "r", "d"]) {
      expect(isBookTitleOrIntroMarker(m)).toBe(false)
    }
  })
})

describe("parseUsfmLossless", () => {
  it("identifies verses with book + chapter context", () => {
    const raw = `\\id GEN
\\c 1
\\p
\\v 1 In the beginning God created the heavens and the earth.
\\v 2 The earth was without form.`
    const doc = parseUsfmLossless(raw)
    expect(doc.bookId).toBe("GEN")
    expect(doc.verses).toHaveLength(2)
    expect(doc.verses[0].ref).toBe("GEN 1:1")
    expect(doc.verses[0].text).toBe("In the beginning God created the heavens and the earth.\n")
    expect(doc.verses[1].ref).toBe("GEN 1:2")
    expect(doc.verses[1].text).toBe("The earth was without form.")
  })

  it("keeps inline footnotes inside the verse text — does not leak", () => {
    const raw = `\\id MAT
\\c 1
\\v 4 ...\\f + \\fr 1:4 \\ft (Ruth 4:19,20)\\f*
\\v 5 next verse text`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses[0].text).toBe("...\\f + \\fr 1:4 \\ft (Ruth 4:19,20)\\f*\n")
    expect(doc.verses[1].text).toBe("next verse text")
  })

  it("keeps poetry continuations INSIDE the verse text", () => {
    // \q1/\q2 are paragraph-style markers WITHIN a verse — they belong to the
    // same verse, not a new one. The translator needs to see and edit the
    // whole verse including its poetic structure.
    const raw = `\\id PSA
\\c 1
\\v 1 Blessed is the man
\\q1 who walks not in the counsel of the wicked
\\q2 nor stands in the way of sinners`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses).toHaveLength(1)
    expect(doc.verses[0].text).toContain("Blessed is the man")
    expect(doc.verses[0].text).toContain("\\q1 who walks not in the counsel of the wicked")
    expect(doc.verses[0].text).toContain("\\q2 nor stands in the way of sinners")
  })

  it("terminates verse text at section headings", () => {
    const raw = `\\id MAT
\\c 1
\\v 1 verse one content
\\s A new section
\\p
\\v 2 next verse`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses).toHaveLength(2)
    expect(doc.verses[0].text).toBe("verse one content\n")
    expect(doc.verses[1].text).toBe("next verse")
  })

  it("extracts translatable headings (\\s, \\mt, \\h, \\toc) as separate cells", () => {
    const raw = `\\id GEN
\\h Genesis
\\toc1 The First Book of Moses
\\toc2 Genesis
\\mt1 Genesis
\\c 1
\\s The Creation
\\v 1 In the beginning.`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses).toHaveLength(1)
    const refs = doc.headings.map((h) => h.ref)
    expect(refs).toContain("GEN:h:1")
    expect(refs).toContain("GEN:toc1:1")
    expect(refs).toContain("GEN:mt1:1")
    expect(refs).toContain("GEN 1:s:1")
    const hMap = new Map(doc.headings.map((h) => [h.ref, h.text]))
    expect(hMap.get("GEN:h:1")).toBe("Genesis")
    expect(hMap.get("GEN:mt1:1")).toBe("Genesis")
    expect(hMap.get("GEN 1:s:1")).toBe("The Creation")
  })

  // AQU-634: front matter imports by default; the per-project opt-out excludes it.
  const FRONT_MATTER_RAW = `\\id GEN
\\h Genesis
\\toc1 The First Book of Moses
\\mt1 Genesis
\\imt Introduction
\\is Author
\\ip Moses wrote this book.
\\io1 The creation (1–2)
\\iot Outline
\\c 1
\\d A psalm of David
\\s The Creation
\\ms Major section
\\v 1 In the beginning.`

  it("imports book title, TOC, and the intro block as cells BY DEFAULT (AQU-634)", () => {
    const doc = parseUsfmLossless(FRONT_MATTER_RAW)
    const markers = doc.headings.map((h) => h.marker)
    expect(markers).toEqual(
      expect.arrayContaining(["h", "toc1", "mt1", "imt", "is", "ip", "io1", "iot"]),
    )
    // The reproduction step that previously produced no front-matter cells now does.
    const texts = new Map(doc.headings.map((h) => [h.marker, h.text]))
    expect(texts.get("h")).toBe("Genesis")
    expect(texts.get("mt1")).toBe("Genesis")
    expect(texts.get("ip")).toBe("Moses wrote this book.")
  })

  it("EXCLUDES front matter but keeps section headings + \\d when opted out (AQU-634)", () => {
    const doc = parseUsfmLossless(FRONT_MATTER_RAW, { excludeFrontMatter: true })
    const markers = doc.headings.map((h) => h.marker)
    // Book-name/title/TOC + full intro block are gone…
    for (const m of ["h", "toc1", "mt1", "imt", "is", "ip", "io1", "iot"]) {
      expect(markers).not.toContain(m)
    }
    // …while in-body section headings (\s, \ms) and the Psalm title (\d) remain.
    expect(markers).toEqual(expect.arrayContaining(["d", "s", "ms"]))
    // Verses are unaffected in either mode.
    expect(doc.verses).toHaveLength(1)
    expect(doc.verses[0].text).toBe("In the beginning.")
  })

  it("round-trips byte-for-byte in BOTH modes (excludeFrontMatter never touches raw)", () => {
    // AC4: the lossless parser/serializer is unaffected by the opt-out.
    expect(serializeUsfmLossless(parseUsfmLossless(FRONT_MATTER_RAW))).toBe(FRONT_MATTER_RAW)
    expect(
      serializeUsfmLossless(parseUsfmLossless(FRONT_MATTER_RAW, { excludeFrontMatter: true })),
    ).toBe(FRONT_MATTER_RAW)
  })

  it("indexes multiple headings of the same kind per chapter", () => {
    const raw = `\\id MAT
\\c 1
\\s First section
\\v 1 a
\\s Second section
\\v 2 b
\\s Third section
\\v 3 c`
    const doc = parseUsfmLossless(raw)
    const sectionRefs = doc.headings.filter((h) => h.marker === "s").map((h) => h.ref)
    expect(sectionRefs).toEqual(["MAT 1:s:1", "MAT 1:s:2", "MAT 1:s:3"])
  })

  it("handles verse numbers with ranges and suffixes", () => {
    const raw = `\\id GEN
\\c 1
\\v 1-3 combined range text
\\v 4a part a text`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses[0].number).toBe("1-3")
    expect(doc.verses[0].ref).toBe("GEN 1:1-3")
    expect(doc.verses[1].number).toBe("4a")
  })

  it("handles empty verses (no text on the line)", () => {
    const raw = `\\id GEN
\\c 1
\\v 1
\\v 2 has text`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses).toHaveLength(2)
    expect(doc.verses[0].text).toBe("\n")
    expect(doc.verses[1].text).toBe("has text")
  })

  it("tolerates a leading UTF-8 BOM", () => {
    const raw = `﻿\\id GEN
\\c 1
\\v 1 In the beginning.`
    const doc = parseUsfmLossless(raw)
    expect(doc.bookId).toBe("GEN")
    expect(doc.verses).toHaveLength(1)
    expect(doc.verses[0].text).toBe("In the beginning.")
  })
})

describe("serializeUsfmLossless", () => {
  it("is byte-identical when no overrides are provided", () => {
    const raw = `\\id MRK
\\c 1
\\p
\\v 1 The beginning of the gospel of Jesus Christ.
\\v 2 As it is written in the prophet Isaiah,
\\q1 "Behold, I send my messenger before your face,
\\q2 who will prepare your way,
\\f + \\fr 1:2 \\ft Mal 3:1\\f*`
    const doc = parseUsfmLossless(raw)
    expect(serializeUsfmLossless(doc)).toBe(raw)
  })

  it("substitutes only the targeted verse", () => {
    const raw = `\\id GEN
\\c 1
\\v 1 original one
\\v 2 original two
\\v 3 original three`
    const doc = parseUsfmLossless(raw)
    const out = serializeUsfmLossless(doc, { "GEN 1:2": "translated two" })
    expect(out).toBe(`\\id GEN
\\c 1
\\v 1 original one
\\v 2 translated two
\\v 3 original three`)
  })

  it("injects a separator when overriding an originally empty verse", () => {
    const raw = `\\id GEN
\\c 1
\\v 1
\\v 2 has text`
    const doc = parseUsfmLossless(raw)
    const out = serializeUsfmLossless(doc, { "GEN 1:1": "translated one" })
    expect(out).toContain("\\v 1 translated one")
    expect(out).not.toContain("\\v 1translated") // no concatenation
  })

  it("injects a trailing newline if override would run into the next marker", () => {
    const raw = `\\id GEN
\\c 1
\\v 1
\\v 2 second`
    const doc = parseUsfmLossless(raw)
    const out = serializeUsfmLossless(doc, { "GEN 1:1": "no trailing newline" })
    // Even though the override has no \n, the serializer must add one before \v 2
    expect(out).toContain("no trailing newline\n\\v 2")
  })

  it("preserves footnotes verbatim when other verses are overridden", () => {
    const raw = `\\id MAT
\\c 1
\\v 4 first text \\f + \\fr 1:4 \\ft (Ruth 4:19,20)\\f*
\\v 5 second text`
    const doc = parseUsfmLossless(raw)
    const out = serializeUsfmLossless(doc, { "MAT 1:5": "replaced" })
    expect(out).toContain("\\f + \\fr 1:4 \\ft (Ruth 4:19,20)\\f*")
    expect(out).toContain("\\v 5 replaced")
  })

  it("substitutes heading overrides too", () => {
    const raw = `\\id GEN
\\mt1 Genesis
\\c 1
\\s The Creation
\\v 1 In the beginning.`
    const doc = parseUsfmLossless(raw)
    const out = serializeUsfmLossless(doc, {
      "GEN:mt1:1": "El Génesis",
      "GEN 1:s:1": "La Creación",
    })
    expect(out).toContain("\\mt1 El Génesis")
    expect(out).toContain("\\s La Creación")
    expect(out).toContain("\\v 1 In the beginning.")
  })
})

describe("hasIntraVerseMarkers (AQU-276)", () => {
  it("returns false for plain prose verse text", () => {
    expect(hasIntraVerseMarkers("In the beginning God created the heavens and the earth.")).toBe(false)
    expect(hasIntraVerseMarkers("The earth was without form.\n")).toBe(false)
  })

  it("detects inline footnotes (\\f...\\f*)", () => {
    expect(hasIntraVerseMarkers("...\\f + \\fr 1:4 \\ft (Ruth 4:19,20)\\f*\n")).toBe(true)
  })

  it("detects inline cross-references (\\x...\\x*)", () => {
    expect(hasIntraVerseMarkers("some text \\x - \\xo 1:1 \\xt Gen 1:1\\x*")).toBe(true)
  })

  it("detects poetry continuation markers on their own lines", () => {
    // verse text captured by parser includes the \q1/\q2 lines
    const poeticVerse = "Blessed is the man\n\\q1 who walks not in the counsel of the wicked\n\\q2 nor stands in the way of sinners"
    expect(hasIntraVerseMarkers(poeticVerse)).toBe(true)
  })

  it("detects paragraph breaks inside a verse (\\p, \\m, \\b)", () => {
    expect(hasIntraVerseMarkers("first line\n\\p second paragraph\n")).toBe(true)
    expect(hasIntraVerseMarkers("line one\n\\b\n")).toBe(true)
  })

  it("detects character-level markers (\\wj, \\nd, \\add)", () => {
    expect(hasIntraVerseMarkers("He said, \\wj Come to me.\\wj*")).toBe(true)
    expect(hasIntraVerseMarkers("The \\nd Lord\\nd* your God.")).toBe(true)
    expect(hasIntraVerseMarkers("\\add (added text)\\add*")).toBe(true)
  })

  it("returns false for a verse that is only whitespace / newlines", () => {
    expect(hasIntraVerseMarkers("\n")).toBe(false)
    expect(hasIntraVerseMarkers("")).toBe(false)
  })
})

describe("stripBom", () => {
  it("removes a leading BOM if present", () => {
    expect(stripBom("﻿hello")).toBe("hello")
    expect(stripBom("hello")).toBe("hello")
  })
})

// ── D2: paragraphStart detection ────────────────────────────────────────────
//
// These tests encode WHY the behaviour matters, not just WHAT it does:
//   - Paragraph is a GROUPING over cells; the verse is the alignment unit and
//     must never be split (D1). paragraphStart is a grouping signal only.
//   - \p and \v are orthogonal in USFM (D2). A \p inside a verse's text span
//     must NOT be treated as a paragraph-start for the following verse.
//
// See docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md (D1,D2).

describe("parseUsfmLossless — paragraphStart (D2)", () => {
  it("sets paragraphStart on a verse preceded by \\p", () => {
    const raw = `\\id RUT
\\c 1
\\p
\\v 1 Now it came to pass in the days when the judges ruled.
\\v 2 And the name of the man was Elimelech.`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses).toHaveLength(2)
    // Verse 1 is the paragraph-starter (\\p came before \\v 1)
    expect(doc.verses[0].paragraphStart).toBe(true)
    // Verse 2 is a continuation — no \\p between \\v 1 and \\v 2
    expect(doc.verses[1].paragraphStart).toBeUndefined()
  })

  it("sets paragraphStart on a verse preceded by \\q1 (poetry opening)", () => {
    const raw = `\\id PSA
\\c 1
\\q1
\\v 1 Blessed is the man
\\v 2 who walks not in the counsel.`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses[0].paragraphStart).toBe(true)
    expect(doc.verses[1].paragraphStart).toBeUndefined()
  })

  it("handles multiple paragraph blocks within a chapter", () => {
    // Encodes D1/D2: each \\p before a verse marks that verse as a paragraph
    // opener; continuation verses carry no flag.
    const raw = `\\id GEN
\\c 2
\\p
\\v 1 Thus the heavens and the earth were completed.
\\v 2 By the seventh day God completed his work.
\\p
\\v 3 Then God blessed the seventh day.`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses).toHaveLength(3)
    expect(doc.verses[0].paragraphStart).toBe(true)   // after \\p
    expect(doc.verses[1].paragraphStart).toBeUndefined() // continuation
    expect(doc.verses[2].paragraphStart).toBe(true)   // after second \\p
  })

  it("intra-verse \\q1/\\q2 markers do NOT cause the NEXT verse to be a paragraph-start", () => {
    // This is the critical anti-split invariant (D1):
    //   \\q1/\\q2 inside a verse's text span belong to that verse and must
    //   never be confused with a pre-verse paragraph signal for the FOLLOWING
    //   verse. Splitting below the verse would shred alignment.
    const raw = `\\id PSA
\\c 1
\\q1
\\v 1 Blessed is the man
\\q1 who walks not in the counsel of the wicked
\\q2 nor stands in the way of sinners
\\v 2 but his delight is in the law of the LORD`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses).toHaveLength(2)
    // Verse 1: \\q1 before \\v 1 → paragraph-start
    expect(doc.verses[0].paragraphStart).toBe(true)
    // Verse 1 text must include the intra-verse \\q1/\\q2 markers unchanged
    expect(doc.verses[0].text).toContain("\\q1 who walks not in the counsel")
    expect(doc.verses[0].text).toContain("\\q2 nor stands in the way")
    // Verse 2: the \\q1/\\q2 inside verse 1 must NOT bleed into verse 2
    expect(doc.verses[1].paragraphStart).toBeUndefined()
    // And verse 1 still has only ONE verse (D1: never split)
    expect(doc.verses).toHaveLength(2)
  })

  it("a verse containing \\p mid-text is not split — verse boundary unchanged", () => {
    // D1: paragraph is a grouping over cells, never a re-segmentation.
    // \\p markers in USFM are bare lines (no content on the same line); the
    // verse scanner captures them inside the verse's text span verbatim, but
    // the verse boundary itself is NEVER moved. paragraphStart is a grouping
    // signal only — the verse count stays at 3 regardless of how many \\p appear.
    const raw = `\\id ACT
\\c 1
\\p
\\v 1 first verse
\\p
\\v 2 second verse text
\\p
\\v 3 third verse`
    const doc = parseUsfmLossless(raw)
    // Critical: verse count is unchanged — no splitting below the alignment unit.
    expect(doc.verses).toHaveLength(3)
    // Each verse preceded by a bare \\p carries paragraphStart.
    expect(doc.verses[0].paragraphStart).toBe(true)
    expect(doc.verses[1].paragraphStart).toBe(true)
    expect(doc.verses[2].paragraphStart).toBe(true)
  })

  it("\\b (blank line) marker triggers paragraphStart", () => {
    const raw = `\\id PSA
\\c 119
\\p
\\v 1 Blessed are those whose way is blameless.
\\b
\\q1
\\v 9 How can a young man keep his way pure?`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses[0].paragraphStart).toBe(true)
    expect(doc.verses[1].paragraphStart).toBe(true)
  })

  it("\\m (margin paragraph) triggers paragraphStart", () => {
    const raw = `\\id MAT
\\c 5
\\m
\\v 1 Seeing the crowds, he went up on the mountain.
\\v 2 And he opened his mouth and taught them.`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses[0].paragraphStart).toBe(true)
    expect(doc.verses[1].paragraphStart).toBeUndefined()
  })

  it("first verse of a chapter starts a paragraph even without \\p; mid-chapter unmarked verses do not (p1-usfm-chapter-no-p)", () => {
    // Minimal/malformed USFM may omit the \\p after \\c. A chapter boundary still
    // begins a new paragraph group; a mid-chapter verse with no marker continues.
    const raw = `\\id GEN
\\c 1
\\v 1 first verse of the chapter, no paragraph marker
\\v 2 second verse, still no marker
\\c 2
\\v 1 first verse of chapter two, also no marker`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses).toHaveLength(3)
    expect(doc.verses[0].paragraphStart).toBe(true)      // c1 v1 — chapter boundary
    expect(doc.verses[2].paragraphStart).toBe(true)      // c2 v1 — chapter boundary
    expect(doc.verses[1].paragraphStart).toBeUndefined() // c1 v2 — mid-chapter continuation
  })

  it("section headings between verses reset paragraph-start accumulation", () => {
    // A \\s (section heading — a TERMINATE_VERSE_MARKERS member) appears between
    // two verses. A \\p after \\s and before \\v should still trigger paragraphStart.
    const raw = `\\id MAT
\\c 5
\\p
\\v 1 first verse
\\s The Beatitudes
\\p
\\v 2 second verse`
    const doc = parseUsfmLossless(raw)
    expect(doc.verses[0].paragraphStart).toBe(true)
    expect(doc.verses[1].paragraphStart).toBe(true)
  })
})
