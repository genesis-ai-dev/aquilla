// What a push writes into each mapped Monday column — shared by the board's
// own rows (push.ts) and the files' subitems (subitems.ts).

import type { MondayColumnMapping, MondayMetricKey } from "./types"
import type { MondayEntityMetrics } from "./metrics"

export interface PushEntity {
  kind: "project" | "file"
  id: string
  itemName: string
  metrics: MondayEntityMetrics
}

/** Format one metric as the Monday column_values JSON value for its column type. */
function columnValueFor(
  metric: MondayMetricKey,
  columnType: string,
  entity: PushEntity,
): unknown {
  const m = entity.metrics
  switch (metric) {
    case "completion_pct":
    case "validated_pct":
    case "audio_validated_pct":
    case "has_audio_pct":
    case "active_contributors_30d":
    case "recorded_minutes":
    case "filled_count":
    case "total_count":
    case "validated_count":
      // numbers and text columns both take the stringified value.
      return String(m[metric])
    case "translators":
      return m.translators
    case "last_activity":
      return columnType === "date" ? { date: m.last_activity } : m.last_activity
    case "status_auto":
      return columnType === "status" ? { label: m.status_auto } : m.status_auto
    case "deadline":
      // No deadline clears the cell: Monday treats an empty string as "clear"
      // for every column type, a date column included.
      if (!m.deadline) return ""
      return columnType === "date" ? { date: m.deadline } : m.deadline
    case "next_target_date":
      if (!m.next_target_date) return ""
      return columnType === "date" ? { date: m.next_target_date } : m.next_target_date
    case "days_since_activity":
      return m.days_since_activity == null ? "" : String(m.days_since_activity)
    case "project_link":
      return columnType === "link" ? { url: m.project_link, text: "Open in Aquilla" } : m.project_link
    case "schedule_status":
      return columnType === "status" ? { label: m.schedule_status } : m.schedule_status
    case "books_done":
    case "project_manager":
    case "languages":
    case "books_in_progress":
      return m[metric]
    case "project_name":
      return entity.itemName
    case "external_id":
      return entity.id
  }
}

export function buildColumnValues(
  columns: readonly MondayColumnMapping[],
  entity: PushEntity,
  excludedColumnIds: ReadonlySet<string>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const col of columns) {
    if (excludedColumnIds.has(col.columnId)) continue
    values[col.columnId] = columnValueFor(col.metric, col.columnType, entity)
  }
  return values
}

/** Extract the failing column id from a Monday column error message, if present. */
export function failingColumnId(message: string, columns: readonly MondayColumnMapping[]): string | null {
  if (!/column/i.test(message)) return null
  for (const col of columns) {
    if (message.includes(col.columnId)) return col.columnId
  }
  return null
}
