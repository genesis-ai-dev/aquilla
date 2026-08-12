// Shared contextual-run domain logic (contextual translation pipeline design
// §8, slice D1). Lives in db/shared/ (beside scene-briefs.ts / agent-memory.ts)
// so the auth-worker routes AND the tick executor apply the SAME validation +
// parameterized SQL with no forked logic.
//
// Scope: run rows (create / get / list / guarded status transitions / span
// outcome accounting), the steering inbox (append / read-unconsumed / mark
// consumed), and staged drafts (insert-with-supersede / list / review).
// Identity + authorization stay in the caller; this module never touches HTTP.
//
// Every transition is a GUARDED UPDATE (`WHERE id = ? AND status IN (…)`) so
// two racing writers cannot both win: the loser's UPDATE matches zero rows and
// reports `invalid_state` instead of silently clobbering.

import type { AquillaDb } from "../shim/postgres"
import { MEMORY_MAX_BYTES, detectSecret } from "./agent-memory"

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type ContextualRunStatus =
  | "running"
  | "pausing"
  | "paused"
  | "parked"
  | "done"
  | "failed"
  | "terminated"

const ACTIVE_STATUSES: ContextualRunStatus[] = ["running", "pausing", "paused", "parked"]

/** Serialized span seed — the same shape slice C's `deriveSpanSeeds` emits
 *  (auth-worker/src/lib/contextual/types.ts SpanSeed), stored verbatim so a
 *  resumed tick replays the exact original segmentation. */
export interface StoredSpanSeed {
  id: string
  fileId: string
  anchorCellId: string
  startCellId: string
  endCellId: string
  seedSource: string
}

export interface SpanCursor {
  seeds: StoredSpanSeed[]
  nextIndex: number
}

export interface RoleSnapshot {
  userId: number
  username: string
  level: number
}

export interface ContextualRun {
  id: string
  projectId: string
  fileId: string
  targetLang: string
  status: ContextualRunStatus
  initiatedBy: string | null
  roleSnapshot: RoleSnapshot | null
  spanCursor: SpanCursor | null
  doneSpans: number
  totalSpans: number
  failedSpans: number
  unitsSpent: number
  callsSpent: number
  lastError: string | null
  steeringCursor: string | null
  /** Where the user was looking at start — rotates the first wave's seeds. */
  anchorCellId: string | null
  /** Shared across every run one project-wide start created. */
  scopeGroup: string | null
  createdAt: string
  updatedAt: string
}

export type SteeringKind = "direction" | "refresh_span" | "note"

export interface SteeringEntry {
  id: string
  projectId: string
  fileId: string | null
  runId: string | null
  kind: SteeringKind
  body: string
  createdBy: string | null
  createdAt: string
  consumedAt: string | null
}

export type ContextualDraftStatus = "proposed" | "applied" | "rejected" | "superseded"

export interface ContextualDraft {
  id: string
  runId: string
  projectId: string
  fileId: string
  cellId: string
  sceneBriefId: string | null
  text: string
  verdicts: Record<string, string> | null
  provenance: Record<string, unknown> | null
  status: ContextualDraftStatus
  createdAt: string
  reviewedAt: string | null
  reviewedBy: string | null
}

export interface ContextualProjectLease {
  id: string
  projectId: string
  runId: string
  weight: number
  expiresAt: string
}

/** Durable product-activity vocabulary. This is intentionally much narrower
 * than an execution trace: prompts, draft text, model reasoning, and token
 * deltas have no representable event kind or detail key. */
export type ContextualRunEventKind =
  | "run_created"
  | "run_state"
  | "span_started"
  | "phase"
  | "scene_ready"
  | "drafts_staged"
  | "span_outcome"
  | "steering_queued"
  | "draft_reviewed"

export type ContextualRunEventPhase = "reading" | "drafting" | "checking" | "staging"

export type ContextualRunEventStatus =
  | ContextualRunStatus
  | "started"
  | "complete"
  | "partial"
  | "queued"
  | "applied"
  | "rejected"
  | "superseded"

/** Categorical reasons only. Raw verifier/model prose is never durable
 * activity; these codes explain the outcome without recording reasoning. */
export type ContextualSpanReason =
  | "scene_construal_incomplete"
  | "draft_failed"
  | "no_draft_returned"
  | "verification_unavailable"
  | "rejected_by_quorum"
  | "target_already_filled"
  | "span_failed"

/** Union of every ALLOWED details field. `appendContextualRunEvent` applies a
 * per-kind allowlist again at runtime, so excess properties from untyped JS or
 * a compromised caller are dropped rather than serialized. */
export interface ContextualRunEventDetails {
  initiatedBy?: string | null
  scopeGroup?: string | null
  anchorCellId?: string | null
  targetLang?: string
  done?: number
  total?: number
  failed?: number
  sceneBriefId?: string
  ambiguityCount?: number
  count?: number
  cellIds?: string[]
  truncated?: boolean
  staged?: number
  skipped?: number
  reasons?: ContextualSpanReason[]
  calls?: number
  units?: number
  steeringId?: string
  steeringKind?: SteeringKind
  draftId?: string
  cellId?: string
  outcome?: "applied" | "rejected" | "superseded"
}

export interface ContextualRunEvent {
  id: string
  runId: string
  projectId: string
  fileId: string
  kind: ContextualRunEventKind
  spanId: string | null
  spanLabel: string | null
  status: ContextualRunEventStatus | null
  phase: ContextualRunEventPhase | null
  summary: string
  details: ContextualRunEventDetails
  createdAt: string
}

export interface AppendContextualRunEventInput {
  runId: string
  projectId: string
  fileId: string
  kind: ContextualRunEventKind
  spanId?: string | null
  spanLabel?: string | null
  status?: ContextualRunEventStatus | null
  phase?: ContextualRunEventPhase | null
  details?: ContextualRunEventDetails
}

/** API/storage bounds. Arrays are capped before JSON serialization; the
 * migration repeats byte-level checks as defence in depth. */
export const CONTEXTUAL_EVENT_LIST_LIMIT = 500
export const CONTEXTUAL_EVENT_DETAILS_MAX_BYTES = 8 * 1024
export const CONTEXTUAL_RUN_LIST_DEFAULT_LIMIT = 50
export const CONTEXTUAL_RUN_LIST_MAX_LIMIT = 100
/** A provider call may be slow, so active ticks renew well before this bound.
 * Expiry is still mandatory: an evicted Worker cannot release in finally. */
export const CONTEXTUAL_PROJECT_LEASE_SECONDS = 300
const CONTEXTUAL_EVENT_SUMMARY_MAX_BYTES = 512
const CONTEXTUAL_EVENT_SPAN_LABEL_MAX_BYTES = 512
const CONTEXTUAL_EVENT_DETAIL_STRING_MAX_CHARS = 256
const CONTEXTUAL_EVENT_CELL_IDS_MAX = 100
const CONTEXTUAL_EVENT_REASONS_MAX = 12

/** Steering body ceiling — same 10KB cap as agent memory / scene briefs. */
export const STEERING_MAX_BYTES = MEMORY_MAX_BYTES

// ──────────────────────────────────────────────────────────────────────────
// UUIDv7 (RFC 9562 §5.7) — time-ordered ids; the client run-store compares
// run ids lexicographically to drop frames from superseded runs.
// ──────────────────────────────────────────────────────────────────────────

function uuidv7(): string {
  const ts = Date.now()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff
  bytes[5] = ts & 0xff
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ──────────────────────────────────────────────────────────────────────────
// Row mapping
// ──────────────────────────────────────────────────────────────────────────

function toIso(v: unknown): string {
  if (v == null) return ""
  if (v instanceof Date) return v.toISOString()
  return new Date(v as string).toISOString()
}

function parseJson(v: unknown): unknown {
  if (v == null) return null
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as unknown
    } catch {
      return null
    }
  }
  return v
}

function parseObject<T>(v: unknown): T | null {
  const parsed = parseJson(v)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null
}

interface RunRow {
  id: string
  project_id: string
  file_id: string
  target_lang: string
  status: ContextualRunStatus
  initiated_by: string | null
  role_snapshot: unknown
  span_cursor: unknown
  done_spans: number
  total_spans: number
  failed_spans: number
  units_spent: number
  calls_spent: number
  last_error: string | null
  steering_cursor: unknown
  anchor_cell_id: string | null
  scope_group: string | null
  created_at: unknown
  updated_at: unknown
}

function parseCursor(v: unknown): SpanCursor | null {
  const obj = parseObject<{ seeds?: unknown; nextIndex?: unknown }>(v)
  if (!obj || !Array.isArray(obj.seeds) || typeof obj.nextIndex !== "number") return null
  return { seeds: obj.seeds as StoredSpanSeed[], nextIndex: obj.nextIndex }
}

function rowToRun(r: RunRow): ContextualRun {
  return {
    id: r.id,
    projectId: r.project_id,
    fileId: r.file_id,
    targetLang: r.target_lang,
    status: r.status,
    initiatedBy: r.initiated_by,
    roleSnapshot: parseObject<RoleSnapshot>(r.role_snapshot),
    spanCursor: parseCursor(r.span_cursor),
    doneSpans: Number(r.done_spans),
    totalSpans: Number(r.total_spans),
    failedSpans: Number(r.failed_spans),
    unitsSpent: Number(r.units_spent),
    callsSpent: Number(r.calls_spent),
    // Apply the same privacy boundary on reads so rows written before the
    // sanitizer shipped cannot leak a provider credential through snapshots.
    lastError: sanitizeRunError(r.last_error),
    steeringCursor: r.steering_cursor == null ? null : toIso(r.steering_cursor),
    anchorCellId: r.anchor_cell_id ?? null,
    scopeGroup: r.scope_group ?? null,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  }
}

const RUN_COLS = `id, project_id, file_id, target_lang, status, initiated_by, role_snapshot,
  span_cursor, done_spans, total_spans, failed_spans, units_spent, calls_spent,
  last_error, steering_cursor, anchor_cell_id, scope_group, created_at, updated_at`

interface SteeringRow {
  id: string
  project_id: string
  file_id: string | null
  run_id: string | null
  kind: SteeringKind
  body: string
  created_by: string | null
  created_at: unknown
  consumed_at: unknown
}

function rowToSteering(r: SteeringRow): SteeringEntry {
  return {
    id: r.id,
    projectId: r.project_id,
    fileId: r.file_id,
    runId: r.run_id,
    kind: r.kind,
    body: r.body,
    createdBy: r.created_by,
    createdAt: toIso(r.created_at),
    consumedAt: r.consumed_at == null ? null : toIso(r.consumed_at),
  }
}

const STEERING_COLS = `id, project_id, file_id, run_id, kind, body, created_by, created_at, consumed_at`

interface DraftRow {
  id: string
  run_id: string
  project_id: string
  file_id: string
  cell_id: string
  scene_brief_id: string | null
  text: string
  verdicts: unknown
  provenance: unknown
  status: ContextualDraftStatus
  created_at: unknown
  reviewed_at: unknown
  reviewed_by: string | null
}

function rowToDraft(r: DraftRow): ContextualDraft {
  return {
    id: r.id,
    runId: r.run_id,
    projectId: r.project_id,
    fileId: r.file_id,
    cellId: r.cell_id,
    sceneBriefId: r.scene_brief_id,
    text: r.text,
    verdicts: parseObject<Record<string, string>>(r.verdicts),
    provenance: parseObject<Record<string, unknown>>(r.provenance),
    status: r.status,
    createdAt: toIso(r.created_at),
    reviewedAt: r.reviewed_at == null ? null : toIso(r.reviewed_at),
    reviewedBy: r.reviewed_by,
  }
}

const DRAFT_COLS = `id, run_id, project_id, file_id, cell_id, scene_brief_id, text,
  verdicts, provenance, status, created_at, reviewed_at, reviewed_by`

interface RunEventRow {
  id: string
  run_id: string
  project_id: string
  file_id: string
  kind: ContextualRunEventKind
  span_id: string | null
  span_label: string | null
  status: ContextualRunEventStatus | null
  phase: ContextualRunEventPhase | null
  summary: string
  details: unknown
  created_at: unknown
}

function rowToRunEvent(r: RunEventRow): ContextualRunEvent {
  return {
    id: r.id,
    runId: r.run_id,
    projectId: r.project_id,
    fileId: r.file_id,
    kind: r.kind,
    spanId: r.span_id,
    spanLabel: r.span_label,
    status: r.status,
    phase: r.phase,
    summary: r.summary,
    details: parseObject<ContextualRunEventDetails>(r.details) ?? {},
    createdAt: toIso(r.created_at),
  }
}

const RUN_EVENT_COLS = `id, run_id, project_id, file_id, kind, span_id,
  span_label, status, phase, summary, details, created_at`

const EVENT_STATUSES = new Set<ContextualRunEventStatus>([
  "running",
  "pausing",
  "paused",
  "parked",
  "done",
  "failed",
  "terminated",
  "started",
  "complete",
  "partial",
  "queued",
  "applied",
  "rejected",
  "superseded",
])
const EVENT_PHASES = new Set<ContextualRunEventPhase>([
  "reading",
  "drafting",
  "checking",
  "staging",
])
const SPAN_REASONS = new Set<ContextualSpanReason>([
  "scene_construal_incomplete",
  "draft_failed",
  "no_draft_returned",
  "verification_unavailable",
  "rejected_by_quorum",
  "target_already_filled",
  "span_failed",
])

function truncateUtf8(value: string, maxBytes: number): string {
  if (new TextEncoder().encode(value).length <= maxBytes) return value
  const suffix = "…"
  const budget = Math.max(0, maxBytes - new TextEncoder().encode(suffix).length)
  let out = ""
  let used = 0
  for (const ch of value) {
    const bytes = new TextEncoder().encode(ch).length
    if (used + bytes > budget) break
    out += ch
    used += bytes
  }
  return `${out}${suffix}`
}

/** Text fields in activity are labels/identifiers only. Collapse controls and
 * secret-shaped values before bounding them; callers never get a generic prose
 * field through which model output could slip. */
function safeEventString(value: unknown, maxChars = CONTEXTUAL_EVENT_DETAIL_STRING_MAX_CHARS): string | null {
  if (typeof value !== "string") return null
  /* Stripping control characters is the point here: this sanitises model
   * output before storage so NULs and escape sequences cannot ride into a
   * log line or a terminal. */
  // eslint-disable-next-line no-control-regex
  const collapsed = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maxChars)
  if (!collapsed) return null
  return detectSecret(collapsed) ? "[redacted]" : collapsed
}

function safeCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value)))
}

function safeStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, maxItems)
    .flatMap((item) => {
      const safe = safeEventString(item)
      return safe ? [safe] : []
    })
}

/** Runtime per-kind allowlist. Never spread caller-provided details here. */
function sanitizeEventDetails(input: AppendContextualRunEventInput): ContextualRunEventDetails {
  const d = input.details ?? {}
  let details: ContextualRunEventDetails
  switch (input.kind) {
    case "run_created": {
      const initiatedBy = safeEventString(d.initiatedBy)
      const scopeGroup = safeEventString(d.scopeGroup)
      const anchorCellId = safeEventString(d.anchorCellId)
      const targetLang = safeEventString(d.targetLang)
      details = {
        ...(initiatedBy ? { initiatedBy } : {}),
        ...(scopeGroup ? { scopeGroup } : {}),
        ...(anchorCellId ? { anchorCellId } : {}),
        ...(targetLang ? { targetLang } : {}),
      }
      break
    }
    case "run_state":
      details = {
        ...(safeCount(d.done) !== undefined ? { done: safeCount(d.done) } : {}),
        ...(safeCount(d.total) !== undefined ? { total: safeCount(d.total) } : {}),
        ...(safeCount(d.failed) !== undefined ? { failed: safeCount(d.failed) } : {}),
      }
      break
    case "span_started":
    case "phase":
      details = {}
      break
    case "scene_ready": {
      const sceneBriefId = safeEventString(d.sceneBriefId)
      details = {
        ...(sceneBriefId ? { sceneBriefId } : {}),
        ...(safeCount(d.ambiguityCount) !== undefined
          ? { ambiguityCount: safeCount(d.ambiguityCount) }
          : {}),
      }
      break
    }
    case "drafts_staged": {
      const cellIds = safeStringArray(d.cellIds, CONTEXTUAL_EVENT_CELL_IDS_MAX)
      details = {
        ...(safeCount(d.count) !== undefined ? { count: safeCount(d.count) } : {}),
        ...(cellIds.length > 0 ? { cellIds } : {}),
        ...(d.truncated === true || (Array.isArray(d.cellIds) && d.cellIds.length > cellIds.length)
          ? { truncated: true }
          : {}),
      }
      break
    }
    case "span_outcome": {
      const reasons = Array.isArray(d.reasons)
        ? d.reasons
            .filter((reason): reason is ContextualSpanReason => SPAN_REASONS.has(reason as ContextualSpanReason))
            .slice(0, CONTEXTUAL_EVENT_REASONS_MAX)
        : []
      details = {
        ...(safeCount(d.staged) !== undefined ? { staged: safeCount(d.staged) } : {}),
        ...(safeCount(d.skipped) !== undefined ? { skipped: safeCount(d.skipped) } : {}),
        ...(reasons.length > 0 ? { reasons: Array.from(new Set(reasons)) } : {}),
        ...(safeCount(d.calls) !== undefined ? { calls: safeCount(d.calls) } : {}),
        ...(safeCount(d.units) !== undefined ? { units: safeCount(d.units) } : {}),
      }
      break
    }
    case "steering_queued": {
      const steeringId = safeEventString(d.steeringId)
      details = {
        ...(steeringId ? { steeringId } : {}),
        ...(["direction", "refresh_span", "note"].includes(d.steeringKind ?? "")
          ? { steeringKind: d.steeringKind }
          : {}),
      }
      break
    }
    case "draft_reviewed": {
      const draftId = safeEventString(d.draftId)
      const cellId = safeEventString(d.cellId)
      details = {
        ...(draftId ? { draftId } : {}),
        ...(cellId ? { cellId } : {}),
        ...(d.outcome === "applied" || d.outcome === "rejected" || d.outcome === "superseded"
          ? { outcome: d.outcome }
          : {}),
      }
      break
    }
  }

  // The allowlists above are already far below the database bound. Retain a
  // final serialized-size guard so future fields fail closed if that changes.
  if (new TextEncoder().encode(JSON.stringify(details)).length > CONTEXTUAL_EVENT_DETAILS_MAX_BYTES) {
    return {}
  }
  return details
}

function eventSummary(input: AppendContextualRunEventInput, details: ContextualRunEventDetails): string {
  const label = safeEventString(input.spanLabel, 160)
  let summary: string
  switch (input.kind) {
    case "run_created":
      summary = "Autopilot run started"
      break
    case "run_state": {
      if (input.status === "parked") {
        const processed = (details.done ?? 0) + (details.failed ?? 0)
        if ((details.total ?? 0) > processed) {
          summary = "Autopilot has work queued"
          break
        }
      }
      const byStatus: Partial<Record<ContextualRunEventStatus, string>> = {
        running: "Autopilot is running",
        pausing: "Pause requested",
        paused: "Autopilot paused",
        parked: "Autopilot is idle",
        done: "Autopilot completed",
        failed: "Autopilot stopped after an error",
        terminated: "Autopilot terminated",
      }
      summary = (input.status && byStatus[input.status]) || "Autopilot status changed"
      break
    }
    case "span_started":
      summary = label ? `Started ${label}` : "Started a span"
      break
    case "phase": {
      const byPhase: Partial<Record<ContextualRunEventPhase, string>> = {
        reading: "Reading context",
        drafting: "Drafting translations",
        checking: "Checking drafts",
        staging: "Staging reviewable drafts",
      }
      summary = (input.phase && byPhase[input.phase]) || "Span phase changed"
      break
    }
    case "scene_ready":
      summary = "Scene analysis ready"
      break
    case "drafts_staged": {
      const count = details.count ?? 0
      summary = `${count} reviewable draft${count === 1 ? "" : "s"} staged`
      break
    }
    case "span_outcome":
      summary =
        input.status === "failed"
          ? "Span failed"
          : input.status === "partial"
            ? "Span partially completed"
            : "Span completed"
      break
    case "steering_queued":
      summary = details.steeringKind === "direction" ? "Direction queued" : "Steering queued"
      break
    case "draft_reviewed":
      summary = details.outcome === "applied"
        ? "Draft applied"
        : details.outcome === "superseded"
          ? "Draft superseded"
          : "Draft rejected"
      break
  }
  return truncateUtf8(summary, CONTEXTUAL_EVENT_SUMMARY_MAX_BYTES)
}

// ──────────────────────────────────────────────────────────────────────────
// Durable activity (append + ordered read only)
// ──────────────────────────────────────────────────────────────────────────

/** Append one sanitized activity fact. There is intentionally no update or
 * delete primitive: corrections are later facts, preserving the audit trail. */
export async function appendContextualRunEvent(
  db: AquillaDb,
  input: AppendContextualRunEventInput,
): Promise<ContextualRunEvent> {
  const details = sanitizeEventDetails(input)
  const status = input.status && EVENT_STATUSES.has(input.status) ? input.status : null
  const phase = input.phase && EVENT_PHASES.has(input.phase) ? input.phase : null
  const spanId = safeEventString(input.spanId)
  const spanLabelRaw = safeEventString(input.spanLabel, 512)
  const spanLabel = spanLabelRaw
    ? truncateUtf8(spanLabelRaw, CONTEXTUAL_EVENT_SPAN_LABEL_MAX_BYTES)
    : null
  const row = await db
    .prepare(
      `INSERT INTO contextual_run_events
          (id, run_id, project_id, file_id, kind, span_id, span_label,
           status, phase, summary, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
       RETURNING ${RUN_EVENT_COLS}`,
    )
    .bind(
      uuidv7(),
      input.runId,
      input.projectId,
      input.fileId,
      input.kind,
      spanId,
      spanLabel,
      status,
      phase,
      eventSummary({ ...input, status, phase, spanLabel }, details),
      // Pass structured JSON across the adapter boundary. postgres.js learns
      // the parameter's jsonb type from `?::jsonb` and applies its JSON
      // serializer. Pre-stringifying here makes that serializer encode the
      // string a second time, producing a jsonb scalar instead of an object.
      details,
    )
    .first<RunEventRow>()
  if (!row) throw new Error("failed to append contextual run event")
  return rowToRunEvent(row)
}

export interface ListContextualRunEventsInput {
  projectId: string
  runId: string
  /** Latest N events, returned in chronological order. Hard-capped at 500. */
  limit?: number
}

export interface ListContextualRunEventsResult {
  events: ContextualRunEvent[]
  truncated: boolean
}

/** Read the latest bounded tail with stable chronological ordering. Fetching
 * limit+1 makes truncation explicit instead of silently pretending the tail is
 * the full history. Project id is part of the predicate for tenant scoping. */
export async function listContextualRunEvents(
  db: AquillaDb,
  input: ListContextualRunEventsInput,
): Promise<ListContextualRunEventsResult> {
  const limit = Math.max(1, Math.min(CONTEXTUAL_EVENT_LIST_LIMIT, Math.floor(input.limit ?? CONTEXTUAL_EVENT_LIST_LIMIT)))
  const { results } = await db
    .prepare(
      `SELECT ${RUN_EVENT_COLS}
         FROM (
           SELECT ${RUN_EVENT_COLS}
             FROM contextual_run_events
            WHERE project_id = ? AND run_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
         ) recent
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(input.projectId, input.runId, limit + 1)
    .all<RunEventRow>()
  const truncated = results.length > limit
  const tail = truncated ? results.slice(results.length - limit) : results
  return { events: tail.map(rowToRunEvent), truncated }
}

// ──────────────────────────────────────────────────────────────────────────
// Runs
// ──────────────────────────────────────────────────────────────────────────

export interface CreateRunInput {
  projectId: string
  fileId: string
  targetLang?: string
  initiatedBy?: string | null
  roleSnapshot?: RoleSnapshot | null
  /** Cell the user was looking at — rotates the first wave to start there. */
  anchorCellId?: string | null
  /** Shared across every run one project-wide start created. */
  scopeGroup?: string | null
}

export type CreateRunResult =
  | { status: "ok"; run: ContextualRun }
  | { status: "active_exists"; runId: string }

/** Create a run, refusing a second ACTIVE run on the same (project, file,
 *  lane). The pre-check gives a friendly error; the partial UNIQUE index
 *  (contextual_runs_active) closes the check-then-insert race. */
export async function createRun(db: AquillaDb, input: CreateRunInput): Promise<CreateRunResult> {
  const lane = input.targetLang ?? ""
  const active = await db
    .prepare(
      `SELECT id FROM contextual_runs
        WHERE project_id = ? AND file_id = ? AND target_lang = ?
          AND status IN ('running','pausing','paused','parked')
        LIMIT 1`,
    )
    .bind(input.projectId, input.fileId, lane)
    .first<{ id: string }>()
  if (active) return { status: "active_exists", runId: active.id }

  try {
    const row = await db
      .prepare(
        `INSERT INTO contextual_runs
            (id, project_id, file_id, target_lang, status, initiated_by, role_snapshot,
             anchor_cell_id, scope_group)
         VALUES (?, ?, ?, ?, 'running', ?, ?::jsonb, ?, ?)
         RETURNING ${RUN_COLS}`,
      )
      .bind(
        uuidv7(),
        input.projectId,
        input.fileId,
        lane,
        input.initiatedBy ?? null,
        input.roleSnapshot ?? null,
        input.anchorCellId ?? null,
        input.scopeGroup ?? null,
      )
      .first<RunRow>()
    if (!row) throw new Error("insert returned no row")
    return { status: "ok", run: rowToRun(row) }
  } catch (err) {
    // Unique-index race: someone else created the active run between our
    // check and insert — report theirs.
    const racing = await db
      .prepare(
        `SELECT id FROM contextual_runs
          WHERE project_id = ? AND file_id = ? AND target_lang = ?
            AND status IN ('running','pausing','paused','parked')
          LIMIT 1`,
      )
      .bind(input.projectId, input.fileId, lane)
      .first<{ id: string }>()
    if (racing) return { status: "active_exists", runId: racing.id }
    throw err
  }
}

export async function getRun(db: AquillaDb, id: string): Promise<ContextualRun | null> {
  const row = await db
    .prepare(`SELECT ${RUN_COLS} FROM contextual_runs WHERE id = ?`)
    .bind(id)
    .first<RunRow>()
  return row ? rowToRun(row) : null
}

export interface ContextualRunListItem extends ContextualRun {
  /** Review backlog attributable to this run only, never a file lifetime. */
  proposedDrafts: number
}

export interface ContextualRunListCursor {
  createdAt: string
  runId: string
}

export interface ListRunsInput {
  fileId?: string
  targetLang?: string
  limit?: number
  /** Review drill-down: only runs that still own proposed drafts. */
  proposedOnly?: boolean
  /** Keyset cursor from the preceding page. Both fields are required. */
  before?: ContextualRunListCursor
}

export interface ListRunsResult {
  runs: ContextualRunListItem[]
  truncated: boolean
  nextCursor: ContextualRunListCursor | null
}

/** Newest-first, bounded run history with a stable keyset cursor. The draft
 * count is joined by run id. Normal history retains legacy non-default-lane
 * evidence; `proposedOnly` without an explicit lane is the actionable v1
 * default-lane queue. */
export async function listRuns(
  db: AquillaDb,
  projectId: string,
  input: ListRunsInput = {},
): Promise<ListRunsResult> {
  const where = ["project_id = ?"]
  const binds: unknown[] = [projectId]
  if (input.fileId) {
    where.push("file_id = ?")
    binds.push(input.fileId)
  }
  if (input.targetLang !== undefined) {
    where.push("target_lang = ?")
    binds.push(input.targetLang)
  }
  if (input.proposedOnly) {
    // The editor review queue is deliberately default-lane-only in v1. A
    // historic non-default run may still be inspected through normal history,
    // but it must not become the owner selected by the actionable project
    // review count.
    if (input.targetLang === undefined) where.push("target_lang = ''")
    where.push(`EXISTS (
      SELECT 1 FROM contextual_drafts proposed
       WHERE proposed.project_id = contextual_runs.project_id
         AND proposed.run_id = contextual_runs.id
         AND proposed.status = 'proposed'
    )`)
  }
  if (input.before) {
    where.push("(created_at, id) < (?::timestamptz, ?)")
    binds.push(input.before.createdAt, input.before.runId)
  }
  const limit = Math.max(
    1,
    Math.min(
      CONTEXTUAL_RUN_LIST_MAX_LIMIT,
      Math.floor(input.limit ?? CONTEXTUAL_RUN_LIST_DEFAULT_LIMIT),
    ),
  )
  const { results } = await db
    .prepare(
      `SELECT ${RUN_COLS},
              (SELECT COUNT(*) FROM contextual_drafts d
                WHERE d.project_id = contextual_runs.project_id
                  AND d.run_id = contextual_runs.id
                  AND d.status = 'proposed') AS proposed_drafts
         FROM contextual_runs
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<RunRow & { proposed_drafts: number }>()
  const truncated = results.length > limit
  const page = truncated ? results.slice(0, limit) : results
  const last = page.at(-1)
  return {
    runs: page.map((row) => ({ ...rowToRun(row), proposedDrafts: Number(row.proposed_drafts) })),
    truncated,
    nextCursor: truncated && last
      ? {
          // Production's timestamp parser preserves microseconds as a string;
          // retain that exact value in the keyset cursor instead of rounding.
          createdAt: last.created_at instanceof Date
            ? last.created_at.toISOString()
            : String(last.created_at),
          runId: last.id,
        }
      : null,
  }
}

/** The active (non-terminal) run for a (project, file, lane), if any. */
export async function getActiveRun(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  targetLang = "",
): Promise<ContextualRun | null> {
  const row = await db
    .prepare(
      `SELECT ${RUN_COLS} FROM contextual_runs
        WHERE project_id = ? AND file_id = ? AND target_lang = ?
          AND status IN ('running','pausing','paused','parked')
        LIMIT 1`,
    )
    .bind(projectId, fileId, targetLang)
    .first<RunRow>()
  return row ? rowToRun(row) : null
}

export type TransitionResult =
  | { status: "ok"; run: ContextualRun }
  | { status: "not_found" }
  | { status: "invalid_state"; current: ContextualRunStatus }

const RUN_ERROR_MAX_CHARS = 2000
const REDACTED_RUN_ERROR = "Autopilot error details were redacted because they may contain a secret."

/** Raw provider exceptions can contain credentials, headers, or control
 * characters. Keep useful safe text, but never persist a secret-shaped error
 * into snapshots/activity-adjacent state. */
function sanitizeRunError(value: string | null | undefined): string | null {
  if (value == null) return null
  const collapsed = value
    // Stripping control characters is the point here: run errors are echoed
    // back and stored, so NULs and escape sequences must not ride along.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!collapsed) return null
  // detectSecret intentionally targets known credential formats. Historic
  // provider bodies can also contain opaque Authorization/Bearer material,
  // so fail closed on the generic HTTP credential shapes the inspector might
  // otherwise surface from rows written before provider-body suppression.
  if (
    detectSecret(collapsed)
    || /\bauthorization\s*:\s*(?:bearer|basic)\b/i.test(collapsed)
    || /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(collapsed)
  ) return REDACTED_RUN_ERROR
  return collapsed.slice(0, RUN_ERROR_MAX_CHARS)
}

/**
 * Guarded status transition: succeeds only when the run currently sits in one
 * of `from`. The losing side of a race matches zero rows and gets
 * `invalid_state` with the actual current status.
 */
export async function transitionRun(
  db: AquillaDb,
  runId: string,
  from: ContextualRunStatus[],
  to: ContextualRunStatus,
  lastError?: string,
): Promise<TransitionResult> {
  if (from.length === 0) return { status: "not_found" }
  const placeholders = from.map(() => "?").join(",")
  const safeLastError = sanitizeRunError(lastError)
  const row = await db
    .prepare(
      `UPDATE contextual_runs
          SET status = ?, last_error = COALESCE(?, last_error), updated_at = now()
        WHERE id = ? AND status IN (${placeholders})
        RETURNING ${RUN_COLS}`,
    )
    .bind(to, safeLastError, runId, ...from)
    .first<RunRow>()
  if (row) return { status: "ok", run: rowToRun(row) }
  const current = await getRun(db, runId)
  if (!current) return { status: "not_found" }
  return { status: "invalid_state", current: current.status }
}

/** running → pausing (user asked; the tick loop confirms at the next span edge). */
export const requestPause = (db: AquillaDb, runId: string) =>
  transitionRun(db, runId, ["running"], "pausing")
/** pausing → paused — ONLY from pausing (the tick executor's acknowledgement). */
export const confirmPause = (db: AquillaDb, runId: string) =>
  transitionRun(db, runId, ["pausing"], "paused")
/** paused | parked → running (resume, or steering waking a parked run). */
export const resumeRun = (db: AquillaDb, runId: string) =>
  transitionRun(db, runId, ["paused", "parked"], "running")
/** Any active state → terminated (hard stop; terminal). */
export const terminateRun = (db: AquillaDb, runId: string) =>
  transitionRun(db, runId, [...ACTIVE_STATUSES], "terminated")
/** running → parked (spans exhausted; steering can wake it). */
export const parkRun = (db: AquillaDb, runId: string) =>
  transitionRun(db, runId, ["running"], "parked")
/** Any active state → failed, recording the error. */
export const failRun = (db: AquillaDb, runId: string, error: string) =>
  transitionRun(db, runId, [...ACTIVE_STATUSES], "failed", error)

/** Persist the derived seed list (first tick). Sets total_spans. */
export async function setSpanCursor(
  db: AquillaDb,
  runId: string,
  cursor: SpanCursor,
): Promise<ContextualRun | null> {
  const row = await db
    .prepare(
      `UPDATE contextual_runs
          SET span_cursor = ?::jsonb, total_spans = ?, updated_at = now()
        WHERE id = ?
        RETURNING ${RUN_COLS}`,
    )
    .bind(cursor, cursor.seeds.length, runId)
    .first<RunRow>()
  return row ? rowToRun(row) : null
}

export interface WaveOutcomeInput {
  cursor: SpanCursor
  /** Spans in the wave that finished with staged work. */
  doneCount: number
  /** Spans in the wave that failed or staged nothing. */
  failedCount: number
  unitsUsed: number
  callsUsed: number
  lastError?: string | null
  steeringCursor?: string
}

/** Record a WAVE's outcome: cursor advance + counters in ONE UPDATE, so a
 *  crash between "spans worked" and "cursor advanced" can only replay a wave,
 *  never skip one. Re-proposing a draft on the same cell is idempotent
 *  (insertDrafts supersedes), so a replay costs tokens, never correctness. */
export async function recordWaveOutcome(
  db: AquillaDb,
  runId: string,
  input: WaveOutcomeInput,
): Promise<ContextualRun | null> {
  const safeLastError = sanitizeRunError(input.lastError)
  const row = await db
    .prepare(
      `UPDATE contextual_runs
          SET span_cursor = ?::jsonb,
              total_spans = ?,
              done_spans = done_spans + ?,
              failed_spans = failed_spans + ?,
              units_spent = units_spent + ?,
              calls_spent = calls_spent + ?,
              last_error = ?,
              steering_cursor = COALESCE(?::timestamptz, steering_cursor),
              updated_at = now()
        WHERE id = ?
        RETURNING ${RUN_COLS}`,
    )
    .bind(
      input.cursor,
      input.cursor.seeds.length,
      Math.max(0, Math.round(input.doneCount)),
      Math.max(0, Math.round(input.failedCount)),
      Math.max(0, Math.round(input.unitsUsed)),
      Math.max(0, Math.round(input.callsUsed)),
      safeLastError,
      input.steeringCursor ?? null,
      runId,
    )
    .first<RunRow>()
  return row ? rowToRun(row) : null
}

export interface SpanOutcomeInput {
  cursor: SpanCursor
  outcome: "done" | "failed"
  unitsUsed: number
  callsUsed: number
  lastError?: string | null
  steeringCursor?: string
}

/** Single-span form of {@link recordWaveOutcome} (a wave of one). */
export async function recordSpanOutcome(
  db: AquillaDb,
  runId: string,
  input: SpanOutcomeInput,
): Promise<ContextualRun | null> {
  const { outcome, ...rest } = input
  return recordWaveOutcome(db, runId, {
    ...rest,
    doneCount: outcome === "done" ? 1 : 0,
    failedCount: outcome === "failed" ? 1 : 0,
  })
}

/**
 * Heartbeat: prove a driver is alive without changing any run state.
 *
 * `updated_at` doubles as the driver lease — {@link claimStrandedRuns} only
 * adopts runs whose heartbeat has gone quiet, so a wave that legitimately
 * takes minutes must touch the row before it starts.
 */
export async function touchRun(db: AquillaDb, runId: string): Promise<void> {
  await db
    .prepare(`UPDATE contextual_runs SET updated_at = now() WHERE id = ? AND status = 'running'`)
    .bind(runId)
    .run()
}

// ──────────────────────────────────────────────────────────────────────────
// Steering
// ──────────────────────────────────────────────────────────────────────────

export interface AppendSteeringInput {
  projectId: string
  fileId?: string | null
  runId?: string | null
  kind: SteeringKind
  body: string
  createdBy?: string | null
}

export type AppendSteeringResult =
  | { status: "ok"; entry: SteeringEntry }
  | { status: "validation_failed"; message: string }

export async function appendSteering(
  db: AquillaDb,
  input: AppendSteeringInput,
): Promise<AppendSteeringResult> {
  const body = input.body.trim()
  if (!body) return { status: "validation_failed", message: "steering body is empty" }
  const bytes = new TextEncoder().encode(body).length
  if (bytes > STEERING_MAX_BYTES) {
    return {
      status: "validation_failed",
      message: `steering body is ${bytes} bytes — exceeds the ${STEERING_MAX_BYTES} byte limit`,
    }
  }
  const secret = detectSecret(body)
  if (secret) {
    return {
      status: "validation_failed",
      message: `steering body matched a forbidden secret pattern (${secret})`,
    }
  }
  const row = await db
    .prepare(
      `INSERT INTO contextual_steering (id, project_id, file_id, run_id, kind, body, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING ${STEERING_COLS}`,
    )
    .bind(
      uuidv7(),
      input.projectId,
      input.fileId ?? null,
      input.runId ?? null,
      input.kind,
      body,
      input.createdBy ?? null,
    )
    .first<SteeringRow>()
  if (!row) return { status: "validation_failed", message: "failed to insert steering entry" }
  return { status: "ok", entry: rowToSteering(row) }
}

/** Unconsumed steering visible to a run: project-wide entries plus entries
 *  scoped to this file or this run, oldest first. */
export async function readUnconsumedSteering(
  db: AquillaDb,
  scope: { projectId: string; fileId: string; runId: string },
): Promise<SteeringEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT ${STEERING_COLS} FROM contextual_steering
        WHERE project_id = ? AND consumed_at IS NULL
          AND (file_id IS NULL OR file_id = ?)
          AND (run_id IS NULL OR run_id = ?)
        ORDER BY created_at ASC`,
    )
    .bind(scope.projectId, scope.fileId, scope.runId)
    .all<SteeringRow>()
  return results.map(rowToSteering)
}

export async function markSteeringConsumed(db: AquillaDb, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const placeholders = ids.map(() => "?").join(",")
  await db
    .prepare(
      `UPDATE contextual_steering SET consumed_at = now()
        WHERE id IN (${placeholders}) AND consumed_at IS NULL`,
    )
    .bind(...ids)
    .run()
}

// ──────────────────────────────────────────────────────────────────────────
// Drafts
// ──────────────────────────────────────────────────────────────────────────

export interface InsertDraftsInput {
  runId: string
  projectId: string
  fileId: string
  sceneBriefId?: string | null
  drafts: {
    cellId: string
    text: string
    verdicts?: Record<string, string> | null
    provenance?: Record<string, unknown> | null
  }[]
}

/**
 * Stage span drafts. A new proposal supersedes any existing `proposed` row on
 * the same cell — the supersede UPDATE and the INSERTs run in one atomic
 * batch, so the partial UNIQUE (contextual_drafts_live) never conflicts
 * *within* this call.
 *
 * ON CONFLICT closes the ACROSS-call race that waves introduce: two spans in
 * the same wave can overlap a cell (a `refresh_span` re-enqueue, or a seed
 * subdivided after new cells landed). Serially that was impossible, so a bare
 * INSERT was safe; concurrently a bare INSERT would throw a unique violation
 * and fail an otherwise-good span. Last writer wins the live proposal, which
 * matches the supersede rule the serial path already had.
 */
export async function insertDrafts(
  db: AquillaDb,
  input: InsertDraftsInput,
): Promise<ContextualDraft[]> {
  if (input.drafts.length === 0) return []
  const cellIds = input.drafts.map((d) => d.cellId)
  const placeholders = cellIds.map(() => "?").join(",")
  const stmts = [
    db
      .prepare(
        `UPDATE contextual_drafts SET status = 'superseded', reviewed_at = now()
          WHERE project_id = ? AND file_id = ? AND cell_id IN (${placeholders})
            AND status = 'proposed'`,
      )
      .bind(input.projectId, input.fileId, ...cellIds),
    ...input.drafts.map((d) =>
      db
        .prepare(
          `INSERT INTO contextual_drafts
              (id, run_id, project_id, file_id, cell_id, scene_brief_id, text, verdicts, provenance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)
           ON CONFLICT (project_id, file_id, cell_id) WHERE status = 'proposed'
           DO UPDATE SET
             id = EXCLUDED.id,
             run_id = EXCLUDED.run_id,
             scene_brief_id = EXCLUDED.scene_brief_id,
             text = EXCLUDED.text,
             verdicts = EXCLUDED.verdicts,
             provenance = EXCLUDED.provenance,
             created_at = now()`,
        )
        .bind(
          uuidv7(),
          input.runId,
          input.projectId,
          input.fileId,
          d.cellId,
          input.sceneBriefId ?? null,
          d.text,
          d.verdicts ?? null,
          d.provenance ?? null,
        ),
    ),
  ]
  await db.batch(stmts)
  const { results } = await db
    .prepare(
      `SELECT ${DRAFT_COLS} FROM contextual_drafts
        WHERE project_id = ? AND file_id = ? AND status = 'proposed'
          AND cell_id IN (${placeholders})`,
    )
    .bind(input.projectId, input.fileId, ...cellIds)
    .all<DraftRow>()
  return results.map(rowToDraft)
}

export async function listDrafts(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  status?: ContextualDraftStatus,
  targetLang = "",
): Promise<ContextualDraft[]> {
  const where = ["project_id = ?", "file_id = ?"]
  const binds: unknown[] = [projectId, fileId]
  if (status) {
    where.push("status = ?")
    binds.push(status)
  }
  // contextual_drafts predates lane ownership. Join through its durable run
  // rather than treating every proposal for a file as belonging to whichever
  // lane the editor currently shows. V1 only exposes the default lane; historic
  // non-default rows remain reachable as run evidence via listDraftPageByRun.
  where.push(`EXISTS (
    SELECT 1 FROM contextual_runs owner
     WHERE owner.id = contextual_drafts.run_id
       AND owner.project_id = contextual_drafts.project_id
       AND owner.file_id = contextual_drafts.file_id
       AND owner.target_lang = ?
  )`)
  binds.push(targetLang)
  const { results } = await db
    .prepare(
      `SELECT ${DRAFT_COLS} FROM contextual_drafts
        WHERE ${where.join(" AND ")}
        ORDER BY created_at ASC`,
    )
    .bind(...binds)
    .all<DraftRow>()
  return results.map(rowToDraft)
}

/** Evidence produced by one run, across every draft status. The project
 * predicate is intentional even though run ids are globally unique: callers
 * cannot turn a guessed run id into a cross-tenant read. */
export async function listDraftsByRun(
  db: AquillaDb,
  projectId: string,
  runId: string,
  limit?: number,
): Promise<ContextualDraft[]> {
  const bounded =
    limit === undefined ? null : Math.max(1, Math.min(CONTEXTUAL_EVENT_LIST_LIMIT + 1, Math.floor(limit)))
  const statement =
    bounded === null
      ? db
          .prepare(
            `SELECT ${DRAFT_COLS} FROM contextual_drafts
              WHERE project_id = ? AND run_id = ?
              ORDER BY created_at ASC, id ASC`,
          )
          .bind(projectId, runId)
      : db
          .prepare(
            `SELECT ${DRAFT_COLS}
               FROM (
                 SELECT ${DRAFT_COLS} FROM contextual_drafts
                  WHERE project_id = ? AND run_id = ?
                  ORDER BY created_at DESC, id DESC
                  LIMIT ?
               ) recent
              ORDER BY created_at ASC, id ASC`,
          )
          .bind(projectId, runId, bounded)
  const { results } = await statement.all<DraftRow>()
  return results.map(rowToDraft)
}

export interface ContextualDraftListCursor {
  createdAt: string
  draftId: string
}

export interface ListDraftPageByRunInput {
  limit?: number
  status?: ContextualDraftStatus
  /** Fetch evidence older than the oldest row on the preceding page. */
  before?: ContextualDraftListCursor
}

export interface ListDraftPageByRunResult {
  /** Latest matching page, returned in chronological order for evidence UI. */
  drafts: ContextualDraft[]
  truncated: boolean
  nextCursor: ContextualDraftListCursor | null
}

/** Bounded, status-aware run evidence. Unlike the compatibility helper above,
 * this always returns an explicit keyset cursor so a run with more than 500
 * review items remains completely reachable. */
export async function listDraftPageByRun(
  db: AquillaDb,
  projectId: string,
  runId: string,
  input: ListDraftPageByRunInput = {},
): Promise<ListDraftPageByRunResult> {
  const where = ["project_id = ?", "run_id = ?"]
  const binds: unknown[] = [projectId, runId]
  if (input.status) {
    where.push("status = ?")
    binds.push(input.status)
  }
  if (input.before) {
    where.push("(created_at, id) < (?::timestamptz, ?)")
    binds.push(input.before.createdAt, input.before.draftId)
  }
  const limit = Math.max(
    1,
    Math.min(CONTEXTUAL_EVENT_LIST_LIMIT, Math.floor(input.limit ?? CONTEXTUAL_EVENT_LIST_LIMIT)),
  )
  const { results } = await db
    .prepare(
      `SELECT ${DRAFT_COLS}
         FROM (
           SELECT ${DRAFT_COLS} FROM contextual_drafts
            WHERE ${where.join(" AND ")}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
         ) recent
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(...binds, limit + 1)
    .all<DraftRow>()
  const truncated = results.length > limit
  // The inner query selected one extra OLD row; after the outer chronological
  // sort it sits first. Drop it so this page remains the latest N rows.
  const page = truncated ? results.slice(-limit) : results
  const oldest = page[0]
  return {
    drafts: page.map(rowToDraft),
    truncated,
    nextCursor: truncated && oldest
      ? {
          createdAt: oldest.created_at instanceof Date
            ? oldest.created_at.toISOString()
            : String(oldest.created_at),
          draftId: oldest.id,
        }
      : null,
  }
}

export type ReviewDraftResult =
  | { status: "ok"; draft: ContextualDraft }
  | { status: "already"; draft: ContextualDraft }
  | { status: "not_projected" }
  | { status: "not_found" }
  | { status: "invalid_state"; current: ContextualDraftStatus }

/** Review handshake retained for rejection and rolling clients. An `applied`
 * acknowledgement is accepted only after the exact draft text is already
 * authoritative in the owning run's lane; current clients let the winning
 * target projection perform that transition directly. */
export async function reviewDraft(
  db: AquillaDb,
  input: { id: string; action: "applied" | "rejected"; reviewedBy?: string | null },
): Promise<ReviewDraftResult> {
  const appliedProjectionGate = input.action === "applied"
    ? ` AND EXISTS (
          SELECT 1
            FROM contextual_runs owner
            JOIN cells target
              ON target.project_id = contextual_drafts.project_id
             AND target.file_id = contextual_drafts.file_id
             AND target.cell_id = contextual_drafts.cell_id
             AND target.side = 'target'
             AND target.target_lang = owner.target_lang
             AND target.value = contextual_drafts.text
           WHERE owner.id = contextual_drafts.run_id
             AND owner.project_id = contextual_drafts.project_id
             AND owner.file_id = contextual_drafts.file_id
        )`
    : ""
  const row = await db
    .prepare(
      `UPDATE contextual_drafts
          SET status = ?, reviewed_at = now(), reviewed_by = ?
        WHERE id = ? AND status = 'proposed'${appliedProjectionGate}
        RETURNING ${DRAFT_COLS}`,
    )
    .bind(input.action, input.reviewedBy ?? null, input.id)
    .first<DraftRow>()
  if (row) return { status: "ok", draft: rowToDraft(row) }
  const current = await db
    .prepare(`SELECT ${DRAFT_COLS} FROM contextual_drafts WHERE id = ?`)
    .bind(input.id)
    .first<DraftRow>()
  if (!current) return { status: "not_found" }
  if (current.status === input.action) {
    // Idempotent retry: the first response may have been lost after the row
    // committed. Returning success lets the client converge without emitting
    // a duplicate review activity event.
    return { status: "already", draft: rowToDraft(current) }
  }
  if (input.action === "applied" && current.status === "proposed") {
    return { status: "not_projected" }
  }
  return { status: "invalid_state", current: current.status }
}

/**
 * Which of these cells already hold human (or previously-applied) target text.
 *
 * Called immediately before staging, as late as possible: the pipeline works
 * from a pairs snapshot taken at wave start, and a translator may well have
 * typed into one of these cells in the minute since. A draft is a proposal and
 * can never overwrite anything — but a proposal stacked on top of someone's
 * fresh work is noise they have to dismiss, and that is how a translator
 * learns to distrust the whole feature.
 */
export async function findOccupiedCells(
  db: AquillaDb,
  scope: { projectId: string; fileId: string; cellIds: string[]; targetLang?: string },
): Promise<Set<string>> {
  if (scope.cellIds.length === 0) return new Set()
  const placeholders = scope.cellIds.map(() => "?").join(",")
  const lanePredicate = scope.targetLang === undefined ? "" : " AND target_lang = ?"
  const { results } = await db
    .prepare(
      `SELECT cell_id FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'target'
          AND cell_id IN (${placeholders})
          AND COALESCE(value, '') <> ''${lanePredicate}`,
    )
    .bind(
      scope.projectId,
      scope.fileId,
      ...scope.cellIds,
      ...(scope.targetLang === undefined ? [] : [scope.targetLang]),
    )
    .all<{ cell_id: string }>()
  return new Set(results.map((r) => r.cell_id))
}

/** Live proposals from an earlier run reserve their cells for human review.
 * A recovery run may fill the missing siblings, but must not silently
 * supersede work the user has not reviewed yet. Proposals owned by the current
 * run are excluded from this reservation so explicit refresh remains valid. */
export async function findProposedCellsFromOtherRuns(
  db: AquillaDb,
  scope: { projectId: string; fileId: string; runId: string; targetLang: string },
): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT cell_id FROM contextual_drafts
        WHERE project_id = ? AND file_id = ? AND status = 'proposed'
          AND run_id <> ?
          AND EXISTS (
            SELECT 1 FROM contextual_runs owner
             WHERE owner.id = contextual_drafts.run_id
               AND owner.project_id = contextual_drafts.project_id
               AND owner.file_id = contextual_drafts.file_id
               AND owner.target_lang = ?
          )`,
    )
    .bind(scope.projectId, scope.fileId, scope.runId, scope.targetLang)
    .all<{ cell_id: string }>()
  return new Set(results.map((row) => row.cell_id))
}

// ──────────────────────────────────────────────────────────────────────────
// Cross-isolate project concurrency leases
// ──────────────────────────────────────────────────────────────────────────

interface ProjectLeaseRow {
  id: string
  project_id: string
  run_id: string
  weight: number
  expires_at: unknown
}

function rowToProjectLease(row: ProjectLeaseRow): ContextualProjectLease {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    weight: Number(row.weight),
    expiresAt: toIso(row.expires_at),
  }
}

export interface TryAcquireContextualProjectLeaseInput {
  projectId: string
  runId: string
  /** Maximum aggregate wave width permitted for this project. */
  limit: number
  /** Maximum span width this runOneTick call may execute. */
  weight: number
  leaseSeconds?: number
}

/** Atomically reserve weighted project capacity across Worker isolates.
 * Locking the canonical project row serializes the sum-and-insert decision;
 * a module-local semaphore alone cannot protect two Cloudflare isolates. */
export async function tryAcquireContextualProjectLease(
  db: AquillaDb,
  input: TryAcquireContextualProjectLeaseInput,
): Promise<ContextualProjectLease | null> {
  if (!db.transaction) {
    throw new Error("contextual_project_lease_transaction_unavailable")
  }
  const limit = Math.max(1, Math.min(1000, Math.floor(input.limit)))
  const weight = Math.max(1, Math.min(limit, Math.floor(input.weight)))
  const leaseSeconds = Math.max(
    30,
    Math.min(3600, Math.floor(input.leaseSeconds ?? CONTEXTUAL_PROJECT_LEASE_SECONDS)),
  )
  return db.transaction(async (tx) => {
    const project = await tx
      .prepare("SELECT id FROM projects WHERE id = ? FOR UPDATE")
      .bind(input.projectId)
      .first<{ id: string }>()
    if (!project) return null

    await tx
      .prepare("DELETE FROM contextual_project_leases WHERE project_id = ? AND expires_at <= now()")
      .bind(input.projectId)
      .run()
    const used = await tx
      .prepare(
        `SELECT COALESCE(SUM(weight), 0) AS weight
           FROM contextual_project_leases
          WHERE project_id = ? AND expires_at > now()`,
      )
      .bind(input.projectId)
      .first<{ weight: number }>()
    if (Number(used?.weight ?? 0) + weight > limit) return null

    const row = await tx
      .prepare(
        `INSERT INTO contextual_project_leases
            (id, project_id, run_id, weight, expires_at)
         VALUES (?, ?, ?, ?, now() + make_interval(secs => ?))
         ON CONFLICT (run_id) DO NOTHING
         RETURNING id, project_id, run_id, weight, expires_at`,
      )
      .bind(uuidv7(), input.projectId, input.runId, weight, leaseSeconds)
      .first<ProjectLeaseRow>()
    return row ? rowToProjectLease(row) : null
  })
}

/** Renew only a still-live lease. Once expiry has made capacity reusable, a
 * late owner may not resurrect its row and overlap the replacement owner. */
export async function renewContextualProjectLease(
  db: AquillaDb,
  lease: Pick<ContextualProjectLease, "id" | "projectId" | "runId">,
  leaseSeconds = CONTEXTUAL_PROJECT_LEASE_SECONDS,
): Promise<boolean> {
  const boundedSeconds = Math.max(30, Math.min(3600, Math.floor(leaseSeconds)))
  const row = await db
    .prepare(
      `UPDATE contextual_project_leases
          SET expires_at = now() + make_interval(secs => ?)
        WHERE id = ? AND project_id = ? AND run_id = ? AND expires_at > now()
        RETURNING id`,
    )
    .bind(boundedSeconds, lease.id, lease.projectId, lease.runId)
    .first<{ id: string }>()
  return row?.id === lease.id
}

export async function releaseContextualProjectLease(
  db: AquillaDb,
  lease: Pick<ContextualProjectLease, "id" | "projectId" | "runId">,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM contextual_project_leases
        WHERE id = ? AND project_id = ? AND run_id = ?`,
    )
    .bind(lease.id, lease.projectId, lease.runId)
    .run()
}

// ──────────────────────────────────────────────────────────────────────────
// Driver recovery
// ──────────────────────────────────────────────────────────────────────────

/** How long a 'running' run may go without a heartbeat before the sweeper
 *  treats its driver as dead. Comfortably longer than the slowest wave. */
export const DRIVER_STALE_SECONDS = 300

/**
 * Adopt runs whose driver is gone, returning the ones this caller now owns.
 *
 * Two strandings, both previously terminal:
 *   - `running` with a quiet heartbeat — the Worker request that owned the
 *     self-tick loop ended (eviction, deploy, an uncaught throw past the
 *     handler). `resumeRun` refuses a 'running' run, so nothing could restart
 *     it and the pill span forever.
 *   - `parked` with spans still on the cursor — the loop hit its wave cap and
 *     parked deliberately. Waking it is how a file larger than one loop's cap
 *     finishes without the user clicking anything.
 *
 * The UPDATE is the claim: exactly one sweeper can win a given row per pass,
 * because the guard requires the stale heartbeat it then overwrites.
 */
export async function claimStrandedRuns(
  db: AquillaDb,
  limit = 10,
  staleSeconds: number = DRIVER_STALE_SECONDS,
): Promise<ContextualRun[]> {
  const { results } = await db
    .prepare(
      `UPDATE contextual_runs SET status = 'running', updated_at = now()
        WHERE id IN (
          SELECT id FROM contextual_runs
           WHERE updated_at < now() - make_interval(secs => ?)
             AND (
               status = 'running'
               OR (status = 'parked'
                   AND span_cursor IS NOT NULL
                   AND (span_cursor ->> 'nextIndex')::int
                       < jsonb_array_length(span_cursor -> 'seeds'))
             )
           ORDER BY updated_at ASC
           LIMIT ?
        )
        RETURNING ${RUN_COLS}`,
    )
    .bind(staleSeconds, Math.max(1, Math.min(100, limit)))
    .all<RunRow>()
  return results.map(rowToRun)
}

// ──────────────────────────────────────────────────────────────────────────
// Project-wide fan-out
// ──────────────────────────────────────────────────────────────────────────

/** Key/value catalogs have no discourse to construe. IDML is also excluded:
 * its protected-anchor commit contract needs structured HTML that the current
 * contextual draft artifact does not carry. Mirrors the SPA predicate. */
const NON_DISCOURSE_KINDS = ["json", "po", "properties", "idml"]
/** Tabular files qualify only when they carry canonical Scripture refs
 *  (the SPA's `fileHasSections` test, expressed in SQL). */
const TABULAR_KINDS = new Set(["csv", "tsv", "xlsx"])

export interface AutopilotCandidateFile {
  fileId: string
  name: string
  kind: string
  untranslatedCells: number
}

export interface ActiveAutopilotRunFile {
  fileId: string
  runId: string
  status: Extract<ContextualRunStatus, "running" | "pausing" | "paused" | "parked">
  workQueued: boolean
}

/** Active default-lane files are still candidates (their staged drafts have
 * not changed target cells), but a project fan-out must not let them consume
 * its bounded batch. The active partial index makes this one row per file. */
export async function listActiveAutopilotRunFiles(
  db: AquillaDb,
  projectId: string,
): Promise<ActiveAutopilotRunFile[]> {
  const { results } = await db
    .prepare(
      `SELECT file_id, id, status,
              (status = 'parked' AND done_spans + failed_spans < total_spans) AS work_queued
         FROM contextual_runs
        WHERE project_id = ? AND target_lang = ''
          AND status IN ('running','pausing','paused','parked')
        ORDER BY file_id ASC`,
    )
    .bind(projectId)
    .all<{
      file_id: string
      id: string
      status: ActiveAutopilotRunFile["status"]
      work_queued: boolean
    }>()
  return results.map((row) => ({
    fileId: row.file_id,
    runId: row.id,
    status: row.status,
    workQueued: row.work_queued === true,
  }))
}

/**
 * Discourse files in this project with work left. Never-started files sort
 * ahead of retryable terminal files; retries then use least-recent attempt
 * first. A repeatedly failing high-volume file therefore cannot monopolize
 * every bounded project batch; work size only orders equal-attempt tiers.
 *
 * This is the unit that makes fan-out worth its overhead: one file is a chain
 * of spans, but a project is dozens of files that share nothing at all — no
 * briefs, no cells, no ordering. Whole books can run at once.
 */
export async function listAutopilotCandidateFiles(
  db: AquillaDb,
  projectId: string,
): Promise<AutopilotCandidateFile[]> {
  const placeholders = NON_DISCOURSE_KINDS.map(() => "?").join(",")
  const { results } = await db
    .prepare(
      `SELECT f.id, f.name, COALESCE(f.kind, '') AS kind,
              COUNT(*) FILTER (WHERE COALESCE(t.value, '') = '') AS untranslated,
              BOOL_OR(s.canonical_ref IS NOT NULL) AS has_refs
         FROM files f
         JOIN cells s
           ON s.project_id = f.project_id AND s.file_id = f.id
          AND s.side = 'source' AND s.target_lang = ''
         LEFT JOIN cells t
           ON t.project_id = s.project_id AND t.file_id = s.file_id
          AND t.cell_id = s.cell_id AND t.side = 'target' AND t.target_lang = ''
        WHERE f.project_id = ? AND f.deleted_at IS NULL
          AND COALESCE(f.kind, '') NOT IN (${placeholders})
        GROUP BY f.id, f.name, f.kind
       HAVING COUNT(*) FILTER (WHERE COALESCE(t.value, '') = '') > 0
        ORDER BY (
                   SELECT MAX(prior.created_at) FROM contextual_runs prior
                    WHERE prior.project_id = f.project_id
                      AND prior.file_id = f.id
                      AND prior.target_lang = ''
                 ) ASC NULLS FIRST,
                 untranslated DESC,
                 f.id ASC`,
    )
    .bind(projectId, ...NON_DISCOURSE_KINDS)
    .all<{ id: string; name: string; kind: string; untranslated: number; has_refs: boolean | null }>()

  return results
    .filter((r) => !TABULAR_KINDS.has(r.kind) || r.has_refs === true)
    .map((r) => ({
      fileId: r.id,
      name: r.name,
      kind: r.kind,
      untranslatedCells: Number(r.untranslated),
    }))
}

// ──────────────────────────────────────────────────────────────────────────
// Project-level rollup (PM observability)
// ──────────────────────────────────────────────────────────────────────────

export interface ProjectAutopilotFileRow {
  fileId: string
  /** Lane identity: the same file may have independent target-language runs. */
  targetLang: string
  runId: string
  status: ContextualRunStatus
  doneSpans: number
  totalSpans: number
  failedSpans: number
  unitsSpent: number
  proposedDrafts: number
  appliedDrafts: number
  updatedAt: string
  lastError: string | null
}

export interface ProjectAutopilotSummary {
  files: ProjectAutopilotFileRow[]
  activeRuns: number
  doneSpans: number
  totalSpans: number
  failedSpans: number
  unitsSpent: number
  proposedDrafts: number
  appliedDrafts: number
}

/**
 * One query per project for the overview: the newest run per file/language
 * lane plus draft counts attributable to that exact run. Project-level backlog
 * totals retain older DEFAULT-lane review work, so the compact actionable count
 * and `proposedOnly` drill-down cannot disagree. Legacy non-default rows remain
 * available through run history/activity as evidence, not editor actions.
 */
export async function getProjectAutopilotSummary(
  db: AquillaDb,
  projectId: string,
): Promise<ProjectAutopilotSummary> {
  const { results } = await db
    .prepare(
      `WITH newest AS (
         SELECT DISTINCT ON (file_id, target_lang)
                id, file_id, target_lang, status, done_spans, total_spans, failed_spans,
                units_spent, last_error, updated_at
          FROM contextual_runs
         WHERE project_id = ?
          ORDER BY file_id, target_lang, created_at DESC, id DESC
       ),
       drafts_by_run AS MATERIALIZED (
         SELECT d.run_id,
                COUNT(*) FILTER (WHERE d.status = 'proposed') AS proposed,
                COUNT(*) FILTER (WHERE d.status = 'applied')  AS applied
           FROM contextual_drafts d
           JOIN contextual_runs owner
             ON owner.id = d.run_id
            AND owner.project_id = d.project_id
            AND owner.file_id = d.file_id
            AND owner.target_lang = ''
          WHERE d.project_id = ?
          GROUP BY d.run_id
       ),
       project_drafts AS (
         SELECT COALESCE(SUM(proposed), 0) AS proposed,
                COALESCE(SUM(applied), 0) AS applied
           FROM drafts_by_run
       )
       SELECT n.*, COALESCE(d.proposed, 0) AS proposed,
              COALESCE(d.applied, 0) AS applied,
              COALESCE(p.proposed, 0) AS project_proposed,
              COALESCE(p.applied, 0) AS project_applied
         FROM newest n
         LEFT JOIN drafts_by_run d ON d.run_id = n.id
         CROSS JOIN project_drafts p
        ORDER BY n.updated_at DESC, n.id DESC`,
    )
    .bind(projectId, projectId)
    .all<{
      id: string
      file_id: string
      target_lang: string
      status: ContextualRunStatus
      done_spans: number
      total_spans: number
      failed_spans: number
      units_spent: number
      last_error: string | null
      updated_at: unknown
      proposed: number
      applied: number
      project_proposed: number
      project_applied: number
    }>()

  const files: ProjectAutopilotFileRow[] = results.map((r) => ({
    fileId: r.file_id,
    targetLang: r.target_lang,
    runId: r.id,
    status: r.status,
    doneSpans: Number(r.done_spans),
    totalSpans: Number(r.total_spans),
    failedSpans: Number(r.failed_spans),
    unitsSpent: Number(r.units_spent),
    proposedDrafts: Number(r.proposed),
    appliedDrafts: Number(r.applied),
    updatedAt: toIso(r.updated_at),
    // Summary rows bypass rowToRun, so keep the same legacy-read privacy
    // boundary here as snapshots/activity.
    lastError: sanitizeRunError(r.last_error),
  }))

  const sum = (pick: (f: ProjectAutopilotFileRow) => number) =>
    files.reduce((n, f) => n + pick(f), 0)
  return {
    files,
    activeRuns: files.filter((f) => ACTIVE_STATUSES.includes(f.status)).length,
    doneSpans: sum((f) => f.doneSpans),
    totalSpans: sum((f) => f.totalSpans),
    failedSpans: sum((f) => f.failedSpans),
    unitsSpent: sum((f) => f.unitsSpent),
    proposedDrafts: Number(results[0]?.project_proposed ?? 0),
    appliedDrafts: Number(results[0]?.project_applied ?? 0),
  }
}

/** Draft counts by status for the editor pill's lane-scoped snapshot. V1
 * callers omit targetLang and therefore read only the default lane. */
export async function countDrafts(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  targetLang = "",
): Promise<Record<ContextualDraftStatus, number>> {
  const { results } = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM contextual_drafts
        WHERE project_id = ? AND file_id = ?
          AND EXISTS (
            SELECT 1 FROM contextual_runs owner
             WHERE owner.id = contextual_drafts.run_id
               AND owner.project_id = contextual_drafts.project_id
               AND owner.file_id = contextual_drafts.file_id
               AND owner.target_lang = ?
          )
        GROUP BY status`,
    )
    .bind(projectId, fileId, targetLang)
    .all<{ status: ContextualDraftStatus; n: number }>()
  const out: Record<ContextualDraftStatus, number> = {
    proposed: 0,
    applied: 0,
    rejected: 0,
    superseded: 0,
  }
  for (const r of results) out[r.status] = Number(r.n)
  return out
}

/** Draft counts attributable to one run. Project id remains in the predicate
 * so a guessed globally unique run id cannot become a cross-tenant oracle. */
export async function countDraftsByRun(
  db: AquillaDb,
  projectId: string,
  runId: string,
): Promise<Record<ContextualDraftStatus, number>> {
  const { results } = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM contextual_drafts
        WHERE project_id = ? AND run_id = ?
        GROUP BY status`,
    )
    .bind(projectId, runId)
    .all<{ status: ContextualDraftStatus; n: number }>()
  const out: Record<ContextualDraftStatus, number> = {
    proposed: 0,
    applied: 0,
    rejected: 0,
    superseded: 0,
  }
  for (const r of results) out[r.status] = Number(r.n)
  return out
}
