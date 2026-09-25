// Shared style-rule library + applicability-graph domain logic (AQU-934;
// design: rule-applicability-design.md phase 2). Lives in db/shared/ so the
// auth-worker routes (routes/style-rules.ts) and any future server-side
// consumers (batch extraction, external Agent API) apply the SAME SQL
// primitives + row mapping with no forked implementation.
//
// Scope: this module owns the style_rules / rule_applicability SQL primitives
// (create-with-initial-rows / org-inherited project list / get / human edit /
// review / applicability upsert + delete) and the snake_case→camelCase row
// mapping that produces the wire shapes in src/lib/rules/style-rule-types.ts
// — the client-side contract. The enum lists here MUST stay in lock step with
// that file and with the CHECK constraints in db/postgres/schema.sql
// (0079_style_rules.sql). Identity + authorization (session JWT, project-role
// floors, org-row write refusal through project routes) stay in the caller —
// this module never touches HTTP.
//
// Takes the bare `AquillaDb` handle (db/shim/postgres.ts) — the same handle
// callers inject as `env.AQUILLA_PG`.

import type { AquillaDb } from "../shim/postgres"

// ──────────────────────────────────────────────────────────────────────────
// Enums (lock step: schema.sql CHECKs + src/lib/rules/style-rule-types.ts)
// ──────────────────────────────────────────────────────────────────────────

export const STYLE_RULE_CATEGORIES = [
  "terminology",
  "register",
  "formatting",
  "grammar",
  "orthography",
  "style",
  "other",
] as const
export type StyleRuleCategory = (typeof STYLE_RULE_CATEGORIES)[number]

export const STYLE_RULE_SCOPES = [
  "global",
  "genre",
  "document",
  "section",
  "passage",
  "segment",
] as const
export type StyleRuleScope = (typeof STYLE_RULE_SCOPES)[number]

export const STYLE_RULE_STATUSES = ["proposed", "approved", "rejected", "archived"] as const
export type StyleRuleStatus = (typeof STYLE_RULE_STATUSES)[number]

export const STYLE_RULE_SEVERITIES = ["major", "minor"] as const
export type StyleRuleSeverity = (typeof STYLE_RULE_SEVERITIES)[number]

export const APPLICABILITY_TARGET_TYPES = [
  "genre",
  "file",
  "book",
  "section",
  "passage",
  "segment",
] as const
export type ApplicabilityTargetType = (typeof APPLICABILITY_TARGET_TYPES)[number]

export const APPLICABILITY_RELATIONSHIPS = ["applies", "likely_applies", "excluded"] as const
export type ApplicabilityRelationship = (typeof APPLICABILITY_RELATIONSHIPS)[number]

export const APPLICABILITY_ASSIGNED_BY = ["human", "model", "inherited"] as const
export type ApplicabilityAssignedBy = (typeof APPLICABILITY_ASSIGNED_BY)[number]

// ──────────────────────────────────────────────────────────────────────────
// Wire shapes (camelCase — mirror src/lib/rules/style-rule-types.ts)
// ──────────────────────────────────────────────────────────────────────────

/** Citation back to the artifact a rule was extracted from. */
export type StyleRuleSource =
  | { kind: "knowledge-doc"; docId: string; nodeId?: string; quote?: string }
  | { kind: "manual" }
  | { kind: "edits" }

export interface StyleRuleExample {
  before?: string
  after?: string
  note?: string
}

/** Deterministic check payload (client type: RuleCheck). Stored opaquely as
 *  jsonb; the route boundary validates its shape, this module round-trips it. */
export type StyleRuleCheckSpec = { type: string } & Record<string, unknown>

export interface StyleRule {
  id: string
  /** Exactly one of orgId/projectId is set (org XOR project scope). */
  orgId: number | null
  projectId: string | null
  instruction: string
  category: StyleRuleCategory
  scope: StyleRuleScope
  conditions: string | null
  examples: StyleRuleExample[] | null
  exceptions: string | null
  source: StyleRuleSource | null
  checkSpec: StyleRuleCheckSpec | null
  severity: StyleRuleSeverity
  enabled: boolean
  status: StyleRuleStatus
  humanEdited: boolean
  provenance: Record<string, unknown> | null
  createdBy: string | null
  reviewedBy: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface RuleApplicability {
  id: string
  ruleId: string
  targetType: ApplicabilityTargetType
  /** genre name ("poetry") | fileId | bookCode ("PSA") | section label
   *  ("PSA 23") | canonicalRef range ("LUK 1:1-4") | cellId. */
  targetId: string
  relationship: ApplicabilityRelationship
  confidence: number | null
  reason: string | null
  assignedBy: ApplicabilityAssignedBy
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** Org XOR project owner of a rule (knowledge.ts KnowledgeScopeRef pattern —
 *  named "owner" here because rules also carry a `scope` ladder column). */
export type StyleRuleOwnerRef = { projectId: string } | { orgId: number }

// ──────────────────────────────────────────────────────────────────────────
// UUIDv7 (RFC 9562 §5.7) — time-ordered text ids (repo convention; same
// helper pattern as db/shared/contextual-runs.ts / scene-briefs.ts).
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

interface RuleRow {
  id: string
  org_id: number | null
  project_id: string | null
  instruction: string
  category: string
  scope: string
  conditions: string | null
  examples: unknown
  exceptions: string | null
  source: unknown
  check_spec: unknown
  severity: string
  enabled: boolean
  status: string
  human_edited: boolean
  provenance: unknown
  created_by: string | null
  reviewed_by: string | null
  version: number
  created_at: unknown
  updated_at: unknown
}

interface ApplicabilityRow {
  id: string
  rule_id: string
  target_type: string
  target_id: string
  relationship: string
  confidence: number | null
  reason: string | null
  assigned_by: string
  created_by: string | null
  created_at: unknown
  updated_at: unknown
}

const RULE_COLS = `id, org_id, project_id, instruction, category, scope, conditions,
  examples, exceptions, source, check_spec, severity, enabled, status, human_edited,
  provenance, created_by, reviewed_by, version, created_at, updated_at`

const APPL_COLS = `id, rule_id, target_type, target_id, relationship, confidence,
  reason, assigned_by, created_by, created_at, updated_at`

function toIso(v: unknown): string {
  if (v == null) return ""
  if (v instanceof Date) return v.toISOString()
  return new Date(v as string).toISOString()
}

/** JSONB comes back as an object from both postgres.js and PGlite; guard the
 *  rare case it arrives as a raw string (knowledge.ts parseTree pattern). */
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

function toJson(v: unknown): string | null {
  return v == null ? null : JSON.stringify(v)
}

function rowToRule(r: RuleRow): StyleRule {
  return {
    id: r.id,
    orgId: r.org_id == null ? null : Number(r.org_id),
    projectId: r.project_id,
    instruction: r.instruction,
    category: r.category as StyleRuleCategory,
    scope: r.scope as StyleRuleScope,
    conditions: r.conditions,
    examples: parseJson(r.examples) as StyleRuleExample[] | null,
    exceptions: r.exceptions,
    source: parseJson(r.source) as StyleRuleSource | null,
    checkSpec: parseJson(r.check_spec) as StyleRuleCheckSpec | null,
    severity: r.severity as StyleRuleSeverity,
    enabled: r.enabled === true,
    status: r.status as StyleRuleStatus,
    humanEdited: r.human_edited === true,
    provenance: parseJson(r.provenance) as Record<string, unknown> | null,
    createdBy: r.created_by,
    reviewedBy: r.reviewed_by,
    version: Number(r.version),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  }
}

function rowToApplicability(r: ApplicabilityRow): RuleApplicability {
  return {
    id: r.id,
    ruleId: r.rule_id,
    targetType: r.target_type as ApplicabilityTargetType,
    targetId: r.target_id,
    relationship: r.relationship as ApplicabilityRelationship,
    confidence: r.confidence == null ? null : Number(r.confidence),
    reason: r.reason,
    assignedBy: r.assigned_by as ApplicabilityAssignedBy,
    createdBy: r.created_by,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Create (rule + initial applicability rows, atomically)
// ──────────────────────────────────────────────────────────────────────────

export interface InitialApplicabilityInput {
  targetType: ApplicabilityTargetType
  targetId: string
  relationship: ApplicabilityRelationship
  confidence?: number | null
  reason?: string | null
  assignedBy: ApplicabilityAssignedBy
}

export interface CreateStyleRuleInput {
  owner: StyleRuleOwnerRef
  instruction: string
  category: StyleRuleCategory
  scope: StyleRuleScope
  conditions?: string | null
  examples?: StyleRuleExample[] | null
  exceptions?: string | null
  source?: StyleRuleSource | null
  checkSpec?: StyleRuleCheckSpec | null
  severity?: StyleRuleSeverity
  provenance?: Record<string, unknown> | null
  createdBy?: string | null
  applicability?: InitialApplicabilityInput[]
}

/** Dedupe initial rows on the (targetType, targetId) unique key — last one
 *  wins, matching upsert-replace semantics — so a duplicate in the payload
 *  cannot fail the whole insert batch on the UNIQUE constraint. */
function dedupeInitialRows(rows: InitialApplicabilityInput[]): InitialApplicabilityInput[] {
  const byKey = new Map<string, InitialApplicabilityInput>()
  for (const row of rows) byKey.set(`${row.targetType} ${row.targetId}`, row)
  return [...byKey.values()]
}

/**
 * Insert a rule (status forced 'proposed') plus its initial applicability
 * rows in ONE atomic batch — either the rule lands with all its rows or
 * nothing lands.
 */
export async function createRule(
  db: AquillaDb,
  input: CreateStyleRuleInput,
): Promise<{ rule: StyleRule; applicability: RuleApplicability[] }> {
  const orgId = "orgId" in input.owner ? input.owner.orgId : null
  const projectId = "projectId" in input.owner ? input.owner.projectId : null
  const ruleId = uuidv7()
  const initial = dedupeInitialRows(input.applicability ?? [])

  const stmts = [
    db
      .prepare(
        `INSERT INTO style_rules
            (id, org_id, project_id, instruction, category, scope, conditions,
             examples, exceptions, source, check_spec, severity, status,
             provenance, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb, ?::jsonb, ?, 'proposed', ?::jsonb, ?)
         RETURNING ${RULE_COLS}`,
      )
      .bind(
        ruleId,
        orgId,
        projectId,
        input.instruction,
        input.category,
        input.scope,
        input.conditions ?? null,
        toJson(input.examples),
        input.exceptions ?? null,
        toJson(input.source),
        toJson(input.checkSpec),
        input.severity ?? "minor",
        toJson(input.provenance),
        input.createdBy ?? null,
      ),
    ...initial.map((row) =>
      db
        .prepare(
          `INSERT INTO rule_applicability
              (id, rule_id, target_type, target_id, relationship, confidence,
               reason, assigned_by, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING ${APPL_COLS}`,
        )
        .bind(
          uuidv7(),
          ruleId,
          row.targetType,
          row.targetId,
          row.relationship,
          row.confidence ?? null,
          row.reason ?? null,
          row.assignedBy,
          input.createdBy ?? null,
        ),
    ),
  ]
  const results = await db.batch<Record<string, unknown>>(stmts)
  const ruleRow = results[0]?.results?.[0] as unknown as RuleRow | undefined
  if (!ruleRow) throw new Error("failed to insert style rule")
  const applicability = results
    .slice(1)
    .map((r) => rowToApplicability(r.results[0] as unknown as ApplicabilityRow))
  return { rule: rowToRule(ruleRow), applicability }
}

// ──────────────────────────────────────────────────────────────────────────
// Reads
// ──────────────────────────────────────────────────────────────────────────

/**
 * A project's own rules PLUS its org's shared rules (same org-inheritance
 * query shape as knowledge.ts listProjectDocs), with the applicability rows
 * covering exactly the returned rules.
 */
export async function listRulesForProject(
  db: AquillaDb,
  projectId: string,
  status?: StyleRuleStatus,
): Promise<{ rules: StyleRule[]; applicability: RuleApplicability[] }> {
  const ruleWhere = `(project_id = ? OR org_id = (SELECT org_id FROM projects WHERE id = ?))
       ${status ? "AND status = ?" : ""}`
  const ruleBinds = status ? [projectId, projectId, status] : [projectId, projectId]

  const rulesStmt = db
    .prepare(
      `SELECT ${RULE_COLS} FROM style_rules
        WHERE ${ruleWhere}
        ORDER BY created_at DESC, id DESC`,
    )
    .bind(...ruleBinds)
  const applStmt = db
    .prepare(
      `SELECT ${APPL_COLS} FROM rule_applicability
        WHERE rule_id IN (SELECT id FROM style_rules WHERE ${ruleWhere})
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(...ruleBinds)

  const [rulesRes, applRes] = await Promise.all([
    rulesStmt.all<RuleRow>(),
    applStmt.all<ApplicabilityRow>(),
  ])
  return {
    rules: rulesRes.results.map(rowToRule),
    applicability: applRes.results.map(rowToApplicability),
  }
}

export async function getRule(db: AquillaDb, id: string): Promise<StyleRule | null> {
  const row = await db
    .prepare(`SELECT ${RULE_COLS} FROM style_rules WHERE id = ?`)
    .bind(id)
    .first<RuleRow>()
  return row ? rowToRule(row) : null
}

// ──────────────────────────────────────────────────────────────────────────
// Human edit (PATCH)
// ──────────────────────────────────────────────────────────────────────────

export interface UpdateStyleRulePatch {
  instruction?: string
  category?: StyleRuleCategory
  scope?: StyleRuleScope
  conditions?: string | null
  examples?: StyleRuleExample[] | null
  exceptions?: string | null
  checkSpec?: StyleRuleCheckSpec | null
  severity?: StyleRuleSeverity
  enabled?: boolean
}

export type UpdateStyleRuleResult =
  | { status: "ok"; rule: StyleRule }
  | { status: "not_found" }
  | { status: "validation_failed"; message: string }

/**
 * Human edit of any editable subset: sets `human_edited=true` and bumps
 * `version` (agent-memory humanEdit pattern). Explicit `null` clears a
 * nullable column; omitted fields are untouched.
 */
export async function updateRule(
  db: AquillaDb,
  id: string,
  patch: UpdateStyleRulePatch,
): Promise<UpdateStyleRuleResult> {
  const sets: string[] = []
  const binds: unknown[] = []
  const set = (col: string, v: unknown): void => {
    sets.push(`${col} = ?`)
    binds.push(v)
  }
  const setJson = (col: string, v: unknown): void => {
    sets.push(`${col} = ?::jsonb`)
    binds.push(toJson(v))
  }
  if (patch.instruction !== undefined) set("instruction", patch.instruction)
  if (patch.category !== undefined) set("category", patch.category)
  if (patch.scope !== undefined) set("scope", patch.scope)
  if (patch.conditions !== undefined) set("conditions", patch.conditions)
  if (patch.examples !== undefined) setJson("examples", patch.examples)
  if (patch.exceptions !== undefined) set("exceptions", patch.exceptions)
  if (patch.checkSpec !== undefined) setJson("check_spec", patch.checkSpec)
  if (patch.severity !== undefined) set("severity", patch.severity)
  if (patch.enabled !== undefined) set("enabled", patch.enabled)
  if (sets.length === 0) {
    return { status: "validation_failed", message: "patch contains no editable fields" }
  }

  const row = await db
    .prepare(
      `UPDATE style_rules
          SET ${sets.join(", ")}, human_edited = true, version = version + 1, updated_at = now()
        WHERE id = ?
        RETURNING ${RULE_COLS}`,
    )
    .bind(...binds, id)
    .first<RuleRow>()
  if (!row) return { status: "not_found" }
  return { status: "ok", rule: rowToRule(row) }
}

// ──────────────────────────────────────────────────────────────────────────
// Review (approve / reject)
// ──────────────────────────────────────────────────────────────────────────

export interface ReviewStyleRuleInput {
  id: string
  action: "approve" | "reject"
  reviewedBy?: string | null
}

export type ReviewStyleRuleResult =
  | { status: "ok"; rule: StyleRule }
  | { status: "not_found" }
  | { status: "invalid_state"; message: string }

/** Approve or reject a `proposed` rule (agent_memories lifecycle — reviewing
 *  any other status is invalid). Sets `reviewed_by`. */
export async function reviewRule(
  db: AquillaDb,
  input: ReviewStyleRuleInput,
): Promise<ReviewStyleRuleResult> {
  const current = await getRule(db, input.id)
  if (!current) return { status: "not_found" }
  if (current.status !== "proposed") {
    return {
      status: "invalid_state",
      message: `rule is ${current.status}, only proposed rules can be reviewed`,
    }
  }
  const next = input.action === "approve" ? "approved" : "rejected"
  const row = await db
    .prepare(
      `UPDATE style_rules
          SET status = ?, reviewed_by = ?, updated_at = now()
        WHERE id = ? AND status = 'proposed'
        RETURNING ${RULE_COLS}`,
    )
    .bind(next, input.reviewedBy ?? null, input.id)
    .first<RuleRow>()
  if (!row) return { status: "not_found" }
  return { status: "ok", rule: rowToRule(row) }
}

// ──────────────────────────────────────────────────────────────────────────
// Applicability upsert / delete
// ──────────────────────────────────────────────────────────────────────────

export interface UpsertApplicabilityInput {
  ruleId: string
  targetType: ApplicabilityTargetType
  targetId: string
  relationship: ApplicabilityRelationship
  confidence?: number | null
  reason?: string | null
  assignedBy: ApplicabilityAssignedBy
  createdBy?: string | null
}

/**
 * UPSERT on the (rule_id, target_type, target_id) unique key: an existing row
 * keeps its identity (id, created_at, created_by) and has its payload
 * (relationship, confidence, reason, assigned_by) replaced.
 */
export async function upsertApplicability(
  db: AquillaDb,
  input: UpsertApplicabilityInput,
): Promise<RuleApplicability> {
  const row = await db
    .prepare(
      `INSERT INTO rule_applicability
          (id, rule_id, target_type, target_id, relationship, confidence,
           reason, assigned_by, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (rule_id, target_type, target_id) DO UPDATE
          SET relationship = EXCLUDED.relationship,
              confidence = EXCLUDED.confidence,
              reason = EXCLUDED.reason,
              assigned_by = EXCLUDED.assigned_by,
              updated_at = now()
       RETURNING ${APPL_COLS}`,
    )
    .bind(
      uuidv7(),
      input.ruleId,
      input.targetType,
      input.targetId,
      input.relationship,
      input.confidence ?? null,
      input.reason ?? null,
      input.assignedBy,
      input.createdBy ?? null,
    )
    .first<ApplicabilityRow>()
  if (!row) throw new Error("failed to upsert applicability row")
  return rowToApplicability(row)
}

/** Delete one applicability row (scoped to its rule). Returns false when no
 *  such row exists on that rule. */
export async function deleteApplicability(
  db: AquillaDb,
  ruleId: string,
  applicabilityId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`DELETE FROM rule_applicability WHERE id = ? AND rule_id = ? RETURNING id`)
    .bind(applicabilityId, ruleId)
    .first<{ id: string }>()
  return row != null
}
