// Airtable integration — mapping config shapes (AQU-804).
//
// MIRROR of auth-worker/src/lib/airtable/types.ts; keep both copies in
// lockstep. An Airtable mapping is Monday's (src/lib/monday/types.ts) for a
// table: a "column" is a field (columnId = field id, columnType = field type)
// and an "item" is a record, so the shared settings pieces read it unchanged.

import { MONDAY_COLUMN_CATALOG, type MondayColumnMapping, type MondayMetricKey } from "@/lib/monday/types"
import type { ColumnProfile } from "@/lib/integrations/sync-ui"

/** One record for the project, one per file (an episode), or both in the table. */
export type AirtableRowGranularity = "project" | "file" | "project_and_files"

export interface AirtableMapping {
  version: 1
  /** The table (tbl…) the records live in; the link's base is its own field. */
  tableId: string
  itemGranularity: AirtableRowGranularity
  /** Default: '{projectName}', or '{projectName} — {fileName}' for a file's record. */
  itemNameTemplate?: string
  matchExisting?: { columnId: string } | { byName: true }
  columns: MondayColumnMapping[]
  /** AI rationale, shown in UI. */
  notes?: string
}

/** Computed and system field types nothing can write (the server rejects them too). */
export const AIRTABLE_READONLY_FIELD_TYPES: ReadonlySet<string> = new Set([
  "formula",
  "rollup",
  "count",
  "lookup",
  "multipleLookupValues",
  "autoNumber",
  "createdTime",
  "lastModifiedTime",
  "createdBy",
  "lastModifiedBy",
  "button",
  "externalSyncSource",
  "aiText",
])

const PERCENT_TYPES = ["percent", "number", "singleLineText"]
const NUMBER_TYPES = ["number", "singleLineText"]
const TEXT_TYPES = ["singleLineText", "multilineText", "richText"]
const DATE_TYPES = ["date", "singleLineText"]
const LABEL_TYPES = ["singleSelect", "singleLineText"]

/** Writable field types per metric — mirror of the server's table. */
export const AIRTABLE_WRITABLE_TYPES_BY_METRIC: Record<MondayMetricKey, readonly string[]> = {
  completion_pct: PERCENT_TYPES,
  validated_pct: PERCENT_TYPES,
  audio_validated_pct: PERCENT_TYPES,
  has_audio_pct: PERCENT_TYPES,
  filled_count: NUMBER_TYPES,
  total_count: NUMBER_TYPES,
  validated_count: NUMBER_TYPES,
  translators: TEXT_TYPES,
  last_activity: DATE_TYPES,
  status_auto: LABEL_TYPES,
  deadline: DATE_TYPES,
  project_link: ["url", "singleLineText", "multilineText"],
  schedule_status: LABEL_TYPES,
  books_done: TEXT_TYPES,
  next_target_date: DATE_TYPES,
  days_since_activity: NUMBER_TYPES,
  project_manager: TEXT_TYPES,
  languages: TEXT_TYPES,
  active_contributors_30d: NUMBER_TYPES,
  books_in_progress: TEXT_TYPES,
  recorded_minutes: NUMBER_TYPES,
  project_name: TEXT_TYPES,
  external_id: ["singleLineText", "multilineText"],
}

/** The Airtable type each new field gets (auth-worker lib/airtable/fields.ts). */
const FIELD_TYPE_BY_METRIC: Partial<Record<MondayMetricKey, string>> = {
  completion_pct: "percent",
  validated_pct: "percent",
  has_audio_pct: "percent",
  audio_validated_pct: "percent",
  status_auto: "singleSelect",
  deadline: "date",
  last_activity: "date",
  project_link: "url",
  schedule_status: "singleSelect",
  next_target_date: "date",
  days_since_activity: "number",
  active_contributors_30d: "number",
  recorded_minutes: "number",
  filled_count: "number",
  validated_count: "number",
  total_count: "number",
}

/**
 * Every field Aquilla can add to a table, in the picker's order: Monday's
 * column titles (the same names on both providers), Airtable's types.
 */
export const AIRTABLE_FIELD_CATALOG: Array<{ metric: MondayMetricKey; title: string; type: string }> =
  MONDAY_COLUMN_CATALOG.map(({ metric, title }) => ({
    metric,
    title,
    type: FIELD_TYPE_BY_METRIC[metric] ?? "singleLineText",
  }))

/** Airtable's field types for the shared progress-sync UI. */
export const AIRTABLE_COLUMN_PROFILE: ColumnProfile = {
  catalog: AIRTABLE_FIELD_CATALOG,
  writableTypesByMetric: AIRTABLE_WRITABLE_TYPES_BY_METRIC,
  readOnlyTypes: AIRTABLE_READONLY_FIELD_TYPES,
}
