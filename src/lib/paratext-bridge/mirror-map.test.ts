import { describe, it, expect } from "vitest"
import { deriveUnits } from "./units"
import { planWriteBack } from "./write-back"
import { cellUnitText, diffCellsAgainstUnits, htmlToUnitText, unitsByRef } from "./mirror-map"

const enc = new TextEncoder()
const dec = new TextDecoder()

const BOOK = [
  "\\id MAT - Test",
  "\\c 1",
  "\\s1 Genealogy",
  "\\p",
  "\\v 1 The book of the genealogy.",
  "\\v 2 Abraham fathered Isaac.",
  "\\v 3 ",
  "\\s1 Second heading",
  "\\v 4 Judah fathered Perez\\f + \\fr 1:4 \\ft Note\\f* and Zerah.",
  "\\c 2",
  "\\v 1 Jesus was born.",
  "\\v 1 Duplicate verse one.",
  "",
].join("\n")

describe("htmlToUnitText — what the editor holds, as a unit would hold it", () => {
  it("strips inline marks and decodes entities, keeping the words", () => {
    expect(htmlToUnitText("<p>Abraham <strong>fathered</strong> &amp; raised <em>Isaac</em>.</p>")).toBe("Abraham fathered & raised Isaac.")
  })
  it("keeps backslash markers the translator typed, so footnotes survive the round trip", () => {
    expect(htmlToUnitText("<p>Judah fathered Perez\\f + \\fr 1:4 \\ft Note\\f* and Zerah.</p>")).toBe("Judah fathered Perez\\f + \\fr 1:4 \\ft Note\\f* and Zerah.")
  })
  it("turns block boundaries into single line breaks and drops trailing space", () => {
    expect(htmlToUnitText("<p>First line </p><p>Second line</p><p></p>")).toBe("First line\nSecond line")
    expect(htmlToUnitText("<p>One<br>Two</p>")).toBe("One\nTwo")
  })
  it("normalises to NFC and turns non-breaking spaces into spaces so rawHash comparisons are honest", () => {
    expect(htmlToUnitText("<p>é&nbsp;x</p>")).toBe("é x")
  })
})

describe("cellUnitText", () => {
  it("prefers the plain value and falls back to the HTML", () => {
    expect(cellUnitText({ cellId: "c", ref: "MAT 1:1", value: "Plain ", valueHtml: "<p>Rich</p>" })).toBe("Plain")
    expect(cellUnitText({ cellId: "c", ref: "MAT 1:1", value: "", valueHtml: "<p>Rich</p>" })).toBe("Rich")
    expect(cellUnitText({ cellId: "c", ref: "MAT 1:1" })).toBe("")
  })
})

describe("diffCellsAgainstUnits — cells join units by the importer's reference", () => {
  it("matches verses and headings by ref, and only changed cells become edits", async () => {
    const base = await deriveUnits(enc.encode(BOOK))
    const byRef = unitsByRef(base.units)
    expect(byRef.get("MAT 1:2")?.id).toBe("MAT 1:2")
    // The importer counts headings per book; the bridge scopes them per verse.
    expect(byRef.get("MAT 1:s1:2")?.id).toBe("MAT 1:3/s1#0")
    const { edits, unmapped } = diffCellsAgainstUnits([
      { cellId: "a", ref: "MAT 1:1", value: "The book of the genealogy." },   // unchanged
      { cellId: "b", ref: "MAT 1:2", value: "Abraham was the father of Isaac." },
      { cellId: "h", ref: "MAT 1:s1:2", value: "A better heading" },
      { cellId: "e", ref: "MAT 1:3", value: "Filled in." },                   // empty verse gets text
      { cellId: "n", ref: "MAT 1:4" },                                       // no target row: untouched
    ], base)
    expect(unmapped).toEqual([])
    expect(edits.map((e) => e.unitId)).toEqual(["MAT 1:2", "MAT 1:3/s1#0", "MAT 1:3"])
    expect(edits[0]).toEqual({ unitId: "MAT 1:2", text: "Abraham was the father of Isaac.", baseRawHash: byRef.get("MAT 1:2")!.rawHash })
  })

  it("refuses to guess at a reference the file holds twice, and reports cells the file no longer has", async () => {
    const base = await deriveUnits(enc.encode(BOOK))
    const { edits, unmapped } = diffCellsAgainstUnits([
      { cellId: "d", ref: "MAT 2:1", value: "Which one?" },
      { cellId: "g", ref: "MAT 3:1", value: "Gone" },
    ], base)
    expect(edits).toEqual([])
    expect(unmapped.map((c) => c.ref)).toEqual(["MAT 2:1", "MAT 3:1"])
  })

  it("produces edits planWriteBack applies to exactly the edited lines", async () => {
    const bytes = enc.encode(BOOK)
    const base = await deriveUnits(bytes)
    const { edits } = diffCellsAgainstUnits([
      { cellId: "b", ref: "MAT 1:2", value: "", valueHtml: "<p>Abraham <em>was</em> the father of Isaac.</p>" },
    ], base)
    const plan = await planWriteBack(bytes, edits)
    expect(plan.ok).toBe(true)
    expect(plan.applied.map((a) => a.unitId)).toEqual(["MAT 1:2"])
    expect(dec.decode(plan.bytes)).toBe(BOOK.replace("Abraham fathered Isaac.", "Abraham was the father of Isaac."))
  })

  it("bases every edit on the LAST-SEEN unit, so a file Paratext changed since is refused, not overwritten", async () => {
    const lastSeen = await deriveUnits(enc.encode(BOOK))
    const moved = enc.encode(BOOK.replace("Abraham fathered Isaac.", "Paratext changed this."))
    const { edits } = diffCellsAgainstUnits([{ cellId: "b", ref: "MAT 1:2", value: "Aquilla changed this." }], lastSeen)
    const plan = await planWriteBack(moved, edits)
    expect(plan.applied).toEqual([])
    expect(plan.conflicts.map((c) => c.reason)).toEqual(["base-mismatch"])
  })
})
