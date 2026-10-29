// "Add the missing fields for me" — Monday's column creation (lib/monday/
// columns.ts, AQU-1770) for an Airtable table (AQU-804).
//
// Aquilla only writes records, so a table without progress fields gives the
// user nothing to map to. This creates a field for each metric the table
// lacks, with the same plain names Monday's columns get and the Airtable type
// each metric writes best, and reuses any field already there under that
// name. Needs the token's schema.bases:write scope; without it each field
// comes back in `failed` with Airtable's reason.

import { COLUMN_SPEC_BY_METRIC } from "../monday/columns"
import { createField, type AirtableClient } from "./client"
import {
  READ_ONLY_FIELD_TYPES,
  WRITABLE_FIELD_TYPES_BY_METRIC,
  type AirtableField,
  type AirtableMetricKey,
} from "./types"

export interface FieldSpec {
  name: string
  type: "percent" | "number" | "singleSelect" | "date" | "singleLineText" | "url"
  options?: Record<string, unknown>
}

const PERCENT = { type: "percent", options: { precision: 1 } } as const
const WHOLE = { type: "number", options: { precision: 0 } } as const
const DATE = { type: "date", options: { dateFormat: { name: "iso" } } } as const
const TEXT = { type: "singleLineText" } as const
const choices = (...names: string[]) => ({
  type: "singleSelect" as const,
  options: { choices: names.map((name) => ({ name })) },
})

/** Airtable type per metric. `project_name` is absent: it is the record's name, never a new field. */
const FIELD_TYPE_BY_METRIC: Partial<Record<AirtableMetricKey, Omit<FieldSpec, "name">>> = {
  completion_pct: PERCENT,
  validated_pct: PERCENT,
  audio_validated_pct: PERCENT,
  has_audio_pct: PERCENT,
  filled_count: WHOLE,
  total_count: WHOLE,
  validated_count: WHOLE,
  // Choices up front so the field has them before the first push; typecast
  // would add them anyway.
  status_auto: choices("Not started", "In progress", "Complete"),
  deadline: DATE,
  project_link: { type: "url" },
  schedule_status: choices("On track", "Due soon", "Behind plan", "Overdue"),
  books_done: TEXT,
  next_target_date: DATE,
  days_since_activity: WHOLE,
  project_manager: TEXT,
  languages: TEXT,
  active_contributors_30d: WHOLE,
  books_in_progress: TEXT,
  recorded_minutes: { type: "number", options: { precision: 1 } },
  last_activity: DATE,
  translators: TEXT,
  external_id: TEXT,
}

/** The field Aquilla creates for a metric: Monday's column title, Airtable's type. */
export function fieldSpecFor(metric: AirtableMetricKey): FieldSpec | null {
  const type = FIELD_TYPE_BY_METRIC[metric]
  const title = COLUMN_SPEC_BY_METRIC[metric]?.title
  return type && title ? { name: title, ...type } : null
}

export function isCreatableFieldMetric(metric: string): metric is AirtableMetricKey {
  return Object.prototype.hasOwnProperty.call(FIELD_TYPE_BY_METRIC, metric)
}

const normalizeName = (name: string | undefined): string => (name ?? "").toLowerCase().replace(/[^a-z0-9%]/g, "")

/** A field already in the table this metric can use: same name (case and spacing ignored), writable type. */
export function findExistingField(metric: AirtableMetricKey, fields: AirtableField[]): AirtableField | null {
  const spec = fieldSpecFor(metric)
  if (!spec) return null
  const want = normalizeName(spec.name)
  return (
    fields.find(
      (f) =>
        normalizeName(f.name) === want &&
        !READ_ONLY_FIELD_TYPES.has(f.type) &&
        WRITABLE_FIELD_TYPES_BY_METRIC[metric].includes(f.type),
    ) ?? null
  )
}

export interface AddedField {
  metric: AirtableMetricKey
  columnId: string
  columnType: string
  title: string
}

export interface AddFieldsResult {
  created: AddedField[]
  reused: AddedField[]
  failed: Array<{ metric: AirtableMetricKey; title: string; error: string }>
}

/**
 * Create the fields for `metrics` that the table doesn't already have. One at
 * a time, so a refusal still reports every field that did land.
 */
export async function addMissingFields(
  client: AirtableClient,
  baseId: string,
  tableId: string,
  metrics: AirtableMetricKey[],
  existing: AirtableField[],
): Promise<AddFieldsResult> {
  const result: AddFieldsResult = { created: [], reused: [], failed: [] }
  const fields = [...existing]
  for (const metric of [...new Set(metrics)]) {
    const spec = fieldSpecFor(metric)
    if (!spec) continue
    const found = findExistingField(metric, fields)
    if (found) {
      result.reused.push({ metric, columnId: found.id, columnType: found.type, title: found.name })
      continue
    }
    try {
      const made = await createField(client, baseId, tableId, spec)
      fields.push(made)
      result.created.push({ metric, columnId: made.id, columnType: made.type, title: made.name })
    } catch (err) {
      result.failed.push({ metric, title: spec.name, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}
