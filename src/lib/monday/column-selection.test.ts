import { describe, expect, it } from "vitest"
import {
  MONDAY_COLUMN_GROUPS,
  RECOMMENDED_METRICS,
  REQUIRED_METRIC,
  columnSelectionCounts,
  initialColumnSelection,
  metricsToAdd,
  selectedRows,
} from "./column-selection"
import { MONDAY_COLUMN_CATALOG, type MondayColumnMapping } from "./types"

const mapped: MondayColumnMapping[] = [{ columnId: "n1", columnType: "numbers", metric: "completion_pct" }]
const board = [
  { id: "n1", title: "Progress", type: "numbers" },
  { id: "t1", title: "Translators", type: "text" },
]

describe("column selection", () => {
  it("groups cover every column Aquilla can fill except the always-included Aquilla ID", () => {
    const grouped = MONDAY_COLUMN_GROUPS.flatMap((g) => g.metrics)
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(new Set([...grouped, REQUIRED_METRIC])).toEqual(new Set(MONDAY_COLUMN_CATALOG.map((c) => c.metric)))
  })

  it("starts with what's on the board, Aquilla ID, and (for a new setup) the recommended set", () => {
    const fresh = initialColumnSelection(mapped, board, { recommend: true })
    for (const m of RECOMMENDED_METRICS) expect(fresh.has(m)).toBe(true)
    expect(fresh.has("translators")).toBe(true) // there under Aquilla's title
    expect(fresh.has(REQUIRED_METRIC)).toBe(true)
    expect(fresh.has("books_done")).toBe(false)

    const later = initialColumnSelection(mapped, board, { recommend: false })
    expect([...later].sort()).toEqual(["completion_pct", "external_id", "translators"])
  })

  it("counts new columns and ones already there", () => {
    const picked = new Set(["completion_pct", "translators", "deadline", REQUIRED_METRIC] as const)
    expect(columnSelectionCounts(picked, mapped, board)).toEqual({ adds: 2, uses: 2 })
  })

  it("asks the server only for ticked columns that aren't mapped yet", () => {
    const picked = new Set(["completion_pct", "translators", "deadline", REQUIRED_METRIC] as const)
    expect(metricsToAdd(picked, mapped)).toEqual(["deadline", "translators", "external_id"])
  })

  it("saves ticked rows plus what was added, and stops filling unticked ones", () => {
    const rows: MondayColumnMapping[] = [
      ...mapped,
      { columnId: "s1", columnType: "status", metric: "status_auto" },
      { columnId: "name", columnType: "name", metric: "project_name" },
    ]
    const out = selectedRows(rows, new Set(["completion_pct", "deadline", REQUIRED_METRIC]), {
      created: [{ metric: "deadline", columnId: "d1", columnType: "date", title: "Deadline" }],
      reused: [{ metric: "external_id", columnId: "x1", columnType: "text", title: "Aquilla ID" }],
      failed: [],
      structure: { columns: [], groups: [] },
    })
    expect(out).toEqual([
      { columnId: "n1", columnType: "numbers", metric: "completion_pct" },
      { columnId: "name", columnType: "name", metric: "project_name" },
      { columnId: "x1", columnType: "text", metric: "external_id" },
      { columnId: "d1", columnType: "date", metric: "deadline" },
    ])
  })
})
