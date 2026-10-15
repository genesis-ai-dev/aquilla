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
  type MondayBoardGroup,
  WRITABLE_TYPES_BY_METRIC,
  type MondayBoardColumn,
  type MondayMetricKey,
} from "./types"

export interface ColumnSpec {
  title: string
  /** Monday `ColumnType` enum value passed to create_column. */
  type: "numbers" | "status" | "date" | "text" | "link"
  /** Column settings passed as create_column `defaults` (Monday's column settings schema). */
  defaults?: Record<string, unknown>
}

/**
 * Percentages show a "%" after the number. Monday's footer can only be set to
 * hidden by an app (sum/average is the user's choice in Monday), and a sum of
 * percentages across projects means nothing, so it is hidden.
 */
const PERCENT: Record<string, unknown> = {
  unit: { symbol: "custom", custom_unit: "%", direction: "right" },
  hide_footer: true,
}
/** A footer sum of "days since" across projects means nothing either. */
const NO_FOOTER: Record<string, unknown> = { hide_footer: true }

/**
 * The column Aquilla creates for each metric it can fill. `project_name` is
 * absent on purpose: it names the item, it is never a column.
 *
 * Status columns (Status, Schedule) get no preset labels: the push writes with
 * `create_labels_if_missing: true`, so their labels appear on the first push,
 * in Monday's own colours.
 */
export const COLUMN_SPEC_BY_METRIC: Partial<Record<MondayMetricKey, ColumnSpec>> = {
  completion_pct: { title: "Completion %", type: "numbers", defaults: PERCENT },
  validated_pct: { title: "Validated %", type: "numbers", defaults: PERCENT },
  audio_validated_pct: { title: "Audio validated %", type: "numbers", defaults: PERCENT },
  has_audio_pct: { title: "Has audio %", type: "numbers", defaults: PERCENT },
  filled_count: { title: "Filled cells", type: "numbers" },
  total_count: { title: "Total cells", type: "numbers" },
  validated_count: { title: "Validated cells", type: "numbers" },
  status_auto: { title: "Status", type: "status" },
  deadline: { title: "Deadline", type: "date" },
  project_link: { title: "Aquilla project", type: "link" },
  schedule_status: { title: "Schedule", type: "status" },
  books_done: { title: "Books done", type: "text" },
  next_target_date: { title: "Next target date", type: "date" },
  days_since_activity: { title: "Days since activity", type: "numbers", defaults: NO_FOOTER },
  project_manager: { title: "Project manager", type: "text" },
  languages: { title: "Languages", type: "text" },
  active_contributors_30d: { title: "Active contributors (30 days)", type: "numbers" },
  books_in_progress: { title: "Books in progress", type: "text" },
  recorded_minutes: { title: "Recorded minutes", type: "numbers" },
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
        `mutation { create_column(board_id: ${gqlString(boardId)}, title: ${gqlString(spec.title)}, column_type: ${spec.type}${
          spec.defaults ? `, defaults: ${gqlString(JSON.stringify(spec.defaults))}` : ""
        }) { id title type } }`,
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

// ── The "Aquilla projects" group ────────────────────────────────────────────

/** The group Aquilla puts its rows in, so they sit together instead of among the board's own rows. */
export const PROJECTS_GROUP_TITLE = "Aquilla projects"

/**
 * The group this link's new rows go in: the first of `preferredIds` still on
 * the board (the group this project or another project on the board already
 * uses, so a renamed group keeps working), else a group titled "Aquilla
 * projects", else a new one created at the top of the board.
 */
export async function ensureProjectsGroup(
  accessToken: string,
  boardId: string,
  groups: MondayBoardGroup[],
  preferredIds: string[],
): Promise<{ group: MondayBoardGroup; created: boolean }> {
  for (const id of preferredIds) {
    const kept = groups.find((g) => g.id === id)
    if (kept) return { group: kept, created: false }
  }
  const want = normalizeTitle(PROJECTS_GROUP_TITLE)
  const named = groups.find((g) => normalizeTitle(g.title) === want)
  if (named) return { group: named, created: false }
  const top = groups[0]
  const data = await mondayGraphQL<{ create_group: { id: string; title: string } | null }>(
    accessToken,
    `mutation { create_group(board_id: ${gqlString(boardId)}, group_name: ${gqlString(PROJECTS_GROUP_TITLE)}${
      top ? `, relative_to: ${gqlString(top.id)}, position_relative_method: before_at` : ""
    }) { id title } }`,
  )
  const made = data.create_group
  if (!made?.id) throw new MondayApiError("create_group returned no id", 200)
  return { group: { id: String(made.id), title: made.title ?? PROJECTS_GROUP_TITLE }, created: true }
}
