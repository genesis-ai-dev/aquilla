// Monday.com integration — mapping config shapes.
//
// MIRROR of auth-worker/src/lib/monday/types.ts per the shared contract
// (docs/MONDAY-INTEGRATION.md). The `config` JSONB on integration_links
// is a MondayMapping; keep both copies in lockstep.

export type MondayMetricKey =
  | "completion_pct" // filled/total across project (or file) as number 0-100, 1dp
  | "validated_pct" // cells meeting text validation threshold %
  | "audio_validated_pct" // cells meeting audio validation threshold %
  | "has_audio_pct" // cells with a recording (selected dub take) %, the dashboard's "Has audio"
  | "filled_count"
  | "total_count"
  | "validated_count"
  | "translators" // comma-joined display names of contributors (text col)
  | "last_activity" // date of last event (date col, UTC date-only)
  | "status_auto" // derived label: 'Not started' | 'In progress' | 'Complete'
  | "deadline" // the project's deadline (date col, 'YYYY-MM-DD'); empty when unset
  | "project_name" // item name source when creating items
  | "external_id" // aquilla entity id (text col; used for idempotent re-linking)

export interface MondayColumnMapping {
  /** Monday column id (stable across renames). */
  columnId: string
  /** Monday column type at config time. */
  columnType: string
  metric: MondayMetricKey
}

export interface MondayMapping {
  version: 1
  /** One board item for the project, or one per file. */
  itemGranularity: "project" | "file"
  /** Monday group for created items. */
  groupId?: string
  /** Default: '{projectName}' or '{projectName} — {fileName}'. */
  itemNameTemplate?: string
  /** How AI matched pre-existing items; else create. */
  matchExisting?: { columnId: string } | { byName: true }
  columns: MondayColumnMapping[]
  /** AI rationale, shown in UI. */
  notes?: string
}

/** Every metric key, in display order — drives the metric Select in the editor. */
export const MONDAY_METRIC_KEYS: MondayMetricKey[] = [
  "completion_pct",
  "validated_pct",
  "audio_validated_pct",
  "has_audio_pct",
  "filled_count",
  "total_count",
  "validated_count",
  "translators",
  "last_activity",
  "status_auto",
  "deadline",
  "project_name",
  "external_id",
]

/** Human labels for each metric — the single source for all Monday UI surfaces. */
export const MONDAY_METRIC_LABELS: Record<MondayMetricKey, string> = {
  completion_pct: "Completion %",
  validated_pct: "Validated %",
  audio_validated_pct: "Audio validated %",
  has_audio_pct: "Has audio %",
  filled_count: "Filled cells",
  total_count: "Total cells",
  validated_count: "Validated cells",
  translators: "Translators",
  last_activity: "Last activity",
  status_auto: "Status (auto)",
  deadline: "Deadline",
  project_name: "Project name",
  external_id: "External ID",
}

/**
 * Monday column types that can never be written to (server rejects them too —
 * see contract "Writable Monday column types per metric"). Used to filter the
 * column picker in the manual mapping editor.
 */
export const MONDAY_READONLY_COLUMN_TYPES = new Set([
  "formula",
  "mirror",
  "progress",
  "auto_number",
  "autonumber",
  "button",
])

/**
 * The numbers "Add the missing columns for me" offers to create, in board
 * order. Counts and the project name are left out: counts are optional extras
 * a user can still map by hand, and the project name is the item's own name.
 */
export const MONDAY_SUGGESTED_COLUMN_METRICS: MondayMetricKey[] = [
  "completion_pct",
  "validated_pct",
  "audio_validated_pct",
  "status_auto",
  "last_activity",
  "translators",
  "external_id",
]

/**
 * The title Aquilla gives a column it creates. Monday data, not UI copy: it
 * is the column's name on the customer's board, so it is never translated.
 * Mirrors COLUMN_SPEC_BY_METRIC in auth-worker/src/lib/monday/columns.ts.
 */
export const MONDAY_NEW_COLUMN_TITLES: Partial<Record<MondayMetricKey, string>> = {
  completion_pct: "Completion %",
  validated_pct: "Validated %",
  audio_validated_pct: "Audio validated %",
  status_auto: "Status",
  last_activity: "Last activity",
  translators: "Translators",
  external_id: "Aquilla ID",
}

/** Suggested numbers that no row maps to a column yet. */
export function missingColumnMetrics(rows: MondayColumnMapping[]): MondayMetricKey[] {
  const mapped = new Set(rows.filter((r) => r.columnId).map((r) => r.metric))
  return MONDAY_SUGGESTED_COLUMN_METRICS.filter((m) => !mapped.has(m))
}

/**
 * Map each added column to its number: fill a row that names the metric but
 * has no column yet, else append a row. A column already mapped is left alone.
 */
export function mergeAddedColumns(
  rows: MondayColumnMapping[],
  added: Array<{ metric: MondayMetricKey; columnId: string; columnType: string }>,
): MondayColumnMapping[] {
  const next = [...rows]
  for (const col of added) {
    if (next.some((r) => r.columnId === col.columnId)) continue
    if (next.some((r) => r.metric === col.metric && r.columnId)) continue
    const empty = next.findIndex((r) => r.metric === col.metric && !r.columnId)
    const row = { columnId: col.columnId, columnType: col.columnType, metric: col.metric }
    if (empty >= 0) next[empty] = row
    else next.push(row)
  }
  return next
}
