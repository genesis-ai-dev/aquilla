// Shared scene-brief domain logic (contextual translation pipeline design §9).
// Lives in db/shared/ so BOTH the auth-worker routes (routes/scene-briefs.ts)
// and the pipeline's node functions apply the SAME validation + parameterized
// SQL with no forked logic. Modeled closely on agent-memory.ts: proposed →
// approved → archived (superseded) / rejected lifecycle, 10KB content cap +
// secret-pattern scan, partial-UNIQUE supersede-on-approve.
//
// Scope: this module owns validation rules and the scene-brief SQL primitives
// (propose / list / get / review / update / markStale). Identity +
// authorization (session JWT, project-role floors, agent-channel header
// semantics) stay in the caller — the route resolves them via its Env-bound
// services and this module never touches HTTP.
//
// Takes the bare `AquillaDb` handle (db/shim/postgres.ts) so it is callable
// from either worker — the same handle both inject as `env.AQUILLA_PG`.

import type { AquillaDb } from "../shim/postgres"
import { MEMORY_MAX_BYTES, detectSecret } from "./agent-memory"

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type SceneBriefStatus = "proposed" | "approved" | "rejected" | "archived"

/** One open interpretive question the construal could not settle. */
export interface AmbiguityEntry {
  id: string
  question: string
  evidenceCellIds?: string[]
  note?: string
}

export interface SceneBriefProvenance {
  runId?: string
  spanSeedSource?: string
  closureRounds?: number
  windowCellIds?: string[]
}

export interface SceneBrief {
  id: string
  projectId: string
  fileId: string
  /** Endpoint cell UUIDs, never ordinals — membership = document order walk. */
  startCellId: string
  endCellId: string
  targetLang: string
  /** L2: situation/participants/tenor/moves markdown. */
  construal: string
  ambiguityRegister: AmbiguityEntry[]
  /** Condensed L1 summary (≤1600 chars) injected into draft prompts. */
  l1Summary: string | null
  l1GeneratedAt: string | null
  l1ModelId: string | null
  status: SceneBriefStatus
  humanEdited: boolean
  /** Instant staleness marker; null = fresh. Re-work is debounced elsewhere. */
  staleSince: string | null
  staleReason: string | null
  provenance: SceneBriefProvenance | null
  createdBy: string | null
  reviewedBy: string | null
  version: number
  createdAt: string
  updatedAt: string
}

// ──────────────────────────────────────────────────────────────────────────
// Validation — same ceilings as agent memory (design §9: "10KB-per-row cap
// and secret-pattern scan mirrored from MEMORY_MAX_BYTES").
// ──────────────────────────────────────────────────────────────────────────

/** Content ceiling — 10KB across construal + L1 + ambiguity register (UTF-8). */
export const SCENE_BRIEF_MAX_BYTES = MEMORY_MAX_BYTES
/** L1 summary budget (design §9 — stated + hard-truncated char budget). */
export const L1_SUMMARY_MAX_CHARS = 1600

export type SceneBriefValidationError = { message: string }

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

interface ContentFields {
  construal: string
  ambiguityRegister: AmbiguityEntry[]
  l1Summary?: string | null
}

/**
 * Validate the brief's textual payload: combined 10KB byte cap, the L1 char
 * budget, and the shared secret-pattern scan across every text-bearing field.
 * Applied here so route and pipeline enforce it identically.
 */
export function validateSceneBriefContent(
  fields: ContentFields,
): SceneBriefValidationError | null {
  const registerJson = JSON.stringify(fields.ambiguityRegister)
  const l1 = fields.l1Summary ?? ""
  if (l1.length > L1_SUMMARY_MAX_CHARS) {
    return { message: `l1Summary is ${l1.length} chars — exceeds the ${L1_SUMMARY_MAX_CHARS} char budget` }
  }
  const bytes = utf8Bytes(fields.construal) + utf8Bytes(registerJson) + utf8Bytes(l1)
  if (bytes > SCENE_BRIEF_MAX_BYTES) {
    return { message: `scene brief content is ${bytes} bytes — exceeds the ${SCENE_BRIEF_MAX_BYTES} byte limit` }
  }
  const secret = detectSecret(`${fields.construal}\n${registerJson}\n${l1}`)
  if (secret) {
    return { message: `scene brief content matched a forbidden secret pattern (${secret}) — remove credentials before saving` }
  }
  return null
}

// ──────────────────────────────────────────────────────────────────────────
// UUIDv7 (RFC 9562 §5.7) — time-ordered ids, matching the outbox convention.
// db/shared/ has no `uuid` package (same situation as sync-worker/src/external).
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

interface SceneBriefRow {
  id: string
  project_id: string
  file_id: string
  start_cell_id: string
  end_cell_id: string
  target_lang: string
  construal: string
  ambiguity_register: unknown
  l1_summary: string | null
  l1_generated_at: unknown
  l1_model_id: string | null
  status: SceneBriefStatus
  human_edited: boolean
  stale_since: unknown
  stale_reason: string | null
  provenance: unknown
  created_by: string | null
  reviewed_by: string | null
  version: number
  created_at: unknown
  updated_at: unknown
}

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

function parseRegister(v: unknown): AmbiguityEntry[] {
  const parsed = parseJson(v)
  return Array.isArray(parsed) ? (parsed as AmbiguityEntry[]) : []
}

function parseProvenance(v: unknown): SceneBriefProvenance | null {
  const parsed = parseJson(v)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as SceneBriefProvenance)
    : null
}

function rowToBrief(r: SceneBriefRow): SceneBrief {
  return {
    id: r.id,
    projectId: r.project_id,
    fileId: r.file_id,
    startCellId: r.start_cell_id,
    endCellId: r.end_cell_id,
    targetLang: r.target_lang,
    construal: r.construal,
    ambiguityRegister: parseRegister(r.ambiguity_register),
    l1Summary: r.l1_summary,
    l1GeneratedAt: r.l1_generated_at == null ? null : toIso(r.l1_generated_at),
    l1ModelId: r.l1_model_id,
    status: r.status,
    humanEdited: r.human_edited === true,
    staleSince: r.stale_since == null ? null : toIso(r.stale_since),
    staleReason: r.stale_reason,
    provenance: parseProvenance(r.provenance),
    createdBy: r.created_by,
    reviewedBy: r.reviewed_by,
    version: Number(r.version),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  }
}

const BRIEF_COLS = `id, project_id, file_id, start_cell_id, end_cell_id, target_lang,
  construal, ambiguity_register, l1_summary, l1_generated_at, l1_model_id, status,
  human_edited, stale_since, stale_reason, provenance, created_by, reviewed_by,
  version, created_at, updated_at`

// ──────────────────────────────────────────────────────────────────────────
// Primitives
// ──────────────────────────────────────────────────────────────────────────

export interface ProposeSceneBriefInput {
  projectId: string
  fileId: string
  startCellId: string
  endCellId: string
  targetLang?: string
  construal: string
  ambiguityRegister?: AmbiguityEntry[]
  l1Summary?: string | null
  l1ModelId?: string | null
  provenance?: SceneBriefProvenance | null
  createdBy?: string | null
}

export type ProposeSceneBriefResult =
  | { status: "ok"; brief: SceneBrief }
  | { status: "validation_failed"; message: string }

/**
 * Validate + insert a `proposed` scene brief (CONTRIBUTOR-level caller — the
 * route enforces the floor). An L1 summary provided at propose time stamps
 * `l1_generated_at` so staleness (`updated_at > l1_generated_at`) is derivable.
 */
export async function proposeSceneBrief(
  db: AquillaDb,
  input: ProposeSceneBriefInput,
): Promise<ProposeSceneBriefResult> {
  const register = input.ambiguityRegister ?? []
  const err = validateSceneBriefContent({
    construal: input.construal,
    ambiguityRegister: register,
    l1Summary: input.l1Summary,
  })
  if (err) return { status: "validation_failed", message: err.message }

  const row = await db
    .prepare(
      `INSERT INTO scene_briefs
          (id, project_id, file_id, start_cell_id, end_cell_id, target_lang,
           construal, ambiguity_register, l1_summary, l1_generated_at,
           l1_model_id, status, provenance, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, 'proposed', ?::jsonb, ?)
       RETURNING ${BRIEF_COLS}`,
    )
    .bind(
      uuidv7(),
      input.projectId,
      input.fileId,
      input.startCellId,
      input.endCellId,
      input.targetLang ?? "",
      input.construal,
      JSON.stringify(register),
      input.l1Summary ?? null,
      input.l1Summary != null ? new Date().toISOString() : null,
      input.l1ModelId ?? null,
      input.provenance != null ? JSON.stringify(input.provenance) : null,
      input.createdBy ?? null,
    )
    .first<SceneBriefRow>()
  if (!row) return { status: "validation_failed", message: "failed to insert scene brief" }
  return { status: "ok", brief: rowToBrief(row) }
}

export interface ListSceneBriefsFilter {
  fileId?: string
  status?: SceneBriefStatus
}

export async function listSceneBriefs(
  db: AquillaDb,
  projectId: string,
  filter: ListSceneBriefsFilter = {},
): Promise<SceneBrief[]> {
  const where = ["project_id = ?"]
  const binds: unknown[] = [projectId]
  if (filter.fileId) {
    where.push("file_id = ?")
    binds.push(filter.fileId)
  }
  if (filter.status) {
    where.push("status = ?")
    binds.push(filter.status)
  }
  const { results } = await db
    .prepare(
      `SELECT ${BRIEF_COLS} FROM scene_briefs
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC`,
    )
    .bind(...binds)
    .all<SceneBriefRow>()
  return results.map(rowToBrief)
}

export async function getSceneBrief(db: AquillaDb, id: string): Promise<SceneBrief | null> {
  const row = await db
    .prepare(`SELECT ${BRIEF_COLS} FROM scene_briefs WHERE id = ?`)
    .bind(id)
    .first<SceneBriefRow>()
  return row ? rowToBrief(row) : null
}

export interface ReviewSceneBriefInput {
  id: string
  action: "approve" | "reject"
  reviewedBy?: string | null
}

export type ReviewSceneBriefResult =
  | { status: "ok"; brief: SceneBrief }
  | { status: "not_found" }
  | { status: "invalid_state"; message: string }

/**
 * Approve or reject a `proposed` scene brief. Approving supersedes any
 * currently approved row on the same span key (project, file, start, end,
 * target_lang) → 'archived' first (so the partial UNIQUE index never
 * conflicts), then flips this row to 'approved' — both in one atomic batch.
 */
export async function reviewSceneBrief(
  db: AquillaDb,
  input: ReviewSceneBriefInput,
): Promise<ReviewSceneBriefResult> {
  const current = await getSceneBrief(db, input.id)
  if (!current) return { status: "not_found" }
  if (current.status !== "proposed") {
    return {
      status: "invalid_state",
      message: `scene brief is ${current.status}, only proposed briefs can be reviewed`,
    }
  }

  if (input.action === "reject") {
    const row = await db
      .prepare(
        `UPDATE scene_briefs
            SET status = 'rejected', reviewed_by = ?, updated_at = now()
          WHERE id = ? AND status = 'proposed'
          RETURNING ${BRIEF_COLS}`,
      )
      .bind(input.reviewedBy ?? null, input.id)
      .first<SceneBriefRow>()
    if (!row) return { status: "not_found" }
    return { status: "ok", brief: rowToBrief(row) }
  }

  // approve: archive the current holder of this span key (if any), then approve.
  await db.batch([
    db
      .prepare(
        `UPDATE scene_briefs
            SET status = 'archived', updated_at = now()
          WHERE project_id = ? AND file_id = ? AND start_cell_id = ?
            AND end_cell_id = ? AND target_lang = ? AND status = 'approved'`,
      )
      .bind(current.projectId, current.fileId, current.startCellId, current.endCellId, current.targetLang),
    db
      .prepare(
        `UPDATE scene_briefs
            SET status = 'approved', reviewed_by = ?, updated_at = now()
          WHERE id = ? AND status = 'proposed'`,
      )
      .bind(input.reviewedBy ?? null, input.id),
  ])
  const approved = await getSceneBrief(db, input.id)
  if (!approved) return { status: "not_found" }
  return { status: "ok", brief: approved }
}

export interface UpdateSceneBriefInput {
  id: string
  /** Per-row optimistic concurrency — a conflict scopes to one scene (§9). */
  ifMatchVersion: number
  construal?: string
  ambiguityRegister?: AmbiguityEntry[]
  l1Summary?: string | null
  l1ModelId?: string | null
  editedBy?: string | null
}

export type UpdateSceneBriefResult =
  | { status: "ok"; brief: SceneBrief }
  | { status: "not_found" }
  | { status: "validation_failed"; message: string }
  | { status: "conflict"; currentVersion: number }

/**
 * Human edit of a scene brief with per-row `ifMatchVersion` optimistic
 * concurrency: sets `human_edited=true`, bumps `version`, records the editor
 * as reviewer, and clears staleness (the human just re-authored the content).
 * Merged content is re-validated (size + secrets). The agent channel can never
 * reach this (the route 403s first) — the primitive itself is channel-agnostic.
 */
export async function updateSceneBrief(
  db: AquillaDb,
  input: UpdateSceneBriefInput,
): Promise<UpdateSceneBriefResult> {
  const current = await getSceneBrief(db, input.id)
  if (!current) return { status: "not_found" }
  if (input.ifMatchVersion !== current.version) {
    return { status: "conflict", currentVersion: current.version }
  }

  const next = {
    construal: input.construal ?? current.construal,
    ambiguityRegister: input.ambiguityRegister ?? current.ambiguityRegister,
    l1Summary: input.l1Summary !== undefined ? input.l1Summary : current.l1Summary,
  }
  const err = validateSceneBriefContent(next)
  if (err) return { status: "validation_failed", message: err.message }

  // Version-guarded write — a racing edit between our read and this UPDATE
  // loses the guard and reports conflict rather than silently clobbering.
  const row = await db
    .prepare(
      `UPDATE scene_briefs
          SET construal = ?, ambiguity_register = ?::jsonb, l1_summary = ?,
              l1_model_id = ?, human_edited = true, stale_since = NULL,
              stale_reason = NULL, version = version + 1, reviewed_by = ?,
              updated_at = now()
        WHERE id = ? AND version = ?
        RETURNING ${BRIEF_COLS}`,
    )
    .bind(
      next.construal,
      JSON.stringify(next.ambiguityRegister),
      next.l1Summary ?? null,
      input.l1ModelId !== undefined ? input.l1ModelId : current.l1ModelId,
      input.editedBy ?? null,
      input.id,
      input.ifMatchVersion,
    )
    .first<SceneBriefRow>()
  if (!row) {
    const latest = await getSceneBrief(db, input.id)
    if (!latest) return { status: "not_found" }
    return { status: "conflict", currentVersion: latest.version }
  }
  return { status: "ok", brief: rowToBrief(row) }
}

export type MarkStaleResult =
  | { status: "ok"; brief: SceneBrief }
  | { status: "not_found" }

/**
 * Instant staleness marker (design §8 "marking is instant, re-work is
 * debounced"). Idempotent: an already-stale brief keeps its original
 * `stale_since` (oldest-first maintenance ordering depends on it) but the
 * reason is refreshed to the latest trigger. Does NOT bump `version` — the
 * content didn't change, only its freshness.
 */
export async function markStale(
  db: AquillaDb,
  id: string,
  reason: string,
): Promise<MarkStaleResult> {
  const row = await db
    .prepare(
      `UPDATE scene_briefs
          SET stale_since = COALESCE(stale_since, now()), stale_reason = ?,
              updated_at = now()
        WHERE id = ?
        RETURNING ${BRIEF_COLS}`,
    )
    .bind(reason, id)
    .first<SceneBriefRow>()
  if (!row) return { status: "not_found" }
  return { status: "ok", brief: rowToBrief(row) }
}
