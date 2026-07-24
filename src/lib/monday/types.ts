// Monday.com integration — mapping config shapes.
//
// MIRROR of auth-worker/src/lib/monday/types.ts per the shared contract
// (monday-integration-contract.md). The `config` JSONB on monday_board_links
// is a MondayMapping; keep both copies in lockstep.

export type MondayMetricKey =
  | "completion_pct" // filled/total across project (or file) as number 0-100, 1dp
  | "validated_pct" // cells meeting text validation threshold %
  | "audio_validated_pct" // cells meeting audio validation threshold %
  | "filled_count"
  | "total_count"
  | "validated_count"
  | "translators" // comma-joined display names of contributors (text col)
  | "last_activity" // date of last event (date col, UTC date-only)
  | "status_auto" // derived label: 'Not started' | 'In progress' | 'Complete'
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
  "filled_count",
  "total_count",
  "validated_count",
  "translators",
  "last_activity",
  "status_auto",
  "project_name",
  "external_id",
]

/** Human labels for each metric — the single source for all Monday UI surfaces. */
export const MONDAY_METRIC_LABELS: Record<MondayMetricKey, string> = {
  completion_pct: "Completion %",
  validated_pct: "Validated %",
  audio_validated_pct: "Audio validated %",
  filled_count: "Filled cells",
  total_count: "Total cells",
  validated_count: "Validated cells",
  translators: "Translators",
  last_activity: "Last activity",
  status_auto: "Status (auto)",
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
