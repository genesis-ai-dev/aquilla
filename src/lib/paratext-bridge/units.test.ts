import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { deriveUnits, utf16ToUtf8Offsets, UnitDeriveError } from "./units"
import { sha256Hex } from "./hash"

const enc = new TextEncoder()
const BOM = "﻿"

/** A Paratext-shaped book: BOM, CRLF, an empty verse, a heading inside a verse
 *  scope, a heading before verse 1, a footnote, a bridge, non-ASCII text. */
const CRLF_BOOK = [
  `${BOM}\\id MAT - Test Paratext Project 1`,
  "\\h Matthew",
  "\\toc1 The Gospel of Matthew",
  "\\mt1 Matthew",
  "\\c 1",
  "\\s1 Genealogy",
  "\\p",
  "\\v 1 The book of the genealogy of Jesus Christ, son of David.",
  "\\v 2",
  "\\v 3-4 Judah fathered Perez\\f + \\fr 1:3 \\ft Or \\fq Pharez\\f* and Zerah.",
  "\\s1 A heading inside verse 3-4's scope",
  "\\q1 Poetry line still in the verse",
  "\\c 2",
  "\\v 1 Jésus naquit à Bethléem — « ville de David ».",
  "",
].join("\r\n")

describe("deriveUnits — IDs follow the plan's grammar", () => {
  it("names verses, headings and intro material by reference, never content", async () => {
    const set = await deriveUnits(enc.encode(CRLF_BOOK))
    expect(set.book).toBe("MAT")
    expect(set.hasBom).toBe(true)
    expect(set.lineEnding).toBe("\r\n")
    expect(set.units.map((u) => u.id)).toEqual([
      "MAT 0:0/h#0",
      "MAT 0:0/toc1#0",
      "MAT 0:0/mt1#0",
      "MAT 1:0/s1#0",
      "MAT 1:1",
      "MAT 1:2",
      "MAT 1:3-4",
      "MAT 1:3-4/s1#0",
      "MAT 2:1",
    ])
  })

  it("keeps the trailing line break outside every span and reads text exactly", async () => {
    const set = await deriveUnits(enc.encode(CRLF_BOOK))
    const byId = new Map(set.units.map((u) => [u.id, u]))
    expect(byId.get("MAT 1:1")!.text).toBe("The book of the genealogy of Jesus Christ, son of David.")
    expect(byId.get("MAT 1:2")!.text).toBe("")
    expect(byId.get("MAT 1:3-4")!.text).toBe("Judah fathered Perez\\f + \\fr 1:3 \\ft Or \\fq Pharez\\f* and Zerah.")
    expect(byId.get("MAT 1:3-4/s1#0")!.text).toBe("A heading inside verse 3-4's scope")
    expect(byId.get("MAT 2:1")!.text).toBe("Jésus naquit à Bethléem — « ville de David ».")
    for (const u of set.units) expect(u.text.endsWith("\r") || u.text.endsWith("\n")).toBe(false)
  })

  it("spans are BYTE offsets whose bytes decode to the unit text", async () => {
    const bytes = enc.encode(CRLF_BOOK)
    const set = await deriveUnits(bytes)
    for (const u of set.units) {
      const slice = bytes.subarray(u.span.start, u.span.end)
      expect(new TextDecoder().decode(slice)).toBe(u.text)
      expect(await sha256Hex(slice)).toBe(u.rawHash)
    }
  })

  it("is deterministic: same bytes, same IDs and hashes", async () => {
    const a = await deriveUnits(enc.encode(CRLF_BOOK))
    const b = await deriveUnits(enc.encode(CRLF_BOOK))
    expect(a).toEqual(b)
  })

  it("textHash ignores whitespace and line-ending differences; rawHash does not", async () => {
    const lf = await deriveUnits(enc.encode(CRLF_BOOK.replace(/\r\n/g, "\n").replace("son of David.", "son  of David.")))
    const crlf = await deriveUnits(enc.encode(CRLF_BOOK))
    const a = lf.units.find((u) => u.id === "MAT 1:1")!
    const b = crlf.units.find((u) => u.id === "MAT 1:1")!
    expect(a.textHash).toBe(b.textHash)
    expect(a.rawHash).not.toBe(b.rawHash)
  })

  it("gives duplicate references distinct, deterministic IDs in file order", async () => {
    const set = await deriveUnits(enc.encode("\\id DEU\n\\c 5\n\\v 4 First.\n\\v 4 Second.\n\\v 4 Third.\n\\v 5 Next.\n"))
    expect(set.units.map((u) => [u.id, u.text])).toEqual([
      ["DEU 5:4", "First."], ["DEU 5:4@2", "Second."], ["DEU 5:4@3", "Third."], ["DEU 5:5", "Next."],
    ])
  })

  it("refuses non-UTF-8 bytes and files without \\id", async () => {
    await expect(deriveUnits(new Uint8Array([0x5c, 0x69, 0x64, 0x20, 0xff]))).rejects.toBeInstanceOf(UnitDeriveError)
    await expect(deriveUnits(enc.encode("\\c 1\n\\v 1 text\n"))).rejects.toMatchObject({ code: "no-id" })
  })
})

describe("utf16ToUtf8Offsets", () => {
  it("charges 1–4 bytes per code point and ends at the encoded length", () => {
    const s = "aé€😀z"
    const t = utf16ToUtf8Offsets(s)
    expect(Array.from(t)).toEqual([0, 1, 3, 6, 10, 10, 11])
    expect(t[s.length]).toBe(enc.encode(s).length)
  })
})

describe("golden: richly marked book (BOM, CRLF, intro, notes, poetry, lists)", () => {
  const raw = readFileSync(join(__dirname, "__fixtures__/MAT-rich.SFM"))

  it("locks the unit ID list", async () => {
    const set = await deriveUnits(new Uint8Array(raw))
    expect(set.book).toBe("MAT")
    expect(set.hasBom).toBe(true)
    expect(set.lineEnding).toBe("\r\n")
    // Snapshot the IDs: a parser change that renames units must be deliberate.
    expect(set.units.map((u) => u.id)).toMatchSnapshot()
  })

  it("every span decodes to its text and all spans are disjoint and ordered", async () => {
    const bytes = new Uint8Array(raw)
    const set = await deriveUnits(bytes)
    let last = 0
    for (const u of set.units) {
      expect(u.span.start).toBeGreaterThanOrEqual(last)
      expect(new TextDecoder().decode(bytes.subarray(u.span.start, u.span.end))).toBe(u.text)
      last = u.span.end
    }
  })
})
