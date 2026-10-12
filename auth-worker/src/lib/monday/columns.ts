// "Add the missing columns for me" (AQU-1770).
//
// Aquilla only ever wrote ITEMS, so a board without number columns gave the
// user nothing to map to: they had to leave for Monday, add the columns by
// hand, and come back. This creates the columns a project's progress needs,
// with plain titles and the column type each metric writes best, and reuses
// any column that is already there under that title.

import { MondayApiError, gqlString, mondayGraphQL } from "./client"
import {
  READ_ONLY_COLUMN_TYPES,
  WRITABLE_TYPES_BY_METRIC,
  type MondayBoardColumn,
  type MondayMetricKey,
} from "./types"

export interface ColumnSpec {
  title: string
  /** Monday `ColumnType` enum value passed to create_column. */
  type: "numbers" | "status" | "date" | "text"
}

/**
 * The column Aquilla creates for each metric it can fill. `project_name` is
 * absent on purpose: it names the item, it is never a column.
 *
 * Status gets no preset labels: the push writes with
 * `create_labels_if_missing: true`, so "Not started", "In progress" and
 * "Complete" appear on the first push, in Monday's own colours.
 */
export const COLUMN_SPEC_BY_METRIC: Partial<Record<MondayMetricKey, ColumnSpec>> = {
  completion_pct: { title: "Completion %", type: "numbers" },
  validated_pct: { title: "Validated %", type: "numbers" },
  audio_validated_pct: { title: "Audio validated %", type: "numbers" },
  filled_count: { title: "Filled cells", type: "numbers" },
  total_count: { title: "Total cells", type: "numbers" },
  validated_count: { title: "Validated cells", type: "numbers" },
  status_auto: { title: "Status", type: "status" },
  last_activity: { title: "Last activity", type: "date" },
  translators: { title: "Translators", type: "text" },
  external_id: { title: "Aquilla ID", type: "text" },
}

export function isCreatableMetric(metric: string): metric is MondayMetricKey {
  return Object.prototype.hasOwnProperty.call(COLUMN_SPEC_BY_METRIC, metric)
}

const normalizeTitle = (title: string | undefined): string =>
  (title ?? "").toLowerCase().replace(/[^a-z0-9%]/g, "")

/**
 * A column already on the board that this metric can use: same title (case
 * and spacing ignored) and a type the metric can write. Never a read-only one.
 */
export function findExistingColumn(
  metric: MondayMetricKey,
  columns: MondayBoardColumn[],
): MondayBoardColumn | null {
  const spec = COLUMN_SPEC_BY_METRIC[metric]
  if (!spec) return null
  const want = normalizeTitle(spec.title)
  return (
    columns.find(
      (c) =>
        normalizeTitle(c.title) === want &&
        !READ_ONLY_COLUMN_TYPES.has(c.type) &&
        WRITABLE_TYPES_BY_METRIC[metric].includes(c.type),
    ) ?? null
  )
}

export interface AddedColumn {
  metric: MondayMetricKey
  columnId: string
  columnType: string
  title: string
}

export interface AddColumnsResult {
  /** Columns Aquilla created just now. */
  created: AddedColumn[]
  /** Metrics that already had a matching column; nothing was created for them. */
  reused: AddedColumn[]
  /** Metrics whose column could not be created, with Monday's reason. */
  failed: Array<{ metric: MondayMetricKey; title: string; error: string }>
}

/**
 * Create the columns for `metrics` that the board doesn't already have.
 * Sequential on purpose: Monday's complexity budget is small, and a partial
 * failure must still report every column that did land.
 */
export async function addMissingColumns(
  accessToken: string,
  boardId: string,
  metrics: MondayMetricKey[],
  existing: MondayBoardColumn[],
): Promise<AddColumnsResult> {
  const result: AddColumnsResult = { created: [], reused: [], failed: [] }
  const columns = [...existing]
  for (const metric of [...new Set(metrics)]) {
    const spec = COLUMN_SPEC_BY_METRIC[metric]
    if (!spec) continue
    const found = findExistingColumn(metric, columns)
    if (found) {
      result.reused.push({ metric, columnId: found.id, columnType: found.type, title: found.title })
      continue
    }
    try {
      const data = await mondayGraphQL<{
        create_column: { id: string; title: string; type: string } | null
      }>(
        accessToken,
        `mutation { create_column(board_id: ${gqlString(boardId)}, title: ${gqlString(spec.title)}, column_type: ${spec.type}) { id title type } }`,
      )
      const made = data.create_column
      if (!made?.id) throw new MondayApiError("create_column returned no id", 200)
      const column = { id: String(made.id), title: made.title ?? spec.title, type: made.type ?? spec.type }
      columns.push(column)
      result.created.push({ metric, columnId: column.id, columnType: column.type, title: column.title })
    } catch (err) {
      result.failed.push({
        metric,
        title: spec.title,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}
