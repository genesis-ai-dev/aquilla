// Airtable integration — shared shapes (AQU-804, docs/AIRTABLE-INTEGRATION.md).
//
// The same shape as Monday's (lib/monday/types.ts), in Airtable's words: a
// Monday board is an Airtable table, a column is a field (columnId = field id,
// columnType = field type), an item is a record. The metrics are Monday's,
// computed by the same computeProjectMetrics, so a number means the same thing
// on both. AirtableMapping is the `config` JSONB on an Airtable
// integration_links row; the SPA mirrors these types in
// src/lib/airtable/types.ts — keep them in lockstep.

import {
  isAquillaIdTitle,
  METRIC_KEYS,
  type MondayColumnMapping,
  type MondayMetricKey,
} from "../monday/types"

/** Provider discriminator in the generic integration_* tables. */
export const PROVIDER = "airtable"

export type AirtableMetricKey = MondayMetricKey
/** One field ← one metric. `columnId` is the field id (fld…), stable across renames. */
export type AirtableFieldMapping = MondayColumnMapping

/**
 * Which records Aquilla keeps up to date: one for the project, one per file
 * (Come & See tracks episode by episode), or both in the same table.
 */
export type AirtableRowGranularity = "project" | "file" | "project_and_files"

export interface AirtableMapping {
  version: 1
  /** The table (tbl…) the records live in. The link's external_id is its base (app…). */
  tableId: string
  itemGranularity: AirtableRowGranularity
  /** Default: '{projectName}', or '{projectName} — {fileName}' for a file's record. */
  itemNameTemplate?: string
  /** How a push finds records Aquilla made before: the Aquilla ID field, or the record name. */
  matchExisting?: { columnId: string } | { byName: true }
  columns: AirtableFieldMapping[]
  /** AI rationale, shown in UI. */
  notes?: string
}

export interface AirtableField {
  id: string
  name: string
  type: string
}

/** A table as the metadata API describes it (fields trimmed to what we use). */
export interface AirtableTable {
  id: string
  name: string
  primaryFieldId: string
  fields: AirtableField[]
}

/** Cached table structure stored on integration_links.remote_state. */
export interface AirtableTableStructure {
  fetchedAt: string
  baseId: string
  baseName: string | null
  tableId: string
  tableName: string | null
  primaryFieldId: string | null
  fields: AirtableField[]
}

/** Provider identity blob stored in integration_connections.account. */
export interface AirtableAccountInfo {
  userId?: string | null
  email?: string | null
}

/**
 * Field types nothing can write through the API (computed or system fields).
 * Kept out of mappings unconditionally.
 */
export const READ_ONLY_FIELD_TYPES: ReadonlySet<string> = new Set([
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

const PERCENT_TYPES = ["percent", "number", "singleLineText"] as const
const NUMBER_TYPES = ["number", "singleLineText"] as const
const TEXT_TYPES = ["singleLineText", "multilineText", "richText"] as const
const DATE_TYPES = ["date", "singleLineText"] as const
const LABEL_TYPES = ["singleSelect", "singleLineText"] as const

/** Writable Airtable field types per metric (enforced server-side). */
export const WRITABLE_FIELD_TYPES_BY_METRIC: Record<AirtableMetricKey, readonly string[]> = {
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

export interface SanitizeResult {
  mapping: AirtableMapping | null
  warnings: string[]
}

const GRANULARITIES: readonly AirtableRowGranularity[] = ["project", "file", "project_and_files"]

function isMetricKey(v: unknown): v is AirtableMetricKey {
  return typeof v === "string" && (METRIC_KEYS as readonly string[]).includes(v)
}

/**
 * Validate + clamp an AirtableMapping (user-submitted or LLM-proposed) — the
 * rules of Monday's sanitizeMapping, against Airtable's field types.
 *
 * Drops (with a warning, never a hard failure) any field mapping that has an
 * unknown metric, targets a read-only field type or one the metric cannot
 * write, or (when `structure` is given) names a field the table doesn't have.
 * The field type is refreshed from the structure first.
 *
 * Two fields are mapped by the server whatever was proposed, when the table
 * has them: the Aquilla ID field (matched on, so setting up again reuses the
 * records), and the record name — the table's primary field, when it is a
 * text field nothing else writes — so a new record is never nameless.
 *
 * Returns mapping:null only when the envelope itself is unusable (not an
 * object, bad granularity, no table) — callers 400 on that.
 */
export function sanitizeAirtableMapping(
  raw: unknown,
  structure?: Pick<AirtableTableStructure, "tableId" | "primaryFieldId" | "fields"> | null,
): SanitizeResult {
  const warnings: string[] = []
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { mapping: null, warnings: ["config must be an object"] }
  }
  const obj = raw as Record<string, unknown>
  const granularity = obj.itemGranularity as AirtableRowGranularity
  if (!GRANULARITIES.includes(granularity)) {
    return {
      mapping: null,
      warnings: ["itemGranularity must be 'project', 'file' or 'project_and_files'"],
    }
  }
  const tableId = structure?.tableId || (typeof obj.tableId === "string" ? obj.tableId : "")
  if (!tableId) return { mapping: null, warnings: ["tableId is required"] }

  const byId = structure ? new Map(structure.fields.map((f) => [f.id, f])) : null

  const columns: AirtableFieldMapping[] = []
  const rawColumns = Array.isArray(obj.columns) ? obj.columns : []
  for (const entry of rawColumns) {
    if (entry == null || typeof entry !== "object") continue
    const col = entry as Record<string, unknown>
    const columnId = typeof col.columnId === "string" ? col.columnId : ""
    if (!columnId) {
      warnings.push("dropped a field mapping without a field id")
      continue
    }
    if (!isMetricKey(col.metric)) {
      warnings.push(`dropped field '${columnId}': unknown metric '${String(col.metric)}'`)
      continue
    }
    let columnType = typeof col.columnType === "string" ? col.columnType : ""
    if (byId) {
      const live = byId.get(columnId)
      if (!live) {
        warnings.push(`dropped field '${columnId}': not found in the table`)
        continue
      }
      columnType = live.type
    }
    if (READ_ONLY_FIELD_TYPES.has(columnType)) {
      warnings.push(`dropped field '${columnId}': Airtable doesn't let anything write to a '${columnType}' field`)
      continue
    }
    if (!WRITABLE_FIELD_TYPES_BY_METRIC[col.metric].includes(columnType)) {
      warnings.push(`dropped field '${columnId}': metric '${col.metric}' cannot write to a '${columnType}' field`)
      continue
    }
    if (columns.some((c) => c.columnId === columnId)) {
      warnings.push(`dropped duplicate mapping for field '${columnId}'`)
      continue
    }
    columns.push({ columnId, columnType, metric: col.metric })
  }

  let matchExisting: AirtableMapping["matchExisting"]
  const rawMatch = obj.matchExisting
  if (rawMatch && typeof rawMatch === "object") {
    const m = rawMatch as Record<string, unknown>
    if (typeof m.columnId === "string" && m.columnId) matchExisting = { columnId: m.columnId }
    else if (m.byName === true) matchExisting = { byName: true }
  }

  // The Aquilla ID field identifies the records Aquilla made, so whenever the
  // table has one it is mapped and matched on (a push upserts on it).
  let idColumn = columns.find((c) => c.metric === "external_id")
  if (!idColumn && byId) {
    const named = [...byId.values()].find(
      (f) =>
        isAquillaIdTitle(f.name) &&
        WRITABLE_FIELD_TYPES_BY_METRIC.external_id.includes(f.type) &&
        !columns.some((m) => m.columnId === f.id),
    )
    if (named) {
      idColumn = { columnId: named.id, columnType: named.type, metric: "external_id" }
      columns.push(idColumn)
    }
  }
  if (idColumn) matchExisting = { columnId: idColumn.columnId }
  else if (matchExisting && "columnId" in matchExisting) matchExisting = undefined

  // A record's name is its primary field. Fill it with the project (or file)
  // name unless something else already writes it.
  const primary = structure?.primaryFieldId ? byId?.get(structure.primaryFieldId) : undefined
  if (
    primary &&
    !columns.some((c) => c.metric === "project_name" || c.columnId === primary.id) &&
    WRITABLE_FIELD_TYPES_BY_METRIC.project_name.includes(primary.type)
  ) {
    columns.push({ columnId: primary.id, columnType: primary.type, metric: "project_name" })
  }

  return {
    mapping: {
      version: 1,
      tableId,
      itemGranularity: granularity,
      ...(typeof obj.itemNameTemplate === "string" && obj.itemNameTemplate
        ? { itemNameTemplate: obj.itemNameTemplate }
        : {}),
      ...(matchExisting && { matchExisting }),
      columns,
      ...(typeof obj.notes === "string" && obj.notes ? { notes: obj.notes } : {}),
    },
    warnings,
  }
}
