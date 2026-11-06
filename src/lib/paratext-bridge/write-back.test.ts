import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { deriveUnits } from "./units"
import { planWriteBack, protectedMarkerCounts } from "./write-back"

const enc = new TextEncoder()
const dec = new TextDecoder("utf-8", { ignoreBOM: true })
const BOM = "﻿"

const BOOK = [
  `${BOM}\\id MAT - Test`,
  "\\c 1",
  "\\s1 Genealogy",
  "\\p",
  "\\v 1 The book of the genealogy.",
  "\\v 2",
  "\\v 3 Judah fathered Perez\\f + \\fr 1:3 \\ft Or \\fq Pharez\\f* and Zerah.",
  "\\v 4 Last verse.",
  "",
].join("\r\n")

async function edit(bytes: Uint8Array, id: string, text: string) {
  const set = await deriveUnits(bytes)
  const u = set.units.find((x) => x.id === id)!
  return { unitId: id, text, baseRawHash: u.rawHash }
}

describe("planWriteBack — only the intended bytes change", () => {
  it("splices one verse and leaves every other byte identical (BOM, CRLF, footnote)", async () => {
    const bytes = enc.encode(BOOK)
    const plan = await planWriteBack(bytes, [await edit(bytes, "MAT 1:1", "El libro de la genealogía.")])
    expect(plan.ok).toBe(true)
    expect(plan.proofFailures).toEqual([])
    expect(plan.applied.map((a) => a.unitId)).toEqual(["MAT 1:1"])
    const out = dec.decode(plan.bytes!)
    expect(out).toBe(BOOK.replace("The book of the genealogy.", "El libro de la genealogía."))
    expect(plan.bytes![0]).toBe(0xef) // BOM kept
    expect(out.includes("\r\n")).toBe(true)
  })

  it("applies several edits end-to-start so offsets stay valid, including an empty verse", async () => {
    const bytes = enc.encode(BOOK)
    const plan = await planWriteBack(bytes, [
      await edit(bytes, "MAT 1:1", "One."),
      await edit(bytes, "MAT 1:2", "Two."),
      await edit(bytes, "MAT 1:4", "Four."),
      await edit(bytes, "MAT 1:0/s1#0", "Genealogía"),
    ])
    expect(plan.ok).toBe(true)
    const out = dec.decode(plan.bytes!)
    expect(out).toBe(
      BOOK.replace("The book of the genealogy.", "One.")
        .replace("\\v 2\r\n", "\\v 2 Two.\r\n")
        .replace("Last verse.", "Four.")
        .replace("Genealogy", "Genealogía"),
    )
    // Re-deriving the result gives the same IDs and only those four rawHashes moved.
    const before = await deriveUnits(bytes)
    expect(plan.after!.units.map((u) => u.id)).toEqual(before.units.map((u) => u.id))
    const moved = plan.after!.units.filter((u, i) => u.rawHash !== before.units[i].rawHash).map((u) => u.id)
    expect(moved.sort()).toEqual(["MAT 1:0/s1#0", "MAT 1:1", "MAT 1:2", "MAT 1:4"])
  })

  it("normalises the edit's line breaks to the file's own", async () => {
    const bytes = enc.encode(BOOK)
    const plan = await planWriteBack(bytes, [await edit(bytes, "MAT 1:1", "Line one\n\\q1 line two")])
    expect(dec.decode(plan.bytes!)).toContain("Line one\r\n\\q1 line two\r\n\\v 2")
  })

  it("refuses an edit whose base hash no longer matches the file (someone else wrote)", async () => {
    const bytes = enc.encode(BOOK)
    const stale = await edit(bytes, "MAT 1:1", "Mine.")
    const theirs = enc.encode(BOOK.replace("The book of the genealogy.", "Theirs."))
    const plan = await planWriteBack(theirs, [stale])
    expect(plan.ok).toBe(false)
    expect(plan.bytes).toBeUndefined()
    expect(plan.conflicts).toMatchObject([{ unitId: "MAT 1:1", reason: "base-mismatch" }])
    expect(plan.conflicts[0].current?.text).toBe("Theirs.")
  })

  it("refuses an edit that drops a footnote unless the user allowed marker changes", async () => {
    const bytes = enc.encode(BOOK)
    const e = await edit(bytes, "MAT 1:3", "Judah fathered Perez and Zerah.")
    const refused = await planWriteBack(bytes, [e])
    expect(refused.conflicts).toMatchObject([{ unitId: "MAT 1:3", reason: "marker-integrity" }])
    const allowed = await planWriteBack(bytes, [e], { allowMarkerChanges: new Set(["MAT 1:3"]) })
    expect(allowed.ok).toBe(true)
    expect(dec.decode(allowed.bytes!)).toContain("\\v 3 Judah fathered Perez and Zerah.\r\n\\v 4")
  })

  it("lets a footnote move or be reworded as long as the markers survive", async () => {
    const bytes = enc.encode(BOOK)
    const plan = await planWriteBack(bytes, [await edit(bytes, "MAT 1:3", "Judá engendró a Fares\\f + \\fr 1:3 \\ft O \\fq Pérez\\f* y a Zara.")])
    expect(plan.ok).toBe(true)
  })

  it("writes nothing when the edit equals the file; a missing unit is a conflict", async () => {
    const bytes = enc.encode(BOOK)
    const same = await edit(bytes, "MAT 1:4", "Last verse.")
    const plan = await planWriteBack(bytes, [same, { unitId: "MAT 9:9", text: "x", baseRawHash: "0" }])
    expect(plan.bytes).toBeUndefined()
    expect(plan.applied).toEqual([])
    expect(plan.conflicts).toMatchObject([{ unitId: "MAT 9:9", reason: "unit-missing" }])
  })

  it("the proof catches an edit that would create a new unit (a \\v inside the text)", async () => {
    const bytes = enc.encode(BOOK)
    const plan = await planWriteBack(bytes, [await edit(bytes, "MAT 1:1", "One.\n\\v 1a sneaky split")])
    expect(plan.ok).toBe(false)
    expect(plan.bytes).toBeUndefined()
    expect(plan.proofFailures.join("\n")).toMatch(/unit count changed|appeared/)
  })

  it("records previous and new rawHash per applied unit for clobber detection", async () => {
    const bytes = enc.encode(BOOK)
    const before = await deriveUnits(bytes)
    const plan = await planWriteBack(bytes, [await edit(bytes, "MAT 1:4", "Four.")])
    const rec = plan.applied[0]
    expect(rec.previousRawHash).toBe(before.units.find((u) => u.id === "MAT 1:4")!.rawHash)
    expect(rec.newRawHash).toBe(plan.after!.units.find((u) => u.id === "MAT 1:4")!.rawHash)
    expect(rec.newRawHash).not.toBe(rec.previousRawHash)
  })
})

describe("round trip on a richly marked book", () => {
  it("editing every unit and writing the originals back restores the exact bytes", async () => {
    const original = new Uint8Array(readFileSync(join(__dirname, "__fixtures__/MAT-rich.SFM")))
    const set = await deriveUnits(original)
    const verses = set.units
    expect(verses.length).toBeGreaterThan(20)
    const forward = await planWriteBack(original, verses.map((u) => ({ unitId: u.id, text: `[${u.id}] ${u.text}`, baseRawHash: u.rawHash })))
    expect(forward.ok).toBe(true)
    const edited = forward.bytes!
    const editedSet = await deriveUnits(edited)
    const back = await planWriteBack(edited, verses.map((u) => ({
      unitId: u.id, text: u.text, baseRawHash: editedSet.units.find((x) => x.id === u.id)!.rawHash,
    })))
    expect(back.ok).toBe(true)
    expect(Buffer.from(back.bytes!).equals(Buffer.from(original))).toBe(true)
  })
})

describe("protectedMarkerCounts", () => {
  it("counts note/xref markers with their closers and ignores character styles", () => {
    const c = protectedMarkerCounts("a \\nd LORD\\nd* b\\f + \\fr 1:1 \\ft t\\f* \\x - \\xo 1:1 \\xt Gen 1\\x*")
    expect(Object.fromEntries(c)).toEqual({ "\\f": 1, "\\fr": 1, "\\ft": 1, "\\f*": 1, "\\x": 1, "\\xo": 1, "\\xt": 1, "\\x*": 1 })
  })
})
