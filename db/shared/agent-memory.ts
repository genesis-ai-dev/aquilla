// Shared agent-memory + project-brief domain logic (AQU-AGENT contracts §3,
// owner W1C). Lives in db/shared/ so BOTH the auth-worker routes
// (routes/agent-memory.ts) and the harness prompt-assembly path
// (auth-worker/src/lib/agent, owned by W1B) apply the SAME validation +
// parameterized SQL with no forked logic.
//
// Scope: this module owns validation rules, the memory/brief SQL primitives
// (create / list / get / review / human-edit / brief read-write / proposals),
// the autonomy policy predicates, and `buildMemoryContext`. Identity +
// authorization (session JWT, project-role floors, agent-channel header
// semantics) stay in the caller — the route resolves them via its Env-bound
// services (authMiddleware, resolveProjectRole) and this module never touches
// HTTP.
//
// Takes the bare `AquillaDb` handle (db/shim/postgres.ts) so it is callable
// from either the route or the harness — the same handle both inject as
// `env.AQUILLA_PG`.

import type { AquillaDb } from "../shim/postgres"

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type MemoryStatus = "proposed" | "approved" | "rejected" | "archived"

export interface MemoryProvenance {
  runId?: string
  sessionId?: string
  credentialId?: string
}

export interface AgentMemory {
  id: string
  projectId: string
  path: string
  content: string
  status: MemoryStatus
  humanEdited: boolean
  rationale: string | null
  provenance: MemoryProvenance | null
  createdBy: string | null
  reviewedBy: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface ProjectBrief {
  projectId: string
  content: string
  updatedBy: string | null
  /** 0 when no brief row exists yet (first PUT uses ifMatchVersion=0). */
  version: number
  updatedAt: string | null
}

export interface BriefProposal {
  id: string
  projectId: string
  content: string
  rationale: string | null
  status: "proposed" | "approved" | "rejected"
  createdBy: string | null
  reviewedBy: string | null
  /** Brief version this proposal was drafted against. null for legacy rows. */
  baseVersion: number | null
  createdAt: string
  reviewedAt: string | null
}

// ──────────────────────────────────────────────────────────────────────────
// Validation (contracts §2/§3)
// ──────────────────────────────────────────────────────────────────────────

/** A memory path is a lowercase, slash-nested markdown filename. */
export const MEMORY_PATH_RE = /^[a-z0-9-/]+\.md$/
/** Content ceiling — 10KB, measured in UTF-8 bytes. */
export const MEMORY_MAX_BYTES = 10 * 1024

/**
 * Secret-shaped substrings that must never land in memory. Named so a caller
 * can log WHICH pattern tripped without echoing the secret itself. `password`
 * is matched case-insensitively (a strengthening over the literal contract
 * regex — see AQU-AGENT-TRACES.md).
 */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "aquilla-token", re: /aqk_/ },
  { name: "openai-key", re: /sk-/ },
  { name: "pem-block", re: /-----BEGIN/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "password-assignment", re: /password\s*[:=]/i },
]

export type MemoryValidationError = { message: string }

/** UTF-8 byte length without allocating a full encoded copy where avoidable. */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

export function validateMemoryPath(path: string): MemoryValidationError | null {
  if (!MEMORY_PATH_RE.test(path)) {
    return { message: `invalid memory path "${path}" — must match ${MEMORY_PATH_RE}` }
  }
  return null
}

/** Returns the NAME of the first secret pattern matched, or null. */
export function detectSecret(content: string): string | null {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) return name
  }
  return null
}

export function validateMemoryContent(content: string): MemoryValidationError | null {
  const bytes = utf8Bytes(content)
  if (bytes > MEMORY_MAX_BYTES) {
    return { message: `memory content is ${bytes} bytes — exceeds the ${MEMORY_MAX_BYTES} byte limit` }
  }
  const secret = detectSecret(content)
  if (secret) {
    return { message: `memory content matched a forbidden secret pattern (${secret}) — remove credentials before saving` }
  }
  return null
}

// ──────────────────────────────────────────────────────────────────────────
// Autonomy policy (contracts §3 "Agent-channel enforcement")
// ──────────────────────────────────────────────────────────────────────────

export type AgentMemoryAutonomy = "human" | "agent-low-risk"

/**
 * Read the project's agent-memory autonomy from its settings JSON. Default is
 * `'human'` — the agent channel may propose but never review.
 */
export function readAgentMemoryAutonomy(
  settings: Record<string, unknown>,
): AgentMemoryAutonomy {
  return settings.agentMemoryAutonomy === "agent-low-risk" ? "agent-low-risk" : "human"
}

/**
 * Whether an AGENT-channel request may review (approve/reject) the memory at
 * `path`. Only when autonomy is 'agent-low-risk' AND the path is under
 * `observations/`. Human-channel review is governed by role, not this predicate.
 */
export function agentReviewAllowed(
  autonomy: AgentMemoryAutonomy,
  path: string,
): boolean {
  return autonomy === "agent-low-risk" && path.startsWith("observations/")
}

// ──────────────────────────────────────────────────────────────────────────
// Row mapping
// ──────────────────────────────────────────────────────────────────────────

interface MemoryRow {
  id: string
  project_id: string
  path: string
  content: string
  status: MemoryStatus
  human_edited: boolean
  rationale: string | null
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

function parseProvenance(v: unknown): MemoryProvenance | null {
  if (v == null) return null
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown
      return parsed && typeof parsed === "object" ? (parsed as MemoryProvenance) : null
    } catch {
      return null
    }
  }
  if (typeof v === "object") return v as MemoryProvenance
  return null
}

function rowToMemory(r: MemoryRow): AgentMemory {
  return {
    id: r.id,
    projectId: r.project_id,
    path: r.path,
    content: r.content,
    status: r.status,
    humanEdited: r.human_edited === true,
    rationale: r.rationale,
    provenance: parseProvenance(r.provenance),
    createdBy: r.created_by,
    reviewedBy: r.reviewed_by,
    version: Number(r.version),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  }
}

const MEMORY_COLS = `id, project_id, path, content, status, human_edited,
  rationale, provenance, created_by, reviewed_by, version, created_at, updated_at`

// ──────────────────────────────────────────────────────────────────────────
// Memory primitives
// ──────────────────────────────────────────────────────────────────────────

export interface CreateProposalInput {
  projectId: string
  path: string
  content: string
  rationale?: string | null
  provenance?: MemoryProvenance | null
  createdBy?: string | null
}

export type CreateProposalResult =
  | { status: "ok"; memory: AgentMemory }
  | { status: "validation_failed"; message: string }

/**
 * Validate + insert a `proposed` memory. Validation (path shape, size ceiling,
 * secret patterns) is applied here so route and harness enforce it identically.
 */
export async function createProposal(
  db: AquillaDb,
  input: CreateProposalInput,
): Promise<CreateProposalResult> {
  const pathErr = validateMemoryPath(input.path)
  if (pathErr) return { status: "validation_failed", message: pathErr.message }
  const contentErr = validateMemoryContent(input.content)
  if (contentErr) return { status: "validation_failed", message: contentErr.message }

  const id = crypto.randomUUID()
  const provenanceJson =
    input.provenance != null ? JSON.stringify(input.provenance) : null
  const row = await db
    .prepare(
      `INSERT INTO agent_memories
          (id, project_id, path, content, status, rationale, provenance, created_by)
       VALUES (?, ?, ?, ?, 'proposed', ?, ?::jsonb, ?)
       RETURNING ${MEMORY_COLS}`,
    )
    .bind(
      id,
      input.projectId,
      input.path,
      input.content,
      input.rationale ?? null,
      provenanceJson,
      input.createdBy ?? null,
    )
    .first<MemoryRow>()
  if (!row) return { status: "validation_failed", message: "failed to insert memory proposal" }
  return { status: "ok", memory: rowToMemory(row) }
}

export async function listMemories(
  db: AquillaDb,
  projectId: string,
  status?: MemoryStatus,
): Promise<AgentMemory[]> {
  const stmt = status
    ? db
        .prepare(
          `SELECT ${MEMORY_COLS} FROM agent_memories
            WHERE project_id = ? AND status = ?
            ORDER BY updated_at DESC`,
        )
        .bind(projectId, status)
    : db
        .prepare(
          `SELECT ${MEMORY_COLS} FROM agent_memories
            WHERE project_id = ?
            ORDER BY updated_at DESC`,
        )
        .bind(projectId)
  const { results } = await stmt.all<MemoryRow>()
  return results.map(rowToMemory)
}

export async function getMemory(db: AquillaDb, id: string): Promise<AgentMemory | null> {
  const row = await db
    .prepare(`SELECT ${MEMORY_COLS} FROM agent_memories WHERE id = ?`)
    .bind(id)
    .first<MemoryRow>()
  return row ? rowToMemory(row) : null
}

export interface ReviewMemoryInput {
  id: string
  action: "approve" | "reject"
  reviewedBy?: string | null
  /**
   * Human callers only. When approving would supersede a currently-approved row
   * that a human edited (`human_edited=true`), the caller must pass `true` to
   * confirm they intend to overwrite human-owned memory. The agent channel must
   * NEVER set this (the route forces it false and 403s if a supersede is needed)
   * — adversarial-panel B1/B2.
   */
  supersedeHumanEdited?: boolean
}

export type ReviewMemoryResult =
  | { status: "ok"; memory: AgentMemory }
  | { status: "not_found" }
  | { status: "invalid_state"; message: string }
  // Approving would archive a currently-approved, human-edited row and the
  // caller did not confirm the supersede. The route maps this to 409 (human) or
  // 403 (agent channel). `existing` identifies the human-edited holder.
  | { status: "supersedes_human_edited"; existing: { id: string; path: string } }

/**
 * Approve or reject a `proposed` memory. Approving supersedes any currently
 * approved row on the same (project, path) → 'archived' first (so the partial
 * UNIQUE index never conflicts), then flips this row to 'approved' — both in
 * one atomic batch. If the row being superseded was human-edited, the caller
 * must pass `supersedeHumanEdited: true` or the approve is refused
 * (adversarial-panel B1/B2 — never silently overwrite human-owned memory).
 */
export async function reviewMemory(
  db: AquillaDb,
  input: ReviewMemoryInput,
): Promise<ReviewMemoryResult> {
  const current = await getMemory(db, input.id)
  if (!current) return { status: "not_found" }
  if (current.status !== "proposed") {
    return {
      status: "invalid_state",
      message: `memory is ${current.status}, only proposed memories can be reviewed`,
    }
  }

  if (input.action === "approve") {
    // Guard: if a human-edited row currently holds this path, refuse to archive
    // it unless the caller explicitly confirmed the supersede.
    const holder = await db
      .prepare(
        `SELECT id, human_edited FROM agent_memories
          WHERE project_id = ? AND path = ? AND status = 'approved'
          LIMIT 1`,
      )
      .bind(current.projectId, current.path)
      .first<{ id: string; human_edited: boolean }>()
    if (holder && holder.human_edited === true && input.supersedeHumanEdited !== true) {
      return {
        status: "supersedes_human_edited",
        existing: { id: holder.id, path: current.path },
      }
    }
  }

  if (input.action === "reject") {
    const row = await db
      .prepare(
        `UPDATE agent_memories
            SET status = 'rejected', reviewed_by = ?, updated_at = now()
          WHERE id = ? AND status = 'proposed'
          RETURNING ${MEMORY_COLS}`,
      )
      .bind(input.reviewedBy ?? null, input.id)
      .first<MemoryRow>()
    if (!row) return { status: "not_found" }
    return { status: "ok", memory: rowToMemory(row) }
  }

  // approve: archive the current holder of this path (if any), then approve.
  await db.batch([
    db
      .prepare(
        `UPDATE agent_memories
            SET status = 'archived', updated_at = now()
          WHERE project_id = ? AND path = ? AND status = 'approved'`,
      )
      .bind(current.projectId, current.path),
    db
      .prepare(
        `UPDATE agent_memories
            SET status = 'approved', reviewed_by = ?, updated_at = now()
          WHERE id = ? AND status = 'proposed'`,
      )
      .bind(input.reviewedBy ?? null, input.id),
  ])
  const approved = await getMemory(db, input.id)
  if (!approved) return { status: "not_found" }
  return { status: "ok", memory: approved }
}

export interface HumanEditInput {
  id: string
  content: string
  editedBy?: string | null
}

export type HumanEditResult =
  | { status: "ok"; memory: AgentMemory }
  | { status: "not_found" }
  | { status: "validation_failed"; message: string }

/**
 * Human edit of a memory's content: sets `human_edited=true`, bumps `version`,
 * and records the editor as reviewer. Content is re-validated (size + secrets).
 * The agent channel can never reach a `human_edited=true` row (the route 403s
 * first) — this primitive itself is channel-agnostic.
 */
export async function humanEdit(
  db: AquillaDb,
  input: HumanEditInput,
): Promise<HumanEditResult> {
  const contentErr = validateMemoryContent(input.content)
  if (contentErr) return { status: "validation_failed", message: contentErr.message }

  const row = await db
    .prepare(
      `UPDATE agent_memories
          SET content = ?, human_edited = true, version = version + 1,
              reviewed_by = ?, updated_at = now()
        WHERE id = ?
        RETURNING ${MEMORY_COLS}`,
    )
    .bind(input.content, input.editedBy ?? null, input.id)
    .first<MemoryRow>()
  if (!row) return { status: "not_found" }
  return { status: "ok", memory: rowToMemory(row) }
}

// ──────────────────────────────────────────────────────────────────────────
// Project brief
// ──────────────────────────────────────────────────────────────────────────

interface BriefRow {
  project_id: string
  content: string
  updated_by: string | null
  version: number
  updated_at: unknown
}

function rowToBrief(r: BriefRow): ProjectBrief {
  return {
    projectId: r.project_id,
    content: r.content,
    updatedBy: r.updated_by,
    version: Number(r.version),
    updatedAt: r.updated_at == null ? null : toIso(r.updated_at),
  }
}

/** Read the brief. Returns empty content at version 0 when no row exists. */
export async function getBrief(db: AquillaDb, projectId: string): Promise<ProjectBrief> {
  const row = await db
    .prepare(
      `SELECT project_id, content, updated_by, version, updated_at
         FROM project_briefs WHERE project_id = ?`,
    )
    .bind(projectId)
    .first<BriefRow>()
  if (row) return rowToBrief(row)
  return { projectId, content: "", updatedBy: null, version: 0, updatedAt: null }
}

export interface PutBriefInput {
  projectId: string
  content: string
  ifMatchVersion: number
  updatedBy?: string | null
}

export type PutBriefResult =
  | { status: "ok"; brief: ProjectBrief }
  | { status: "conflict"; current: ProjectBrief }

/**
 * Version-guarded brief write. First write (no row) requires
 * `ifMatchVersion === 0` and INSERTs at version 1; subsequent writes require
 * the current version and UPDATE to version+1. Any mismatch → conflict.
 */
export async function putBrief(db: AquillaDb, input: PutBriefInput): Promise<PutBriefResult> {
  const current = await getBrief(db, input.projectId)
  if (input.ifMatchVersion !== current.version) {
    return { status: "conflict", current }
  }

  if (current.version === 0) {
    try {
      const row = await db
        .prepare(
          `INSERT INTO project_briefs (project_id, content, updated_by, version, updated_at)
           VALUES (?, ?, ?, 1, now())
           RETURNING project_id, content, updated_by, version, updated_at`,
        )
        .bind(input.projectId, input.content, input.updatedBy ?? null)
        .first<BriefRow>()
      if (!row) return { status: "conflict", current: await getBrief(db, input.projectId) }
      return { status: "ok", brief: rowToBrief(row) }
    } catch {
      // Racing first-writer inserted between our read and insert.
      return { status: "conflict", current: await getBrief(db, input.projectId) }
    }
  }

  // Snapshot the PRIOR content into history before overwriting it (keyed by the
  // version being replaced), then version-guarded update. Both in one atomic
  // batch so a history row never lands without its update, or vice-versa
  // (adversarial-panel mem-M2/M3). ON CONFLICT DO NOTHING makes a crash-retry
  // that re-snapshots the same version idempotent.
  const results = await db.batch<BriefRow>([
    db
      .prepare(
        `INSERT INTO project_brief_history (project_id, version, content, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, version) DO NOTHING`,
      )
      .bind(
        input.projectId,
        current.version,
        current.content,
        current.updatedBy ?? null,
        current.updatedAt ?? new Date().toISOString(),
      ),
    db
      .prepare(
        `UPDATE project_briefs
            SET content = ?, updated_by = ?, version = version + 1, updated_at = now()
          WHERE project_id = ? AND version = ?
          RETURNING project_id, content, updated_by, version, updated_at`,
      )
      .bind(input.content, input.updatedBy ?? null, input.projectId, input.ifMatchVersion),
  ])
  const row = results[1]?.results?.[0]
  if (!row) return { status: "conflict", current: await getBrief(db, input.projectId) }
  return { status: "ok", brief: rowToBrief(row) }
}

interface BriefProposalRow {
  id: string
  project_id: string
  content: string
  rationale: string | null
  status: "proposed" | "approved" | "rejected"
  created_by: string | null
  reviewed_by: string | null
  base_version: number | null
  created_at: unknown
  reviewed_at: unknown
}

function rowToBriefProposal(r: BriefProposalRow): BriefProposal {
  return {
    id: r.id,
    projectId: r.project_id,
    content: r.content,
    rationale: r.rationale,
    status: r.status,
    createdBy: r.created_by,
    reviewedBy: r.reviewed_by,
    baseVersion: r.base_version == null ? null : Number(r.base_version),
    createdAt: toIso(r.created_at),
    reviewedAt: r.reviewed_at == null ? null : toIso(r.reviewed_at),
  }
}

const BRIEF_PROPOSAL_COLS = `id, project_id, content, rationale, status,
  created_by, reviewed_by, base_version, created_at, reviewed_at`

export interface CreateBriefProposalInput {
  projectId: string
  content: string
  rationale?: string | null
  createdBy?: string | null
}

export async function createBriefProposal(
  db: AquillaDb,
  input: CreateBriefProposalInput,
): Promise<BriefProposal> {
  const id = crypto.randomUUID()
  // Stamp the brief version this proposal is drafted against so approve can
  // detect a human edit that landed in between (adversarial-panel mem-M2/M3).
  const current = await getBrief(db, input.projectId)
  const row = await db
    .prepare(
      `INSERT INTO project_brief_proposals
          (id, project_id, content, rationale, status, created_by, base_version)
       VALUES (?, ?, ?, ?, 'proposed', ?, ?)
       RETURNING ${BRIEF_PROPOSAL_COLS}`,
    )
    .bind(
      id,
      input.projectId,
      input.content,
      input.rationale ?? null,
      input.createdBy ?? null,
      current.version,
    )
    .first<BriefProposalRow>()
  if (!row) throw new Error("failed to insert brief proposal")
  return rowToBriefProposal(row)
}

export async function listBriefProposals(
  db: AquillaDb,
  projectId: string,
  status?: BriefProposal["status"],
): Promise<BriefProposal[]> {
  const stmt = status
    ? db
        .prepare(
          `SELECT ${BRIEF_PROPOSAL_COLS} FROM project_brief_proposals
            WHERE project_id = ? AND status = ? ORDER BY created_at DESC`,
        )
        .bind(projectId, status)
    : db
        .prepare(
          `SELECT ${BRIEF_PROPOSAL_COLS} FROM project_brief_proposals
            WHERE project_id = ? ORDER BY created_at DESC`,
        )
        .bind(projectId)
  const { results } = await stmt.all<BriefProposalRow>()
  return results.map(rowToBriefProposal)
}

export async function getBriefProposal(
  db: AquillaDb,
  id: string,
): Promise<BriefProposal | null> {
  const row = await db
    .prepare(`SELECT ${BRIEF_PROPOSAL_COLS} FROM project_brief_proposals WHERE id = ?`)
    .bind(id)
    .first<BriefProposalRow>()
  return row ? rowToBriefProposal(row) : null
}

export interface ReviewBriefProposalInput {
  id: string
  action: "approve" | "reject"
  reviewedBy?: string | null
}

export type ReviewBriefProposalResult =
  | { status: "ok"; proposal: BriefProposal; brief?: ProjectBrief }
  | { status: "not_found" }
  | { status: "invalid_state"; message: string }
  // Approving would clobber a human edit that landed after the proposal was
  // drafted (the brief advanced past base_version). Route → 409 conflict.
  | { status: "stale_base"; baseVersion: number | null; currentVersion: number }

/**
 * Approve or reject a brief proposal. Approving ALSO adopts the proposed
 * content into `project_briefs` (bumping the brief version) — that is the point
 * of a proposal. See AQU-AGENT-TRACES.md: the contract underspecifies whether
 * approve applies the brief; W1C chose apply-on-approve.
 *
 * Approve refuses if the brief has moved on since the proposal was drafted:
 * `currentBrief.version !== base_version` → stale_base (adversarial-panel
 * mem-M2/M3). Legacy proposals (base_version NULL) are treated as stale whenever
 * the brief has any content history (version > 0) — the safe default, since we
 * cannot prove they were drafted against the current version.
 */
export async function reviewBriefProposal(
  db: AquillaDb,
  input: ReviewBriefProposalInput,
): Promise<ReviewBriefProposalResult> {
  const current = await getBriefProposal(db, input.id)
  if (!current) return { status: "not_found" }
  if (current.status !== "proposed") {
    return {
      status: "invalid_state",
      message: `brief proposal is ${current.status}, only proposed can be reviewed`,
    }
  }

  // Staleness check (approve only): the brief must still be at the version this
  // proposal was drafted against.
  if (input.action === "approve") {
    const currentBrief = await getBrief(db, current.projectId)
    const stale =
      current.baseVersion == null
        ? currentBrief.version > 0
        : currentBrief.version !== current.baseVersion
    if (stale) {
      return {
        status: "stale_base",
        baseVersion: current.baseVersion,
        currentVersion: currentBrief.version,
      }
    }
  }

  const nextStatus = input.action === "approve" ? "approved" : "rejected"
  const row = await db
    .prepare(
      `UPDATE project_brief_proposals
          SET status = ?, reviewed_by = ?, reviewed_at = now()
        WHERE id = ? AND status = 'proposed'
        RETURNING ${BRIEF_PROPOSAL_COLS}`,
    )
    .bind(nextStatus, input.reviewedBy ?? null, input.id)
    .first<BriefProposalRow>()
  if (!row) return { status: "not_found" }
  const proposal = rowToBriefProposal(row)

  if (input.action === "reject") return { status: "ok", proposal }

  // apply-on-approve: adopt content into the brief at the current version.
  const currentBrief = await getBrief(db, current.projectId)
  const put = await putBrief(db, {
    projectId: current.projectId,
    content: current.content,
    ifMatchVersion: currentBrief.version,
    updatedBy: input.reviewedBy ?? null,
  })
  return {
    status: "ok",
    proposal,
    brief: put.status === "ok" ? put.brief : put.current,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// buildMemoryContext (consumed by W1B prompt assembly)
// ──────────────────────────────────────────────────────────────────────────

export interface MemoryIndexEntry {
  path: string
  firstLine: string
  /**
   * True when a human has edited this memory. Surfaced so the prompt can mark
   * the entry human-owned and the model is told not to silently re-propose over
   * it (adversarial-panel mem-M4). Content stays pure — this is metadata only.
   */
  humanEdited: boolean
}

export interface MemoryContext {
  /** The human-authored brief (verbatim). Empty string when unset. */
  brief: string
  /** One entry per approved memory: path + its first non-empty line. */
  memoryIndex: MemoryIndexEntry[]
  /** Full content of one approved memory by path, or null if none approved. */
  readMemory(path: string): Promise<string | null>
}

function firstLine(content: string): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ""
}

/**
 * Assemble the agent's memory context: the brief plus a lightweight index of
 * approved memories (path + first line), with a JIT `readMemory(path)` that
 * fetches full content only when the model asks. Pure reads — no writes.
 */
export async function buildMemoryContext(
  db: AquillaDb,
  projectId: string,
): Promise<MemoryContext> {
  // listMemories orders by updated_at DESC, so the index is most-recently-updated
  // first (adversarial-panel mem-m1 relies on this for the render cap).
  const brief = await getBrief(db, projectId)
  const approved = await listMemories(db, projectId, "approved")
  const memoryIndex: MemoryIndexEntry[] = approved.map((m) => ({
    path: m.path,
    firstLine: firstLine(m.content),
    humanEdited: m.humanEdited,
  }))

  return {
    brief: brief.content,
    memoryIndex,
    async readMemory(path: string): Promise<string | null> {
      const row = await db
        .prepare(
          `SELECT content FROM agent_memories
            WHERE project_id = ? AND path = ? AND status = 'approved'
            LIMIT 1`,
        )
        .bind(projectId, path)
        .first<{ content: string }>()
      return row ? row.content : null
    },
  }
}
