import { describe, it, expect } from "vitest"
import { mergeAddedColumns, missingColumnMetrics, type MondayColumnMapping } from "./types"

describe("missingColumnMetrics", () => {
  it("lists suggested numbers no row maps to a column, ignoring rows without one", () => {
    const rows: MondayColumnMapping[] = [
      { columnId: "a", columnType: "numbers", metric: "completion_pct" },
      { columnId: "", columnType: "numbers", metric: "validated_pct" },
      { columnId: "c", columnType: "numbers", metric: "filled_count" },
    ]
    expect(missingColumnMetrics(rows)).toEqual([
      "validated_pct",
      "audio_validated_pct",
      "status_auto",
      "last_activity",
      "translators",
      "external_id",
    ])
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
