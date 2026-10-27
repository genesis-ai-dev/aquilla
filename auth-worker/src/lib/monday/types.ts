// Monday.com integration — shared shapes (contract v1, docs/MONDAY-INTEGRATION.md).
//
// MondayMapping is the `config` JSONB on integration_links. The SPA mirrors
// these types in src/lib/monday/types.ts — keep them in lockstep.

import { canonicalItemNameTemplate } from "../integrations/item-name"

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
  | "project_link" // link to the project in Aquilla (link col; a file row opens that file)
  | "schedule_status" // 'On track' | 'Due soon' | 'Overdue' | 'Behind plan' (status col), the org dashboard's flags
  | "books_done" // '12 of 27': plan units marked Done of all units (text col)
  | "next_target_date" // nearest upcoming plan target date (date col); empty when none
  | "days_since_activity" // whole days since the last activity (number col)
  | "project_manager" // the project manager's display name (text col)
  | "languages" // active target language names, comma-joined (text col)
  | "active_contributors_30d" // distinct people active in the last 30 days (number col)
  | "books_in_progress" // units started and not marked Done, comma-joined (text col)
  | "recorded_minutes" // minutes of selected dub audio (number col)
  | "project_name" // item name source when creating items
  | "external_id" // aquilla entity id (text col; used for idempotent re-linking)

export interface MondayColumnMapping {
  columnId: string // Monday column id (stable across renames)
  columnType: string // Monday column type at config time
  metric: MondayMetricKey
}

export interface MondayMapping {
  version: 1
  itemGranularity: "project" | "file" // one board item for the project, or one per file
  groupId?: string // Monday group for created items
  itemNameTemplate?: string // default: '{projectName}' or '{projectName} — {fileName}'
  matchExisting?: { columnId: string } | { byName: true } // how to match pre-existing items; else create
  columns: MondayColumnMapping[]
  notes?: string // AI rationale, shown in UI
  fileSubitems?: MondayFileSubitems // each file as a subitem of the project's item ('project' only)
}

/**
 * Files as subitems of the project's item (lib/monday/subitems.ts). Present
 * means on. Monday keeps every board's subitems on a board of their own, with
 * its own columns; the push finds that board and its columns (adding the ones
 * the project's row has and a file can differ in) and keeps them here.
 * `boardId` is absent until the push has resolved them.
 */
export interface MondayFileSubitems {
  boardId?: string
  columns: MondayColumnMapping[]
}

/**
 * The metrics a file's subitem can show: the ones a file has its own value
 * for. The rest (deadline, languages, people, activity) are the project's,
 * already on the row above.
 */
export const SUBITEM_METRICS: readonly MondayMetricKey[] = [
  "completion_pct",
  "validated_pct",
  "audio_validated_pct",
  "has_audio_pct",
  "filled_count",
  "total_count",
  "validated_count",
  "status_auto",
  "project_link",
  "books_done",
  "next_target_date",
  "books_in_progress",
  "external_id",
]

export interface MondayBoardColumn {
  id: string
  title: string
  type: string
  settings_str?: string
}

export interface MondayBoardGroup {
  id: string
  title: string
}

/** Cached board structure stored on integration_links.remote_state. */
export interface MondayBoardStructure {
  url?: string | null
  name?: string | null
  fetchedAt: string
  columns: MondayBoardColumn[]
  groups: MondayBoardGroup[]
}

/** Provider discriminator in the generic integration_* tables. Monday is the
 *  first of several integrations — every query must filter on it. */
export const PROVIDER = "monday"

/** Provider identity blob stored in integration_connections.account. */
export interface IntegrationAccountInfo {
  accountId?: string | null
  accountSlug?: string | null
  userId?: string | null
  userName?: string | null
}

/** Row shape of `integration_connections` (provider-generic). */
export interface IntegrationConnectionRow {
  id: string
  org_id: string
  provider: string
  /** JSONB — IntegrationAccountInfo for Monday; use parseJsonColumn. */
  account: unknown
  access_token_enc: string
  /** OAuth 2.1 rotating refresh token (encrypted); null for legacy non-expiring tokens. */
  refresh_token_enc: string | null
  /** From the access-token JWT exp claim; null = non-expiring (legacy flow). */
  access_token_expires_at: string | null
  /** Set when a refresh fails (revoked / max lifetime); cleared on re-auth. */
  needs_reauth: boolean
  scopes: string | null
  /**
   * AQU-1775: the deployment that made the row (`ENVIRONMENT` at OAuth time —
   * 'production', 'development', 'local', …). NULL predates migration 0175 and
   * is usable by production only; see lib/monday/tokens.ts foreignConnectionError.
   */
  environment: string | null
  created_by: string
  created_at: string
  updated_at: string
}

/** Row shape of `integration_links` (provider-generic). For Monday:
 *  external_id = board id, remote_state = cached board structure. JSONB
 *  columns come back parsed or as strings depending on driver — use
 *  parseJsonColumn. */
export interface IntegrationLinkRow {
  id: string
  project_id: string
  provider: string
  connection_id: string
  external_id: string
  external_name: string | null
  config: unknown
  enabled: boolean
  webhook_ids: unknown
  remote_state: unknown
  remote_state_stale: boolean
  dirty_at: string | null
  last_pushed_at: string | null
  last_push_status: string | null
  last_push_error: string | null
  /** Consecutive failed push attempts; 0 after a success (AQU-1828). */
  push_attempts: number
  /** Earliest the cron flush may retry this link; null = no backoff pending. */
  next_retry_at: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export const METRIC_KEYS: readonly MondayMetricKey[] = [
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
  "project_link",
  "schedule_status",
  "books_done",
  "next_target_date",
  "days_since_activity",
  "project_manager",
  "languages",
  "active_contributors_30d",
  "books_in_progress",
  "recorded_minutes",
  "project_name",
  "external_id",
]

/** Monday column types the API can never write — reject in configs unconditionally. */
export const READ_ONLY_COLUMN_TYPES: ReadonlySet<string> = new Set([
  "formula",
  "mirror",
  "progress",
  "auto_number",
  "creation_log",
  "last_updated",
  "item_id",
  "button",
  "time_tracking",
  "vote",
  "integration",
])

const NUMERIC_TYPES = ["numbers", "text"] as const
const TEXT_TYPES = ["text", "long_text", "name"] as const

/** Writable Monday column types per metric (contract: enforce server-side). */
export const WRITABLE_TYPES_BY_METRIC: Record<MondayMetricKey, readonly string[]> = {
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
  project_link: ["link", "text"],
  schedule_status: ["status", "text"],
  books_done: TEXT_TYPES,
  next_target_date: ["date", "text"],
  days_since_activity: NUMERIC_TYPES,
  project_manager: TEXT_TYPES,
  languages: TEXT_TYPES,
  active_contributors_30d: NUMERIC_TYPES,
  books_in_progress: TEXT_TYPES,
  recorded_minutes: NUMERIC_TYPES,
  project_name: TEXT_TYPES,
  external_id: TEXT_TYPES,
}

/** Parse a JSONB column that may arrive pre-parsed (postgres.js) or as a string (defensive). */
export function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }
  return raw as T
}

/** "Aquilla ID", "Aquilla id", "aquilla_id", "AquillaID" … (Airtable field names too.) */
export function isAquillaIdTitle(title: string | undefined): boolean {
  return (title ?? "").toLowerCase().replace(/[^a-z]/g, "") === "aquillaid"
}

export interface SanitizeResult {
  mapping: MondayMapping | null
  warnings: string[]
}

function isMetricKey(v: unknown): v is MondayMetricKey {
  return typeof v === "string" && (METRIC_KEYS as readonly string[]).includes(v)
}

/**
 * Validate + clamp a MondayMapping (user-submitted or LLM-proposed).
 *
 * Drops (with a warning, never a hard failure) any column mapping that:
 *   - has an unknown metric key,
 *   - targets a read-only Monday column type,
 *   - targets a column type the metric cannot write,
 *   - (when `structure` is provided) references a columnId absent from the
 *     live board — the columnType is refreshed from the structure first, so a
 *     stale-but-still-valid config survives a type check against reality.
 *
 * Returns mapping:null only when the envelope itself is unusable (not an
 * object / bad granularity) — callers 400 on that.
 */
export function sanitizeMapping(
  raw: unknown,
  structure?: Pick<MondayBoardStructure, "columns" | "groups"> | null,
): SanitizeResult {
  const warnings: string[] = []
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { mapping: null, warnings: ["config must be an object"] }
  }
  const obj = raw as Record<string, unknown>
  const granularity = obj.itemGranularity
  if (granularity !== "project" && granularity !== "file") {
    return { mapping: null, warnings: ["itemGranularity must be 'project' or 'file'"] }
  }

  const byId = structure
    ? new Map(structure.columns.map((c) => [c.id, c]))
    : null

  const columns = sanitizeColumns(obj.columns, byId, warnings)

  let groupId = typeof obj.groupId === "string" && obj.groupId ? obj.groupId : undefined
  if (groupId && structure && !structure.groups.some((g) => g.id === groupId)) {
    warnings.push(`dropped groupId '${groupId}': not found on the board`)
    groupId = undefined
  }

  let matchExisting: MondayMapping["matchExisting"]
  const rawMatch = obj.matchExisting
  if (rawMatch && typeof rawMatch === "object") {
    const m = rawMatch as Record<string, unknown>
    if (typeof m.columnId === "string" && m.columnId) {
      matchExisting = { columnId: m.columnId }
    } else if (m.byName === true) {
      matchExisting = { byName: true }
    }
  }

  // Re-linking a board Aquilla has written to before must reuse its items, not
  // add a second copy of each. The Aquilla ID column is what identifies them,
  // so whenever the board has one it is mapped and matched on, whatever the
  // AI or the user proposed.
  let idColumn = columns.find((c) => c.metric === "external_id")
  if (!idColumn && byId) {
    const named = [...byId.values()].find(
      (c) =>
        isAquillaIdTitle(c.title) &&
        (c.type === "text" || c.type === "long_text") &&
        !columns.some((m) => m.columnId === c.id),
    )
    if (named) {
      idColumn = { columnId: named.id, columnType: named.type, metric: "external_id" }
      columns.push(idColumn)
    }
  }
  if (idColumn) matchExisting = { columnId: idColumn.columnId }

  // The name template is kept in its one written form, so "{{project_name}}"
  // is stored as "{projectName}"; one naming anything else is dropped and the
  // rows keep their default names (lib/integrations/item-name.ts).
  let itemNameTemplate: string | undefined
  if (typeof obj.itemNameTemplate === "string" && obj.itemNameTemplate) {
    itemNameTemplate = canonicalItemNameTemplate(obj.itemNameTemplate) ?? undefined
    if (!itemNameTemplate) {
      warnings.push(
        `dropped itemNameTemplate '${obj.itemNameTemplate}': only {projectName} and {fileName} can be filled in`,
      )
    }
  }

  let fileSubitems: MondayFileSubitems | undefined
  if (obj.fileSubitems && typeof obj.fileSubitems === "object" && !Array.isArray(obj.fileSubitems)) {
    if (granularity === "project") {
      const raw = obj.fileSubitems as Record<string, unknown>
      // The subitems board's columns are checked by the push, which reads that
      // board; `structure` is the parent board's and knows none of them.
      fileSubitems = {
        ...(typeof raw.boardId === "string" && raw.boardId ? { boardId: raw.boardId } : {}),
        columns: sanitizeColumns(raw.columns, null, warnings).filter((c) =>
          SUBITEM_METRICS.includes(c.metric),
        ),
      }
    } else {
      warnings.push("dropped fileSubitems: files are subitems only under one item for the whole project")
    }
  }

  return {
    mapping: {
      version: 1,
      itemGranularity: granularity,
      ...(groupId && { groupId }),
      ...(itemNameTemplate && { itemNameTemplate }),
      ...(matchExisting && { matchExisting }),
      columns,
      ...(typeof obj.notes === "string" && obj.notes ? { notes: obj.notes } : {}),
      ...(fileSubitems && { fileSubitems }),
    },
    warnings,
  }
}

/**
 * Keep the column mappings that can be written: a known metric, a column the
 * board has (when `byId` is the board's columns; its live type wins), a type
 * that isn't read-only and that the metric can write, each column once.
 */
function sanitizeColumns(
  raw: unknown,
  byId: Map<string, MondayBoardColumn> | null,
  warnings: string[],
): MondayColumnMapping[] {
  const columns: MondayColumnMapping[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (entry == null || typeof entry !== "object") continue
    const col = entry as Record<string, unknown>
    const columnId = typeof col.columnId === "string" ? col.columnId : ""
    if (!columnId) {
      warnings.push("dropped a column mapping without a columnId")
      continue
    }
    if (!isMetricKey(col.metric)) {
      warnings.push(`dropped column '${columnId}': unknown metric '${String(col.metric)}'`)
      continue
    }
    let columnType = typeof col.columnType === "string" ? col.columnType : ""
    if (byId) {
      const live = byId.get(columnId)
      if (!live) {
        warnings.push(`dropped column '${columnId}': not found on the board`)
        continue
      }
      columnType = live.type
    }
    if (READ_ONLY_COLUMN_TYPES.has(columnType)) {
      warnings.push(`dropped column '${columnId}': type '${columnType}' is read-only via the Monday API`)
      continue
    }
    if (!WRITABLE_TYPES_BY_METRIC[col.metric].includes(columnType)) {
      warnings.push(
        `dropped column '${columnId}': metric '${col.metric}' cannot write to a '${columnType}' column`,
      )
      continue
    }
    if (columns.some((c) => c.columnId === columnId)) {
      warnings.push(`dropped duplicate mapping for column '${columnId}'`)
      continue
    }
    columns.push({ columnId, columnType, metric: col.metric })
  }
  return columns
}
