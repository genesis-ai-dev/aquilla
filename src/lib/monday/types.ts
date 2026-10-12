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
 * Every column Aquilla can create on a board, in the order the column picker
 * lists them. `title` and `type` mirror COLUMN_SPEC_BY_METRIC in
 * auth-worker/src/lib/monday/columns.ts. The title is Monday data, not UI copy
 * (it becomes the column's name on the customer's board), so it is never
 * translated; each entry's one-line description is
 * `projectSettings.monday.columnInfo.<metric>`. `project_name` is absent: it is
 * the item's own name, never a column.
 */
export const MONDAY_COLUMN_CATALOG: Array<{
  metric: MondayMetricKey
  title: string
  type: "numbers" | "status" | "date" | "text"
}> = [
  { metric: "completion_pct", title: "Completion %", type: "numbers" },
  { metric: "validated_pct", title: "Validated %", type: "numbers" },
  { metric: "has_audio_pct", title: "Has audio %", type: "numbers" },
  { metric: "audio_validated_pct", title: "Audio validated %", type: "numbers" },
  { metric: "status_auto", title: "Status", type: "status" },
  { metric: "deadline", title: "Deadline", type: "date" },
  { metric: "last_activity", title: "Last activity", type: "date" },
  { metric: "translators", title: "Translators", type: "text" },
  { metric: "filled_count", title: "Filled cells", type: "numbers" },
  { metric: "validated_count", title: "Validated cells", type: "numbers" },
  { metric: "total_count", title: "Total cells", type: "numbers" },
  { metric: "external_id", title: "Aquilla ID", type: "text" },
]

/** Writable Monday column types per metric — mirror of the server's table. */
const NUMERIC_TYPES = ["numbers", "text"]
const TEXT_TYPES = ["text", "long_text", "name"]
export const MONDAY_WRITABLE_TYPES_BY_METRIC: Record<MondayMetricKey, readonly string[]> = {
  completion_pct: NUMERIC_TYPES,
  validated_pct: NUMERIC_TYPES,
  audio_validated_pct: NUMERIC_TYPES,
  has_audio_pct: NUMERIC_TYPES,
  filled_count: NUMERIC_TYPES,
  total_count: NUMERIC_TYPES,
  validated_count: NUMERIC_TYPES,
  translators: TEXT_TYPES,
  last_activity: ["date", "text"],
  status_auto: ["status", "text"],
  deadline: ["date", "text"],
  project_name: TEXT_TYPES,
  external_id: TEXT_TYPES,
}

const normalizeColumnTitle = (title: string | undefined): string =>
  (title ?? "").toLowerCase().replace(/[^a-z0-9%]/g, "")

/**
 * Is this metric already on the board? Either a mapping row sends it to a
 * column, or the board has a column under Aquilla's title (case and spacing
 * ignored) of a type the metric can write — the same match the server uses to
 * reuse a column instead of creating a second one.
 */
export function metricOnBoard(
  metric: MondayMetricKey,
  rows: MondayColumnMapping[],
  boardColumns: Array<{ id: string; title: string; type: string }> | null | undefined,
): boolean {
  if (rows.some((r) => r.metric === metric && r.columnId)) return true
  const entry = MONDAY_COLUMN_CATALOG.find((c) => c.metric === metric)
  if (!entry || !boardColumns) return false
  const want = normalizeColumnTitle(entry.title)
  return boardColumns.some(
    (c) =>
      normalizeColumnTitle(c.title) === want &&
      !MONDAY_READONLY_COLUMN_TYPES.has(c.type) &&
      MONDAY_WRITABLE_TYPES_BY_METRIC[metric].includes(c.type),
  )
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
