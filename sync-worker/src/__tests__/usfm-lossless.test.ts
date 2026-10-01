// Unit tests for the sync-worker's usfm-lossless helpers (AQU-276).
// hasIntraVerseMarkers + countLossyVerses — mirrors src/lib/parsers/usfm-lossless.test.ts.
import { describe, it, expect } from "vitest"
import {
  hasIntraVerseMarkers,
  countLossyVerses,
  parseUsfmLossless,
  serializeUsfmLossless,
} from "../lib/usfm-lossless"

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
    const poeticVerse =
      "Blessed is the man\n\\q1 who walks not in the counsel of the wicked\n\\q2 nor stands in the way of sinners"
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

describe("countLossyVerses (AQU-276)", () => {
  const footnoteUsfm = `\\id MAT
\\c 1
\\v 4 ...\\f + \\fr 1:4 \\ft (Ruth 4:19,20)\\f*
\\v 5 plain text`

  it("returns 0 when no overrides are provided", () => {
    const doc = parseUsfmLossless(footnoteUsfm)
    expect(countLossyVerses(doc, undefined)).toBe(0)
    expect(countLossyVerses(doc, new Map())).toBe(0)
  })

  it("returns 0 when override targets only a plain-text verse", () => {
    const doc = parseUsfmLossless(footnoteUsfm)
    const overrides = new Map([["MAT 1:5", "translated plain"]])
    expect(countLossyVerses(doc, overrides)).toBe(0)
  })

  it("returns 1 when a footnoted verse is overridden", () => {
    const doc = parseUsfmLossless(footnoteUsfm)
    const overrides = new Map([["MAT 1:4", "translated footnoted"]])
    expect(countLossyVerses(doc, overrides)).toBe(1)
  })

  it("does not count an empty override (empty cell = fall back to source)", () => {
    const doc = parseUsfmLossless(footnoteUsfm)
    const overrides = new Map([["MAT 1:4", ""]])
    expect(countLossyVerses(doc, overrides)).toBe(0)
  })

  it("counts multiple lossy verses independently", () => {
    const raw = `\\id PSA
\\c 1
\\v 1 Blessed is the man
\\q1 who walks not in the counsel of the wicked
\\v 2 But his delight
\\q1 is in the law of the LORD
\\v 3 He is like a tree`
    const doc = parseUsfmLossless(raw)
    const overrides = new Map([
      ["PSA 1:1", "Bienaventurado el varón"],
      ["PSA 1:2", "sino que en la ley de Jehová está su delicia"],
      // verse 3 plain, overriding it should not increment
      ["PSA 1:3", "Es como árbol"],
    ])
    // v1 and v2 have \q1 — lossy; v3 is plain text
    expect(countLossyVerses(doc, overrides)).toBe(2)
  })
})

// ── AQU-1068: what the editor did to the file beyond translating it ──────────
//
// Sam settled both rules on 2026-09-09. An added cell is ALWAYS content the
// client's file is missing, never a note-to-self, so it must reach the export;
// and it gets NO verse number of its own, because Biblica asked that nothing
// renumber. A removed cell must leave, or the export silently re-emits the
// client's original words for a line somebody deliberately took out.

const BOOK = [
  "\\id GEN",
  "\\c 1",
  "\\p",
  "\\v 3 And God said, Let there be light.",
  "\\v 4 And God saw the light, that it was good.",
  "\\v 5 And God called the light Day.",
  "",
].join("\n")

describe("serializeUsfmLossless — appending an added cell to its anchor verse", () => {
  it("writes the addition into the verse it follows, with no marker of its own", () => {
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(doc, undefined, {
      appendAfter: new Map([["GEN 1:4", ["Extra content the import dropped."]]]),
    })
    expect(out).toContain("\\v 4 And God saw the light, that it was good. Extra content the import dropped.")
    // No new verse number anywhere, and the neighbours are untouched.
    expect(out).not.toMatch(/\\v 4a|\\v 6/)
    expect(out).toContain("\\v 5 And God called the light Day.")
  })

  it("re-parses to the SAME verse count — nothing renumbered", () => {
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(doc, undefined, {
      appendAfter: new Map([["GEN 1:4", ["Extra content."]]]),
    })
    const reparsed = parseUsfmLossless(out)
    expect(reparsed.verses.map((v) => v.ref)).toEqual(["GEN 1:3", "GEN 1:4", "GEN 1:5"])
    expect(reparsed.verses[1].text.trim()).toBe("And God saw the light, that it was good. Extra content.")
  })

  it("keeps the anchor's ORIGINAL words when the anchor itself is untranslated", () => {
    // The trap that made folding this into `overrides` wrong: an absent or
    // empty override is the serializer's "fall back to source" signal, so
    // appending through that map would have replaced the client's verse with
    // the addition alone.
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(doc, new Map(), {
      appendAfter: new Map([["GEN 1:4", ["Added line."]]]),
    })
    expect(out).toContain("And God saw the light, that it was good. Added line.")
  })

  it("appends AFTER the translation when the anchor is translated", () => {
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(
      doc,
      new Map([["GEN 1:4", "Dieu vit que la lumière était bonne."]]),
      { appendAfter: new Map([["GEN 1:4", ["Ligne ajoutée."]]]) },
    )
    expect(out).toContain("\\v 4 Dieu vit que la lumière était bonne. Ligne ajoutée.")
    expect(out).not.toContain("And God saw the light")
  })

  it("keeps several additions on one anchor in the order given", () => {
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(doc, undefined, {
      appendAfter: new Map([["GEN 1:4", ["First added.", "Second added."]]]),
    })
    expect(out).toContain("that it was good. First added. Second added.")
  })

  it("ignores an empty addition rather than emitting a stray space", () => {
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(doc, undefined, {
      appendAfter: new Map([["GEN 1:4", ["", "   "]]]),
    })
    expect(out).toBe(BOOK)
  })

  it("ignores an anchor ref that is not in the file", () => {
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(doc, undefined, {
      appendAfter: new Map([["GEN 9:99", ["Nowhere to go."]]]),
    })
    expect(out).toBe(BOOK)
  })

  it("changes nothing at all when there are no edits", () => {
    const doc = parseUsfmLossless(BOOK)
    expect(serializeUsfmLossless(doc, undefined, {})).toBe(BOOK)
    expect(serializeUsfmLossless(doc)).toBe(BOOK)
  })
})

describe("serializeUsfmLossless — removing a verse the editor deleted", () => {
  it("takes the whole verse out, marker included", () => {
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(doc, undefined, { remove: new Set(["GEN 1:4"]) })
    expect(out).not.toContain("And God saw the light")
    // The marker must go with it. This is what `markerStart` exists for —
    // without it the words leave and a bare `\v 4` stays behind.
    expect(out).not.toContain("\\v 4")
  })

  it("leaves the verses around it exactly as they were — nothing renumbers", () => {
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(doc, undefined, { remove: new Set(["GEN 1:4"]) })
    const reparsed = parseUsfmLossless(out)
    expect(reparsed.verses.map((v) => v.ref)).toEqual(["GEN 1:3", "GEN 1:5"])
    expect(reparsed.verses[1].text.trim()).toBe("And God called the light Day.")
  })

  it("re-parses cleanly — the output is still valid USFM", () => {
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(doc, undefined, { remove: new Set(["GEN 1:4"]) })
    expect(parseUsfmLossless(out).bookId).toBe("GEN")
    expect(out).toContain("\\c 1")
    expect(out).toContain("\\p")
  })

  it("removes the LAST verse without eating the file's tail", () => {
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(doc, undefined, { remove: new Set(["GEN 1:5"]) })
    expect(out).not.toContain("And God called the light Day")
    expect(out).toContain("\\v 4 And God saw the light, that it was good.")
    expect(parseUsfmLossless(out).verses.map((v) => v.ref)).toEqual(["GEN 1:3", "GEN 1:4"])
  })

  it("removes the FIRST verse without disturbing the chapter or paragraph markers", () => {
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(doc, undefined, { remove: new Set(["GEN 1:3"]) })
    expect(out).toContain("\\id GEN")
    expect(out).toContain("\\c 1")
    expect(out).toContain("\\p")
    expect(parseUsfmLossless(out).verses.map((v) => v.ref)).toEqual(["GEN 1:4", "GEN 1:5"])
  })

  it("removes several at once", () => {
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(doc, undefined, { remove: new Set(["GEN 1:3", "GEN 1:5"]) })
    expect(parseUsfmLossless(out).verses.map((v) => v.ref)).toEqual(["GEN 1:4"])
  })

  it("wins over an override for the same verse — a removal is not a translation", () => {
    const doc = parseUsfmLossless(BOOK)
    const out = serializeUsfmLossless(
      doc,
      new Map([["GEN 1:4", "Dieu vit que la lumière était bonne."]]),
      { remove: new Set(["GEN 1:4"]) },
    )
    expect(out).not.toContain("Dieu vit")
    expect(out).not.toContain("\\v 4")
  })

  it("removes a heading as well as a verse", () => {
    const withHeading = [
      "\\id GEN",
      "\\c 1",
      "\\s1 The First Day",
      "\\p",
      "\\v 3 And God said, Let there be light.",
      "",
    ].join("\n")
    const doc = parseUsfmLossless(withHeading)
    const headingRef = doc.headings[0].ref
    const out = serializeUsfmLossless(doc, undefined, { remove: new Set([headingRef]) })
    expect(out).not.toContain("The First Day")
    expect(out).not.toContain("\\s1")
    expect(out).toContain("\\v 3 And God said, Let there be light.")
  })

  it("ignores a ref that is not in the file", () => {
    const doc = parseUsfmLossless(BOOK)
    expect(serializeUsfmLossless(doc, undefined, { remove: new Set(["GEN 9:99"]) })).toBe(BOOK)
  })
})

// AQU-865: Gretchen (Biblica Global Publishing) reported a native export writing
// only the LAST number of a verse range — "\v 1-3" coming back as "\v 3". This is
// where Aquilla's USFM export actually happens (export-route.ts /
// export-bundle-route.ts both parse the stored original and serialize through
// here), so this is where the property has to be pinned: the `\v` token is copied
// out of the client's own bytes and only the TEXT span between markers is
// substituted, so no verse number is ever recomposed from a parsed value.
// Mirrored in src/lib/parsers/usfm-lossless.test.ts.
describe("serializeUsfmLossless — verse-range labels (AQU-865)", () => {
  const RANGE_BOOK = [
    "\\id GEN",
    "\\c 1",
    "\\p",
    "\\v 1-3 En el principio creó Dios los cielos y la tierra.",
    "\\v 4a Y vio Dios que la luz era buena,",
    "\\v 4b y separó la luz de las tinieblas.",
    "\\v 5 Y llamó Dios a la luz Día.",
    "",
  ].join("\n")

  /** Every verse token the file actually carries, in document order. */
  const verseTokens = (usfm: string): string[] =>
    [...usfm.matchAll(/\\v (\S+)/g)].map((m) => m[1])

  it("parses the range as one verse whose ref carries the whole range", () => {
    const doc = parseUsfmLossless(RANGE_BOOK)
    expect(doc.verses.map((v) => v.ref)).toEqual([
      "GEN 1:1-3",
      "GEN 1:4a",
      "GEN 1:4b",
      "GEN 1:5",
    ])
  })

  it("keeps the full range on the marker when the range verse is translated", () => {
    const doc = parseUsfmLossless(RANGE_BOOK)
    const out = serializeUsfmLossless(doc, new Map([["GEN 1:1-3", "In the beginning God created."]]))
    expect(out).toContain("\\v 1-3 In the beginning God created.")
    // The reported defect: the range collapsed to its last (or first) member.
    expect(verseTokens(out)).toEqual(["1-3", "4a", "4b", "5"])
  })

  it("keeps a suffixed verse token intact too", () => {
    const doc = parseUsfmLossless(RANGE_BOOK)
    const out = serializeUsfmLossless(doc, new Map([["GEN 1:4a", "And God saw the light was good,"]]))
    expect(out).toContain("\\v 4a And God saw the light was good,")
    expect(out).toContain("\\v 4b y separó la luz de las tinieblas.")
    expect(verseTokens(out)).toEqual(["1-3", "4a", "4b", "5"])
  })

  it("re-parses to the SAME refs — no range is renumbered or expanded", () => {
    const doc = parseUsfmLossless(RANGE_BOOK)
    const out = serializeUsfmLossless(
      doc,
      new Map([
        ["GEN 1:1-3", "In the beginning God created."],
        ["GEN 1:5", "And God called the light Day."],
      ]),
    )
    expect(parseUsfmLossless(out).verses.map((v) => v.ref)).toEqual([
      "GEN 1:1-3",
      "GEN 1:4a",
      "GEN 1:4b",
      "GEN 1:5",
    ])
  })

  it("leaves an untranslated range verse byte-identical", () => {
    const doc = parseUsfmLossless(RANGE_BOOK)
    expect(serializeUsfmLossless(doc, new Map([["GEN 1:5", "Day."]]))).toContain(
      "\\v 1-3 En el principio creó Dios los cielos y la tierra.",
    )
    expect(serializeUsfmLossless(doc)).toBe(RANGE_BOOK)
  })

  it("counts a translated range verse once for the lossy-verse warning", () => {
    // AQU-276's honesty counter addresses verses by the same ref, so a range
    // must be reachable there too — otherwise a range with intra-verse markup
    // would be silently excluded from the warning.
    const withMarkup = RANGE_BOOK.replace(
      "\\v 1-3 En el principio",
      "\\v 1-3 \\nd Dios\\nd* en el principio",
    )
    const doc = parseUsfmLossless(withMarkup)
    expect(countLossyVerses(doc, new Map([["GEN 1:1-3", "In the beginning."]]))).toBe(1)
  })

  it("appends an added cell to the range verse without inventing a number", () => {
    const doc = parseUsfmLossless(RANGE_BOOK)
    const out = serializeUsfmLossless(doc, undefined, {
      appendAfter: new Map([["GEN 1:1-3", ["Contenido añadido."]]]),
    })
    expect(out).toContain("\\v 1-3 En el principio creó Dios los cielos y la tierra. Contenido añadido.")
    expect(verseTokens(out)).toEqual(["1-3", "4a", "4b", "5"])
  })

  it("removes a range verse whole — marker and range together", () => {
    const doc = parseUsfmLossless(RANGE_BOOK)
    const out = serializeUsfmLossless(doc, undefined, { remove: new Set(["GEN 1:1-3"]) })
    // Neither the words nor a bare/partial marker may survive. A leftover
    // "\v 1" or "\v 3" here would BE the reported bug, arrived at by deletion.
    expect(out).not.toContain("En el principio")
    expect(verseTokens(out)).toEqual(["4a", "4b", "5"])
    expect(out).toContain("\\v 4a Y vio Dios que la luz era buena,")
  })
})
