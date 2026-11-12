/**
 * AQU-2120 — the re-import target a hand-off panel is given.
 *
 * WHY each test matters:
 *   - The spreadsheet / JSON hand-offs used to drop the collision screen's
 *     answer entirely, so "Update existing" made a second file. The target is
 *     what carries that answer across the hand-off.
 *   - A panel may emit a different name than the file it was handed (one sheet
 *     of `data.xlsx` is written as `data.xlsx — Sheet1`). The name gate is what
 *     stops Sheet2's content landing in Sheet1's file.
 *   - The map must be keyed the way `emitParsedFile` looks it up, or the
 *     re-import silently falls back to creating a new file.
 */

import { describe, it, expect } from "vitest"
import { reimportFileIdsForResult, reimportTargetFor } from "./reimport-target"

describe("reimportTargetFor", () => {
  const existing = [
    { id: "file-csv", name: "pairs.csv" },
    { id: "file-sheet", name: "data.xlsx — Sheet1" },
  ]

  it("resolves the chosen file's id and its own name", () => {
    expect(reimportTargetFor("pairs.csv", new Map([["pairs.csv", "file-csv"]]), existing))
      .toEqual({ id: "file-csv", name: "pairs.csv" })
  })

  it("resolves a workbook hand-off to the sheet file's stored name", () => {
    expect(reimportTargetFor("data.xlsx", new Map([["data.xlsx", "file-sheet"]]), existing))
      .toEqual({ id: "file-sheet", name: "data.xlsx — Sheet1" })
  })

  it("normalizes the incoming name the way the collision screen keys it", () => {
    expect(reimportTargetFor("  Pairs.CSV ", new Map([["pairs.csv", "file-csv"]]), existing))
      .toEqual({ id: "file-csv", name: "pairs.csv" })
  })

  it("is undefined when the person chose skip or duplicate", () => {
    expect(reimportTargetFor("pairs.csv", new Map(), existing)).toBeUndefined()
    expect(reimportTargetFor("pairs.csv", undefined, existing)).toBeUndefined()
  })

  it("is undefined when the matched file is not in the listing we were given", () => {
    expect(reimportTargetFor("pairs.csv", new Map([["pairs.csv", "file-csv"]]), [])).toBeUndefined()
    expect(reimportTargetFor("pairs.csv", new Map([["pairs.csv", "file-csv"]]), undefined)).toBeUndefined()
  })
})

describe("reimportFileIdsForResult", () => {
  it("keys the id by the emitted result name, as emitParsedFile looks it up", () => {
    const map = reimportFileIdsForResult("data.xlsx — Sheet1", { id: "file-sheet", name: "data.xlsx — Sheet1" })
    expect(map?.get("data.xlsx — sheet1")).toBe("file-sheet")
  })

  it("updates in place when the emitted name is the target file's name", () => {
    expect(reimportFileIdsForResult("pairs.csv", { id: "file-csv", name: "pairs.csv" })?.get("pairs.csv"))
      .toBe("file-csv")
  })

  it("imports fresh when another sheet of the same workbook is picked", () => {
    expect(reimportFileIdsForResult("data.xlsx — Sheet2", { id: "file-sheet", name: "data.xlsx — Sheet1" }))
      .toBeUndefined()
  })

  it("is undefined with no target", () => {
    expect(reimportFileIdsForResult("pairs.csv", undefined)).toBeUndefined()
  })
})
