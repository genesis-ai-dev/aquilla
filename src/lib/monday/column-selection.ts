// What the user ticked in "What should your board show?" (the Monday setup's
// step 2), and how that turns into board columns and a mapping.
//
// The picker is one list of everything Aquilla can fill. A ticked column that
// is already on the board is used as it is; a ticked column that isn't is
// created on the board, but only when the user confirms the last step. Aquilla
// ID is always included: it is how a later setup finds the items Aquilla made.

import {
  MONDAY_COLUMN_CATALOG,
  mergeAddedColumns,
  metricOnBoard,
  type MondayColumnMapping,
  type MondayMetricKey,
} from "./types"
import type { MondayAddColumnsResult, MondayBoardStructure } from "./api"

export const REQUIRED_METRIC: MondayMetricKey = "external_id"

/** Ticked for a new board unless the user changes it. */
export const RECOMMENDED_METRICS: readonly MondayMetricKey[] = [
  "completion_pct",
  "validated_pct",
  "audio_validated_pct",
  "status_auto",
  "last_activity",
  "deadline",
  "schedule_status",
]

export type MondayColumnGroupKey = "progress" | "schedule" | "team"

/** The three groups the picker shows; every catalog column but Aquilla ID is in one. */
export const MONDAY_COLUMN_GROUPS: Array<{ key: MondayColumnGroupKey; metrics: MondayMetricKey[] }> = [
  {
    key: "progress",
    metrics: [
      "completion_pct",
      "validated_pct",
      "audio_validated_pct",
      "has_audio_pct",
      "recorded_minutes",
      "filled_count",
      "validated_count",
      "total_count",
    ],
  },
  {
    key: "schedule",
    metrics: ["status_auto", "deadline", "schedule_status", "next_target_date", "books_done", "books_in_progress"],
  },
  {
    key: "team",
    metrics: [
      "last_activity",
      "days_since_activity",
      "project_manager",
      "translators",
      "active_contributors_30d",
      "languages",
      "project_link",
    ],
  },
]

type BoardColumns = MondayBoardStructure["columns"] | null | undefined

/**
 * The starting ticks: everything already on the board (mapped, or there under
 * Aquilla's title), plus the recommended set when `recommend` is on, plus
 * Aquilla ID.
 */
export function initialColumnSelection(
  rows: MondayColumnMapping[],
  boardColumns: BoardColumns,
  { recommend }: { recommend: boolean },
): Set<MondayMetricKey> {
  const picked = new Set<MondayMetricKey>([REQUIRED_METRIC])
  for (const { metric } of MONDAY_COLUMN_CATALOG) {
    if (metricOnBoard(metric, rows, boardColumns)) picked.add(metric)
  }
  if (recommend) for (const metric of RECOMMENDED_METRICS) picked.add(metric)
  return picked
}

/** How many ticked columns would be created, and how many are already there. */
export function columnSelectionCounts(
  selected: ReadonlySet<MondayMetricKey>,
  rows: MondayColumnMapping[],
  boardColumns: BoardColumns,
): { adds: number; uses: number } {
  let adds = 0
  let uses = 0
  for (const { metric } of MONDAY_COLUMN_CATALOG) {
    if (!selected.has(metric)) continue
    if (metricOnBoard(metric, rows, boardColumns)) uses++
    else adds++
  }
  return { adds, uses }
}

/** Ticked metrics that still need a board column (to create, or to reuse by title). */
export function metricsToAdd(
  selected: ReadonlySet<MondayMetricKey>,
  rows: MondayColumnMapping[],
): MondayMetricKey[] {
  return MONDAY_COLUMN_CATALOG.map((c) => c.metric).filter(
    (metric) => selected.has(metric) && !rows.some((r) => r.metric === metric && r.columnId),
  )
}

/**
 * The mapping to save: rows for ticked metrics (and anything outside the
 * catalog, like the item name), with the columns just added mapped in.
 * Unticking a column that was mapped stops filling it; the column itself
 * stays on the board.
 */
export function selectedRows(
  rows: MondayColumnMapping[],
  selected: ReadonlySet<MondayMetricKey>,
  added: MondayAddColumnsResult | null,
): MondayColumnMapping[] {
  const merged = added ? mergeAddedColumns(rows, [...added.reused, ...added.created]) : rows
  const inCatalog = new Set<MondayMetricKey>(MONDAY_COLUMN_CATALOG.map((c) => c.metric))
  return merged.filter((r) => r.columnId && (!inCatalog.has(r.metric) || selected.has(r.metric)))
}
