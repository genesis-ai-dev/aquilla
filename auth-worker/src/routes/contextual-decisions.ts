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
  getDecision,
  assignDecision,
  OPEN_DECISION_SURFACE_CAP,
  type DecisionTransition,
} from "../../../db/shared/contextual-decisions"
import { resolveBlockingDecision } from "../../../db/shared/contextual-decision-lifecycle"
import type { BlockingDecisionTransition } from "../../../db/shared/contextual-decision-lifecycle"
import { kickLoop, publishRunStateOutsideTick } from "./contextual"

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

    // Scope BEFORE mutating: answerDecision/dismissDecision/assignDecision
    // guard their UPDATE by id + status only, not project_id, so a caller who
    // is a CONTRIBUTOR on `projectId` but supplies a decisionId belonging to
    // a different project must be rejected here — before any transition runs
    // — not after. Same 404 body for "does not exist" and "exists in another
    // project": this must not become an existence oracle for other projects'
    // decision ids. Mirrors the scope-then-mutate shape of the sibling
    // POST /:projectId/contextual/drafts/:draftId/review route above.
    const existing = await getDecision(c.env.AQUILLA_PG, decisionId)
    if (!existing || existing.projectId !== projectId) {
      const { body, status } = errorJson("not_found", `decision ${decisionId} not found`, 404)
      return c.json(body, status)
    }

    const user = c.get("user")
    let result: DecisionTransition | BlockingDecisionTransition
    if (action === "answer") {
      const parsed = answerSchema.safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success) {
        const { body, status } = errorJson("validation_failed", "answer is required", 400)
        return c.json(body, status)
      }
      result = await resolveBlockingDecision(
        c.env.AQUILLA_PG,
        {
          decisionId,
          action: "answer",
          answer: parsed.data.answer,
          byUserId: user.id,
          byUsername: user.username,
        },
      )
    } else if (action === "dismiss") {
      result = await resolveBlockingDecision(c.env.AQUILLA_PG, {
        decisionId,
        action: "dismiss",
        byUsername: user.username,
      })
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
    const wokeRun = "run" in result ? result.run : undefined
    if (wokeRun) {
      await publishRunStateOutsideTick(c.env, c.env.AQUILLA_PG, projectId, wokeRun)
      kickLoop(c, projectId, wokeRun.id)
    }
    return c.json({
      decision: result.decision,
      ...(wokeRun ? { wokeRunId: wokeRun.id } : {}),
    })
  },
)

export default decisions
