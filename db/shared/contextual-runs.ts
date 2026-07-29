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
    lastError: r.last_error,
    steeringCursor: r.steering_cursor == null ? null : toIso(r.steering_cursor),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  }
}

const RUN_COLS = `id, project_id, file_id, target_lang, status, initiated_by, role_snapshot,
  span_cursor, done_spans, total_spans, failed_spans, units_spent, calls_spent,
  last_error, steering_cursor, created_at, updated_at`

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

// ──────────────────────────────────────────────────────────────────────────
// Runs
// ──────────────────────────────────────────────────────────────────────────

export interface CreateRunInput {
  projectId: string
  fileId: string
  targetLang?: string
  initiatedBy?: string | null
  roleSnapshot?: RoleSnapshot | null
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
        `INSERT INTO contextual_runs (id, project_id, file_id, target_lang, status, initiated_by, role_snapshot)
         VALUES (?, ?, ?, ?, 'running', ?, ?::jsonb)
         RETURNING ${RUN_COLS}`,
      )
      .bind(
        uuidv7(),
        input.projectId,
        input.fileId,
        lane,
        input.initiatedBy ?? null,
        input.roleSnapshot ? JSON.stringify(input.roleSnapshot) : null,
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

export async function listRuns(
  db: AquillaDb,
  projectId: string,
  fileId?: string,
): Promise<ContextualRun[]> {
  const where = ["project_id = ?"]
  const binds: unknown[] = [projectId]
  if (fileId) {
    where.push("file_id = ?")
    binds.push(fileId)
  }
  const { results } = await db
    .prepare(
      `SELECT ${RUN_COLS} FROM contextual_runs
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC`,
    )
    .bind(...binds)
    .all<RunRow>()
  return results.map(rowToRun)
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
  const row = await db
    .prepare(
      `UPDATE contextual_runs
          SET status = ?, last_error = COALESCE(?, last_error), updated_at = now()
        WHERE id = ? AND status IN (${placeholders})
        RETURNING ${RUN_COLS}`,
    )
    .bind(to, lastError ?? null, runId, ...from)
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
  transitionRun(db, runId, [...ACTIVE_STATUSES], "failed", error.slice(0, 2000))

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
    .bind(JSON.stringify(cursor), cursor.seeds.length, runId)
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

/** Record one span's outcome: cursor advance + counters in ONE UPDATE, so a
 *  crash between "span worked" and "cursor advanced" can only replay a span,
 *  never skip one. */
export async function recordSpanOutcome(
  db: AquillaDb,
  runId: string,
  input: SpanOutcomeInput,
): Promise<ContextualRun | null> {
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
      JSON.stringify(input.cursor),
      input.cursor.seeds.length,
      input.outcome === "done" ? 1 : 0,
      input.outcome === "failed" ? 1 : 0,
      Math.max(0, Math.round(input.unitsUsed)),
      Math.max(0, Math.round(input.callsUsed)),
      input.lastError ?? null,
      input.steeringCursor ?? null,
      runId,
    )
    .first<RunRow>()
  return row ? rowToRun(row) : null
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

/** Stage span drafts. A new proposal supersedes any existing `proposed` row on
 *  the same cell — the supersede UPDATE and the INSERTs run in one atomic
 *  batch, so the partial UNIQUE (contextual_drafts_live) never conflicts. */
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)`,
        )
        .bind(
          uuidv7(),
          input.runId,
          input.projectId,
          input.fileId,
          d.cellId,
          input.sceneBriefId ?? null,
          d.text,
          d.verdicts ? JSON.stringify(d.verdicts) : null,
          d.provenance ? JSON.stringify(d.provenance) : null,
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
): Promise<ContextualDraft[]> {
  const where = ["project_id = ?", "file_id = ?"]
  const binds: unknown[] = [projectId, fileId]
  if (status) {
    where.push("status = ?")
    binds.push(status)
  }
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

export type ReviewDraftResult =
  | { status: "ok"; draft: ContextualDraft }
  | { status: "not_found" }
  | { status: "invalid_state"; current: ContextualDraftStatus }

/** Review handshake: the client applies through its own outbox, then reports
 *  'applied' (or 'rejected'). Only a `proposed` draft can be reviewed. */
export async function reviewDraft(
  db: AquillaDb,
  input: { id: string; action: "applied" | "rejected"; reviewedBy?: string | null },
): Promise<ReviewDraftResult> {
  const row = await db
    .prepare(
      `UPDATE contextual_drafts
          SET status = ?, reviewed_at = now(), reviewed_by = ?
        WHERE id = ? AND status = 'proposed'
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
  return { status: "invalid_state", current: current.status }
}

/** Draft counts by status for the pill's snapshot. */
export async function countDrafts(
  db: AquillaDb,
  projectId: string,
  fileId: string,
): Promise<Record<ContextualDraftStatus, number>> {
  const { results } = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM contextual_drafts
        WHERE project_id = ? AND file_id = ?
        GROUP BY status`,
    )
    .bind(projectId, fileId)
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
