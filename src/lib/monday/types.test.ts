import { describe, it, expect } from "vitest"
import { mergeAddedColumns, metricOnBoard, type MondayColumnMapping } from "./types"

describe("metricOnBoard", () => {
  const rows: MondayColumnMapping[] = [
    { columnId: "a", columnType: "numbers", metric: "completion_pct" },
    { columnId: "", columnType: "numbers", metric: "validated_pct" },
  ]
  it("counts a mapped row, and a board column under Aquilla's title of a type the metric can write", () => {
    const board = [
      { id: "v", title: "validated  %", type: "numbers" },
      { id: "d", title: "Deadline", type: "formula" },
      { id: "x", title: "AQUILLA ID", type: "text" },
    ]
    expect(metricOnBoard("completion_pct", rows, board)).toBe(true)
    expect(metricOnBoard("validated_pct", rows, board)).toBe(true)
    expect(metricOnBoard("deadline", rows, board)).toBe(false)
    expect(metricOnBoard("external_id", rows, board)).toBe(true)
    expect(metricOnBoard("translators", rows, board)).toBe(false)
  })
  it("without the board's columns, only mapped rows count", () => {
    expect(metricOnBoard("validated_pct", rows, null)).toBe(false)
    expect(metricOnBoard("completion_pct", rows, null)).toBe(true)
  })
})

describe("mergeAddedColumns", () => {
  it("fills an empty row for the metric, appends the rest, and never maps a column twice", () => {
    const rows: MondayColumnMapping[] = [
      { columnId: "a", columnType: "numbers", metric: "completion_pct" },
      { columnId: "", columnType: "numbers", metric: "validated_pct" },
    ]
    expect(
      mergeAddedColumns(rows, [
        { metric: "validated_pct", columnId: "v", columnType: "numbers" },
        { metric: "external_id", columnId: "x", columnType: "text" },
        { metric: "completion_pct", columnId: "other", columnType: "numbers" },
        { metric: "translators", columnId: "a", columnType: "text" },
      ]),
    ).toEqual([
      { columnId: "a", columnType: "numbers", metric: "completion_pct" },
      { columnId: "v", columnType: "numbers", metric: "validated_pct" },
      { columnId: "x", columnType: "text", metric: "external_id" },
    ])
  })
})
