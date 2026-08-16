// Contextual decisions — the agent → user channel (seam design §4.3).
//
// Lives in db/shared/ beside contextual-runs.ts so the routes AND the tick
// executor apply the SAME validation and parameterized SQL. Identity and
// authorization stay in the caller; this module never touches HTTP.
//
// Two invariants carry the design:
//   1. Routing is an ASSIGNMENT. An assigned decision is still `open`, so a
//      queue of unanswered questions can never report as handled work.
//   2. `superseded` and `expired` are distinct terminal states. Supersession is
//      the system working; expiry is the system stalling.

import type { AquillaDb } from "../shim/postgres"

export type DecisionStatus =
  | "open"
  | "researching"
  | "resolved"
  | "dismissed"
  | "superseded"
  | "expired"

export type DecisionReadinessItem =
  | "terminology"
  | "brief"
  | "examples"
  | "rules"
  | "languages"

export type DecisionResolution =
  | { kind: "answered"; answer: string; byUserId: number }
  | { kind: "researched"; memoryProposalId: string }

export interface ContextualDecision {
  id: string
  projectId: string
  runId: string | null
  fileId: string
  spanId: string | null
  cellIds: string[]
  reason: string
  readinessItem: DecisionReadinessItem | null
  conceptId: string | null
  blastRadius: number
  status: DecisionStatus
  assignedUserId: number | null
  assignedInviteId: string | null
  resolution: DecisionResolution | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface RaiseDecisionInput {
  projectId: string
  runId: string | null
  fileId: string
  spanId?: string | null
  cellIds?: string[]
  reason: string
  readinessItem?: DecisionReadinessItem | null
  conceptId?: string | null
  blastRadius?: number
}

/** How many open decisions a project surfaces at once (§4.6). Deliberately
 *  low: a supervisor allowed three open questions behaves very differently
 *  from one allowed thirty. Surplus stays open but unsurfaced — and is very
 *  likely to be superseded before anyone would have reached it. */
export const OPEN_DECISION_SURFACE_CAP = 3

/** A reason longer than this is not a question, it is a report. Reject rather
 *  than truncate: a card cut mid-sentence is worse than no card. */
export const DECISION_REASON_MAX_BYTES = 2000

const DECISION_COLS = `id, project_id, run_id, file_id, span_id, cell_ids, reason,
  readiness_item, concept_id, blast_radius, status, assigned_user_id,
  assigned_invite_id, resolution, created_at, updated_at, resolved_at`

/** uuidv7 — time-ordered, so lexicographic id order is creation order.
 *  Deliberately duplicated from contextual-runs.ts rather than cross-imported;
 *  these modules stay independently loadable. */
function uuidv7(): string {
  const ms = BigInt(Date.now())
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number((ms >> BigInt((5 - i) * 8)) & 0xffn)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

interface DecisionRow {
  id: string
  project_id: string
  run_id: string | null
  file_id: string
  span_id: string | null
  cell_ids: unknown
  reason: string
  readiness_item: string | null
  concept_id: string | null
  blast_radius: number
  status: string
  assigned_user_id: number | null
  assigned_invite_id: string | null
  resolution: unknown
  created_at: string | Date
  updated_at: string | Date
  resolved_at: string | Date | null
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

/** postgres.js (production) returns timestamptz as a string; PGlite (tests)
 *  returns it as a native Date. Deliberately duplicated from
 *  contextual-runs.ts rather than cross-imported, same as uuidv7 — these
 *  modules stay independently loadable. */
function toIso(v: unknown): string {
  if (v == null) return ""
  if (v instanceof Date) return v.toISOString()
  return new Date(v as string).toISOString()
}

function mapRow(row: DecisionRow): ContextualDecision {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    fileId: row.file_id,
    spanId: row.span_id,
    cellIds: parseJson<string[]>(row.cell_ids, []),
    reason: row.reason,
    readinessItem: (row.readiness_item as DecisionReadinessItem | null) ?? null,
    conceptId: row.concept_id,
    blastRadius: row.blast_radius,
    status: row.status as DecisionStatus,
    assignedUserId: row.assigned_user_id,
    assignedInviteId: row.assigned_invite_id,
    resolution: parseJson<DecisionResolution | null>(row.resolution, null),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    resolvedAt: row.resolved_at == null ? null : toIso(row.resolved_at),
  }
}

export async function raiseDecision(
  db: AquillaDb,
  input: RaiseDecisionInput,
): Promise<ContextualDecision> {
  const reason = input.reason.trim()
  if (!reason) throw new Error("decision reason is required")
  if (new TextEncoder().encode(reason).length > DECISION_REASON_MAX_BYTES) {
    throw new Error(`decision reason exceeds ${DECISION_REASON_MAX_BYTES} bytes`)
  }
  const row = await db
    .prepare(
      `INSERT INTO contextual_decisions
          (id, project_id, run_id, file_id, span_id, cell_ids, reason,
           readiness_item, concept_id, blast_radius)
       VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)
       RETURNING ${DECISION_COLS}`,
    )
    .bind(
      uuidv7(),
      input.projectId,
      input.runId,
      input.fileId,
      input.spanId ?? null,
      // Pass the structured array across the adapter boundary. postgres.js
      // learns the parameter's jsonb type from `?::jsonb` and applies its
      // own JSON serializer; pre-stringifying here would make that
      // serializer encode the string a second time, producing a jsonb
      // scalar instead of an array (contextual-runs.ts documents the same
      // trap; 0074's repair block exists because of it).
      input.cellIds ?? [],
      reason,
      input.readinessItem ?? null,
      input.conceptId ?? null,
      input.blastRadius ?? 0,
    )
    .first<DecisionRow>()
  if (!row) throw new Error("failed to raise decision")
  return mapRow(row)
}

export async function getDecision(
  db: AquillaDb,
  id: string,
): Promise<ContextualDecision | null> {
  const row = await db
    .prepare(`SELECT ${DECISION_COLS} FROM contextual_decisions WHERE id = ?`)
    .bind(id)
    .first<DecisionRow>()
  return row ? mapRow(row) : null
}

/** Ranked by blast radius, then oldest first (§4.6). Rows beyond `limit` stay
 *  open — they are held, not closed. */
export async function listOpenDecisions(
  db: AquillaDb,
  projectId: string,
  limit: number = OPEN_DECISION_SURFACE_CAP,
): Promise<ContextualDecision[]> {
  const { results } = await db
    .prepare(
      `SELECT ${DECISION_COLS} FROM contextual_decisions
        WHERE project_id = ? AND status IN ('open','researching')
        ORDER BY blast_radius DESC, created_at ASC
        LIMIT ?`,
    )
    .bind(projectId, limit)
    .all<DecisionRow>()
  return (results ?? []).map(mapRow)
}

export async function countOpenDecisions(
  db: AquillaDb,
  projectId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*)::int AS n FROM contextual_decisions
        WHERE project_id = ? AND status IN ('open','researching')`,
    )
    .bind(projectId)
    .first<{ n: number }>()
  return row?.n ?? 0
}
