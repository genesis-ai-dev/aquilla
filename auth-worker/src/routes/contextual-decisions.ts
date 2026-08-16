// Decision routes — the agent → user channel's HTTP surface (seam design §4.3).
//
// Read is VIEWER; acting is CONTRIBUTOR, because answering a decision sets
// project-wide policy rather than editing one cell.
//
// The surfacing cap is enforced HERE, read-side, not at raise time: a held
// decision stays open so the supersession sweep can still close it, and is
// very likely to be closed that way before anyone would have reached it.

import { Hono } from "hono"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { errorJson, requireRole } from "./_contextual-helpers"
import {
  listOpenDecisions,
  countOpenDecisions,
  answerDecision,
  dismissDecision,
  assignDecision,
  OPEN_DECISION_SURFACE_CAP,
  type DecisionTransition,
} from "../../../db/shared/contextual-decisions"

const decisions = new Hono<AuthHonoEnv>()

const answerSchema = z.object({ answer: z.string().min(1).max(2000) })
const assignSchema = z.object({
  userId: z.number().int().positive().optional(),
  inviteId: z.string().min(1).max(256).optional(),
})

decisions.get("/:projectId/contextual/decisions", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res

  const [open, openCount] = await Promise.all([
    listOpenDecisions(c.env.AQUILLA_PG, projectId, OPEN_DECISION_SURFACE_CAP),
    countOpenDecisions(c.env.AQUILLA_PG, projectId),
  ])
  return c.json({ decisions: open, openCount, cap: OPEN_DECISION_SURFACE_CAP })
})

decisions.post(
  "/:projectId/contextual/decisions/:decisionId/:action",
  authMiddleware,
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const decisionId = c.req.param("decisionId") ?? ""
    const action = c.req.param("action") ?? ""
    if (!["answer", "dismiss", "assign"].includes(action)) {
      const { body, status } = errorJson("validation_failed", `unknown action ${action}`, 400)
      return c.json(body, status)
    }
    const gate = await requireRole(c, projectId, ROLE.CONTRIBUTOR)
    if (!gate.ok) return gate.res

    let result: DecisionTransition
    if (action === "answer") {
      const parsed = answerSchema.safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success) {
        const { body, status } = errorJson("validation_failed", "answer is required", 400)
        return c.json(body, status)
      }
      // requireRole returns only { ok, level } — it carries no user. The
      // authenticated user comes from the middleware's context variable, the
      // same way requireRole itself reads it (contextual.ts:130).
      const user = c.get("user")
      result = await answerDecision(
        c.env.AQUILLA_PG,
        decisionId,
        parsed.data.answer,
        user.id,
      )
    } else if (action === "dismiss") {
      result = await dismissDecision(c.env.AQUILLA_PG, decisionId)
    } else {
      const parsed = assignSchema.safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success || (!parsed.data.userId && !parsed.data.inviteId)) {
        const { body, status } = errorJson(
          "validation_failed",
          "assign requires userId or inviteId",
          400,
        )
        return c.json(body, status)
      }
      result = await assignDecision(c.env.AQUILLA_PG, decisionId, parsed.data)
    }

    if (result.status === "not_found") {
      const { body, status } = errorJson("not_found", `decision ${decisionId} not found`, 404)
      return c.json(body, status)
    }
    if (result.status === "invalid_state") {
      const { body, status } = errorJson(
        "invalid_state",
        "decision is already closed",
        409,
      )
      return c.json(body, status)
    }
    if (result.decision.projectId !== projectId) {
      const { body, status } = errorJson("not_found", `decision ${decisionId} not found`, 404)
      return c.json(body, status)
    }
    return c.json({ decision: result.decision })
  },
)

export default decisions
