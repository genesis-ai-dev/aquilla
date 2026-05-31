// @vitest-environment happy-dom
import { describe, it, expect } from "vitest"
import { usxToUsfm, looksLikeUsx } from "./usx"
import { parseUsfmLossless } from "./usfm-lossless"

const USX = `<?xml version="1.0" encoding="utf-8"?>
<usx version="3.0">
  <book code="MAT" style="id">Matthew - Test</book>
  <para style="h">Matthew</para>
  <para style="mt1">The Gospel of Matthew</para>
  <chapter number="1" style="c" sid="MAT 1" />
  <para style="s1">The Genealogy</para>
  <para style="p">
    <verse number="1" style="v" sid="MAT 1:1" />In the beginning<note caller="+" style="f"><char style="fr">1:1</char><char style="ft">A footnote.</char></note> the <char style="nd">LORD</char> God.<verse eid="MAT 1:1" />
    <verse number="2" style="v" sid="MAT 1:2" />Second verse.<verse eid="MAT 1:2" />
  </para>
</usx>`

describe("usxToUsfm", () => {
  const usfm = usxToUsfm(USX)
  const doc = parseUsfmLossless(usfm)

  it("recovers the book id", () => {
    expect(doc.bookId).toBe("MAT")
  })

  it("recovers verses with refs + text, footnotes/char markers kept inline", () => {
    expect(doc.verses).toHaveLength(2)
    const v1 = doc.verses.find((v) => v.ref === "MAT 1:1")!
    expect(v1.text).toContain("In the beginning")
    expect(v1.text).toContain("the \\nd LORD\\nd* God.")
    expect(v1.text).toContain("\\f + \\fr 1:1 \\ft A footnote.\\f*")
    expect(doc.verses.find((v) => v.ref === "MAT 1:2")!.text).toContain("Second verse.")
  })

  it("recovers headings + titles as translatable paratext", () => {
    const refs = new Map(doc.headings.map((h) => [h.marker, h.text]))
    expect(refs.get("h")).toBe("Matthew")
    expect(refs.get("mt1")).toBe("The Gospel of Matthew")
    expect(refs.get("s1")).toBe("The Genealogy")
  })

  it("produces parseable USFM (verse markers at line start)", () => {
    // Each verse must begin a line so the lossless parser can find it.
    expect(usfm).toMatch(/\n\\v 1 /)
    expect(usfm).toMatch(/\n\\v 2 /)
    expect(usfm).toMatch(/\n\\c 1/)
  })

  it("drops verse-end and chapter-end milestones", () => {
    expect(usfm).not.toContain("eid")
  })
})

describe("looksLikeUsx", () => {
  it("detects a USX document", () => {
    expect(looksLikeUsx(USX)).toBe(true)
    expect(looksLikeUsx(`<usx version="3.0"><book code="GEN" style="id"/></usx>`)).toBe(true)
  })
  it("rejects raw USFM", () => {
    expect(looksLikeUsx("\\id GEN\n\\c 1\n\\v 1 In the beginning.")).toBe(false)
  })
})
