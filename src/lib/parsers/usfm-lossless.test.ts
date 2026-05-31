import { describe, it, expect } from "vitest"
import {
  parseUsfmLossless,
  serializeUsfmLossless,
  stripBom,
} from "./usfm-lossless"

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

describe("stripBom", () => {
  it("removes a leading BOM if present", () => {
    expect(stripBom("﻿hello")).toBe("hello")
    expect(stripBom("hello")).toBe("hello")
  })
})
