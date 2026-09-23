// Style-rule library + applicability HTTP surface (AQU-934 phase 2; design:
// rule-applicability-design.md). Mounted at /api/v2/projects in src/index.ts
// (sibling to agent-memory / knowledge). All endpoints sit behind
// authMiddleware (browser session JWT); project-role floors are resolved live
// via resolveProjectRole (agent-memory pattern):
//   GET any project member (VIEWER+) — includes inherited org rows
//   POST CONTRIBUTOR+ (status forced 'proposed')
//   PATCH / review / applicability writes PROJECT_LEAD+
// Org-scoped rules are READ-ONLY through the project routes — writes get 403
// permission_denied (knowledge.ts precedent). Error envelope:
// `{ error: { code, message } }`.

import { Hono, type Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import {
  APPLICABILITY_ASSIGNED_BY,
  APPLICABILITY_RELATIONSHIPS,
  APPLICABILITY_TARGET_TYPES,
  STYLE_RULE_CATEGORIES,
  STYLE_RULE_SCOPES,
  STYLE_RULE_SEVERITIES,
  STYLE_RULE_STATUSES,
  createRule,
  deleteApplicability,
  getRule,
  listRulesForProject,
  reviewRule,
  updateRule,
  upsertApplicability,
  type StyleRule,
  type StyleRuleStatus,
} from "../../../db/shared/style-rules"

const styleRules = new Hono<AuthHonoEnv>()

type ErrorCode = "not_found" | "permission_denied" | "validation_failed"

function errorJson(code: ErrorCode, message: string, status: ContentfulStatusCode) {
  return { body: { error: { code, message } }, status } as const
}

/** Resolve the caller's live role floor on a project; null/below floor → 403. */
async function requireRole(
  c: Context<AuthHonoEnv>,
  projectId: string,
  floor: number,
): Promise<{ ok: true } | { ok: false; res: Response }> {
  const user = c.get("user")
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role || role.level < floor) {
    const { body, status } = errorJson(
      "permission_denied",
      "you do not have sufficient access on this project",
      403,
    )
    return { ok: false, res: c.json(body, status) }
  }
  return { ok: true }
}

/** zValidator that maps schema failures onto the shared error envelope. */
function jsonValid<T extends z.ZodTypeAny>(schema: T) {
  return zValidator("json", schema, (result, c) => {
    if (!result.success) {
      const issue = result.error.issues[0]
      const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""
      const { body, status } = errorJson(
        "validation_failed",
        `invalid request body${where}: ${issue?.message ?? "validation failed"}`,
        400,
      )
      return c.json(body, status)
    }
  })
}

/**
 * A rule is visible from a project when it belongs to it or to its org
 * (knowledge.ts projectVisibleDoc pattern). Org rows are readable but never
 * writable through the project routes.
 */
async function projectVisibleRule(
  c: Context<AuthHonoEnv>,
  projectId: string,
  ruleId: string,
): Promise<{ rule: StyleRule; ownedByOrg: boolean } | null> {
  const rule = await getRule(c.env.AQUILLA_PG, ruleId)
  if (!rule) return null
  if (rule.projectId === projectId) return { rule, ownedByOrg: false }
  if (rule.orgId != null) {
    const row = await c.env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ org_id: number | null }>()
    if (row?.org_id != null && row.org_id === rule.orgId) return { rule, ownedByOrg: true }
  }
  return null
}

/** Resolve a rule for a WRITE: 404 when not visible from this project, 403
 *  when it is an org row (read-only through project routes). */
async function requireWritableRule(
  c: Context<AuthHonoEnv>,
  projectId: string,
  ruleId: string,
): Promise<{ ok: true; rule: StyleRule } | { ok: false; res: Response }> {
  const visible = await projectVisibleRule(c, projectId, ruleId)
  if (!visible) {
    const { body, status } = errorJson("not_found", `style rule ${ruleId} not found`, 404)
    return { ok: false, res: c.json(body, status) }
  }
  if (visible.ownedByOrg) {
    const { body, status } = errorJson(
      "permission_denied",
      "org rules are managed at the org level",
      403,
    )
    return { ok: false, res: c.json(body, status) }
  }
  return { ok: true, rule: visible.rule }
}

// ──────────────────────────────────────────────────────────────────────────
// Schemas (enums in lock step with the SQL CHECK lists / style-rule-types.ts)
// ──────────────────────────────────────────────────────────────────────────

const exampleSchema = z.object({
  before: z.string().optional(),
  after: z.string().optional(),
  note: z.string().optional(),
})

const sourceSchema = z.union([
  z.object({
    kind: z.literal("knowledge-doc"),
    docId: z.string().min(1),
    nodeId: z.string().optional(),
    quote: z.string().optional(),
  }),
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("edits") }),
])

// RuleCheck union (src/lib/parsers/types.ts) — `builtin` ids are validated
// structurally, not against the client's builtin list, so the server never
// lags a client-side addition.
const checkSpecSchema = z.union([
  z.object({
    type: z.literal("source-requires-target"),
    sourcePattern: z.string(),
    targetPattern: z.string(),
  }),
  z.object({ type: z.literal("target-forbids"), targetPattern: z.string() }),
  z.object({ type: z.literal("source-target-match"), pattern: z.string() }),
  z.object({ type: z.literal("builtin"), checkId: z.string().min(1) }),
])

const applicabilityRowSchema = z.object({
  targetType: z.enum(APPLICABILITY_TARGET_TYPES),
  targetId: z.string().min(1),
  relationship: z.enum(APPLICABILITY_RELATIONSHIPS),
  confidence: z.number().finite().optional(),
  reason: z.string().optional(),
  assignedBy: z.enum(APPLICABILITY_ASSIGNED_BY),
})

const createSchema = z.object({
  instruction: z.string().min(1),
  category: z.enum(STYLE_RULE_CATEGORIES),
  scope: z.enum(STYLE_RULE_SCOPES),
  conditions: z.string().optional(),
  examples: z.array(exampleSchema).optional(),
  exceptions: z.string().optional(),
  source: sourceSchema.optional(),
  checkSpec: checkSpecSchema.optional(),
  severity: z.enum(STYLE_RULE_SEVERITIES).optional(),
  applicability: z.array(applicabilityRowSchema).optional(),
})

const patchSchema = z
  .object({
    instruction: z.string().min(1).optional(),
    category: z.enum(STYLE_RULE_CATEGORIES).optional(),
    scope: z.enum(STYLE_RULE_SCOPES).optional(),
    conditions: z.string().nullable().optional(),
    examples: z.array(exampleSchema).nullable().optional(),
    exceptions: z.string().nullable().optional(),
    checkSpec: checkSpecSchema.nullable().optional(),
    severity: z.enum(STYLE_RULE_SEVERITIES).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
    message: "patch contains no editable fields",
  })

const reviewSchema = z.object({ action: z.enum(["approve", "reject"]) })

// ──────────────────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────────────────

// GET /:projectId/style-rules?status= — library + applicability (VIEWER+).
// Returns project rows AND inherited org rows; applicability covers exactly
// the returned rules.
styleRules.get("/:projectId/style-rules", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res

  const statusParam = c.req.query("status")
  if (statusParam && !(STYLE_RULE_STATUSES as readonly string[]).includes(statusParam)) {
    const { body, status } = errorJson("validation_failed", `unknown status "${statusParam}"`, 400)
    return c.json(body, status)
  }
  const { rules, applicability } = await listRulesForProject(
    c.env.AQUILLA_PG,
    projectId,
    statusParam as StyleRuleStatus | undefined,
  )
  return c.json({ rules, applicability })
})

// POST /:projectId/style-rules — propose a rule (CONTRIBUTOR+). Status is
// forced 'proposed'; initial applicability rows land atomically with the rule.
styleRules.post(
  "/:projectId/style-rules",
  authMiddleware,
  jsonValid(createSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.CONTRIBUTOR)
    if (!gate.ok) return gate.res

    const user = c.get("user")
    const input = c.req.valid("json")
    const { rule, applicability } = await createRule(c.env.AQUILLA_PG, {
      owner: { projectId },
      instruction: input.instruction,
      category: input.category,
      scope: input.scope,
      conditions: input.conditions,
      examples: input.examples,
      exceptions: input.exceptions,
      source: input.source,
      checkSpec: input.checkSpec,
      severity: input.severity,
      createdBy: user.username,
      applicability: input.applicability,
    })
    return c.json({ rule, applicability }, 201)
  },
)

// PATCH /:projectId/style-rules/:ruleId — human edit (PROJECT_LEAD+). Sets
// human_edited=true and bumps version.
styleRules.patch(
  "/:projectId/style-rules/:ruleId",
  authMiddleware,
  jsonValid(patchSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const ruleId = c.req.param("ruleId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.PROJECT_LEAD)
    if (!gate.ok) return gate.res
    const writable = await requireWritableRule(c, projectId, ruleId)
    if (!writable.ok) return writable.res

    const result = await updateRule(c.env.AQUILLA_PG, ruleId, c.req.valid("json"))
    if (result.status === "not_found") {
      const { body, status } = errorJson("not_found", `style rule ${ruleId} not found`, 404)
      return c.json(body, status)
    }
    if (result.status === "validation_failed") {
      const { body, status } = errorJson("validation_failed", result.message, 400)
      return c.json(body, status)
    }
    return c.json({ rule: result.rule })
  },
)

// POST /:projectId/style-rules/:ruleId/review — approve/reject a proposed
// rule (PROJECT_LEAD+). Sets reviewed_by.
styleRules.post(
  "/:projectId/style-rules/:ruleId/review",
  authMiddleware,
  jsonValid(reviewSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const ruleId = c.req.param("ruleId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.PROJECT_LEAD)
    if (!gate.ok) return gate.res
    const writable = await requireWritableRule(c, projectId, ruleId)
    if (!writable.ok) return writable.res

    const user = c.get("user")
    const { action } = c.req.valid("json")
    const result = await reviewRule(c.env.AQUILLA_PG, {
      id: ruleId,
      action,
      reviewedBy: user.username,
    })
    if (result.status === "not_found") {
      const { body, status } = errorJson("not_found", `style rule ${ruleId} not found`, 404)
      return c.json(body, status)
    }
    if (result.status === "invalid_state") {
      const { body, status } = errorJson("validation_failed", result.message, 409)
      return c.json(body, status)
    }
    return c.json({ rule: result.rule })
  },
)

// PUT /:projectId/style-rules/:ruleId/applicability — upsert one row on the
// (rule, targetType, targetId) key (PROJECT_LEAD+).
styleRules.put(
  "/:projectId/style-rules/:ruleId/applicability",
  authMiddleware,
  jsonValid(applicabilityRowSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const ruleId = c.req.param("ruleId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.PROJECT_LEAD)
    if (!gate.ok) return gate.res
    const writable = await requireWritableRule(c, projectId, ruleId)
    if (!writable.ok) return writable.res

    const user = c.get("user")
    const input = c.req.valid("json")
    const row = await upsertApplicability(c.env.AQUILLA_PG, {
      ruleId,
      targetType: input.targetType,
      targetId: input.targetId,
      relationship: input.relationship,
      confidence: input.confidence,
      reason: input.reason,
      assignedBy: input.assignedBy,
      createdBy: user.username,
    })
    return c.json({ row })
  },
)

// DELETE /:projectId/style-rules/:ruleId/applicability/:applicabilityId —
// remove one row (PROJECT_LEAD+).
styleRules.delete(
  "/:projectId/style-rules/:ruleId/applicability/:applicabilityId",
  authMiddleware,
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const ruleId = c.req.param("ruleId") ?? ""
    const applicabilityId = c.req.param("applicabilityId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.PROJECT_LEAD)
    if (!gate.ok) return gate.res
    const writable = await requireWritableRule(c, projectId, ruleId)
    if (!writable.ok) return writable.res

    const deleted = await deleteApplicability(c.env.AQUILLA_PG, ruleId, applicabilityId)
    if (!deleted) {
      const { body, status } = errorJson(
        "not_found",
        `applicability row ${applicabilityId} not found`,
        404,
      )
      return c.json(body, status)
    }
    return c.json({ ok: true })
  },
)

export default styleRules
