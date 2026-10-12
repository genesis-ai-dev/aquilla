import { describe, expect, it } from "vitest"
import type { ColumnMapping } from "@/lib/parsers/spreadsheet"
import { targetSheetRows } from "./target-sheet-rows"

const mapping = (overrides: Partial<ColumnMapping>): ColumnMapping => ({
  sourceCol: null,
  targetCol: null,
  labelCol: null,
  castCol: null,
  startCol: null,
  endCol: null,
  ...overrides,
})

describe("targetSheetRows", () => {
  it("reads the translation, reference and source, keeping every row's place", () => {
    const { rows, timed } = targetSheetRows(
      [["GEN 1:1", "In the beginning", " Uno "], ["", "", ""]],
      mapping({ labelCol: 0, sourceCol: 1, targetCol: 2 }),
    )
    expect(timed).toBe(false)
    expect(rows).toEqual([
      { ref: "GEN 1:1", text: "Uno", source: "In the beginning" },
      { ref: undefined, text: "", source: "" },
    ])
  })

  // AQU-1375: a subtitle spreadsheet's in and out times put it through the
  // timing matcher, read the way the source import reads them.
  it("reads start and end timestamps however a subtitle sheet writes them, labelled as cues", () => {
    const { rows, timed } = targetSheetRows(
      [
        ["00:00:01.500", "00:00:03.000", "Uno"],
        ["00:00:04,250", "00:00:05,000", "Dos"],
        ["6", "7.5", "Tres"],
        ["01:08.2", "01:09", "Cuatro"],
      ],
      mapping({ startCol: 0, endCol: 1, targetCol: 2 }),
    )
    expect(timed).toBe(true)
    expect(rows.map((r) => [r.startMs, r.endMs, r.ref])).toEqual([
      [1500, 3000, "00:00:01.500 --> 00:00:03.000"],
      [4250, 5000, "00:00:04.250 --> 00:00:05.000"],
      [6000, 7500, "00:00:06.000 --> 00:00:07.500"],
      [68200, 69000, "00:01:08.200 --> 00:01:09.000"],
    ])
  })

  it("leaves a row untimed when either timestamp is blank or unreadable, and keeps a row's own reference as its label", () => {
    const { rows } = targetSheetRows(
      [["", "00:00:02.000", "Uno", "1"], ["soon", "later", "Dos", "2"], ["00:00:05.000", "00:00:06.000", "Tres", "3"]],
      mapping({ startCol: 0, endCol: 1, targetCol: 2, labelCol: 3 }),
    )
    expect(rows).toEqual([
      { ref: "1", text: "Uno" },
      { ref: "2", text: "Dos" },
      { ref: "3", text: "Tres", startMs: 5000, endMs: 6000 },
    ])
  })

  it("is untimed unless both columns are mapped", () => {
    const { rows, timed } = targetSheetRows([["00:00:01.000", "Uno"]], mapping({ startCol: 0, targetCol: 1 }))
    expect(timed).toBe(false)
    expect(rows).toEqual([{ ref: undefined, text: "Uno" }])
  })
})
