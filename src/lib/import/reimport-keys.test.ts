/**
 * AQU-1365 review: the "Is this a translation?" check and its "Update
 * Jonah's source text" answer read an upload's books and re-import keys from
 * the REAL parse. A parsed USFM upload has no `bookCode`, so both have to come
 * from what the parse does carry.
 */
import { describe, expect, it } from "vitest"
import { parseTextFormat } from "@/lib/parsers/parse-text-formats"
import { parsedResultBooks, reimportKeysFor } from "./reimport-keys"

describe("parsedResultBooks", () => {
  it("reads a USFM upload's book off its lines, since the parse sets no bookCode", () => {
    const [result] = parseTextFormat({ fileType: "usfm", name: "RUT-tatar.usfm", text: "\\id RUT\n\\c 1\n\\v 1 Руфь бер\n" })
    expect(Object.keys(result)).not.toContain("bookCode")
    expect(parsedResultBooks("usfm", result)).toEqual(["RUT"])
  })

  it("prefers a stored book code", () => {
    expect(parsedResultBooks("ebible", { bookCode: "jon", strings: [] })).toEqual(["JON"])
  })

  it("never reads a book out of a non-scripture parse", () => {
    const strings = [{ id: "1", original: "x", translated: "", context: "Job 1", group: "" }] as never
    expect(parsedResultBooks("csv", { strings })).toEqual([])
    expect(parsedResultBooks("usfm", { strings })).toEqual(["JOB"])
  })
})

describe("reimportKeysFor", () => {
  it("tries the book code, then the name and original name, as emitParsedFile does", () => {
    expect(reimportKeysFor({ name: " JON-tatar.USFM ", bookCode: "jon", originalName: "Jonah.sfm" }))
      .toEqual(["JON", "jon-tatar.usfm", "jonah.sfm"])
    expect(reimportKeysFor({ name: "JON-source-v2.usfm" })).toEqual(["jon-source-v2.usfm"])
  })
})
