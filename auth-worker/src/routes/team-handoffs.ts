// Human-expert handoffs — the ask that runs the other way down the team
// channel (AQU-1052). Sibling router to routes/team.ts, mounted at the same
// base in src/index.ts:
//
//   GET  /:projectId/team/handoffs                        the asks (VIEWER)
//   POST /:projectId/team/handoffs                        raise one (CONTRIBUTOR)
//   POST /:projectId/team/handoffs/:handoffId/assign      route it (CONTRIBUTOR)
//   POST /:projectId/team/handoffs/:handoffId/answer      answer it (CONTRIBUTOR)
//   POST /:projectId/team/handoffs/:handoffId/resume       restart the work
//
// routes/contextual-decisions.ts is the mirror image of this file: there the
// agent asks a person a question it cannot settle alone, and answering it
// wakes the run that was waiting. Here a PERSON asks for human expertise,
// and the work waiting on the answer is resumed by somebody saying so —
// because the answer may well be "stop, this file is wrong". That asymmetry
// is the whole reason the two surfaces are separate; see
// lib/team-handoffs.ts for the model and shared/team-handoffs.ts for the
// wire shapes.
//
// Role floors mirror the channel next door: VIEWER reads, CONTRIBUTOR writes.
// The release flag is applied per action, argued at each route.

import { Hono } from "hono"
import type { Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import type { AuthUser } from "../types"
import {
  errorJson,
  projectIsActive,
  requireAutopilotReleased,
  requireRole,
} from "./_contextual-helpers"
import {
  answerHandoff,
  assignHandoff,
  getHandoff,
  listHandoffs,
  markHandoffResumed,
  raiseHandoff,
  type HandoffTransition,
} from "../lib/team-handoffs"
import {
  TEAM_HANDOFF_ANSWER_MAX,
  TEAM_HANDOFF_LIST_DEFAULT,
  TEAM_HANDOFF_LIST_MAX,
  TEAM_HANDOFF_QUESTION_MAX,
} from "../../../shared/team-handoffs"
import { getRun, resumeRun } from "../../../db/shared/contextual-runs"
import { kickLoop, publishRunStateOutsideTick } from "./contextual"
import { resolveProjectRole } from "../services/project-permissions"
import { lookupUserByUsername } from "../services/user-lookup"

const teamHandoffs = new Hono<AuthHonoEnv>()

const raiseHandoffSchema = z
  .object({
    /** Client-supplied so a retried POST is not a second question — the same
     *  reason POST /team/messages takes one. */
    id: z.string().uuid().optional(),
    question: z.string().trim().min(1).max(TEAM_HANDOFF_QUESTION_MAX),
    /** The contextual run this ask blocks. */
    runId: z.string().trim().min(1).max(512).optional(),
    /** Route it as you raise it. Username, like every other handoff actor. */
    assignTo: z.string().trim().min(1).max(128).optional(),
  })
  .strict()

const handoffListSchema = z.object({
  /** `1`/`true` narrows to what the team is still waiting on a person for. */
  open: z.enum(["0", "1", "true", "false"]).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(TEAM_HANDOFF_LIST_MAX)
    .default(TEAM_HANDOFF_LIST_DEFAULT),
})

const answerHandoffSchema = z
  .object({ answer: z.string().trim().min(1).max(TEAM_HANDOFF_ANSWER_MAX) })
  .strict()

const assignHandoffSchema = z
  .object({ assignTo: z.string().trim().min(1).max(128) })
  .strict()

/**
 * Resolve an assignee by username to the name we will store, or null.
 *
 * Null covers BOTH "no such account" and "that account cannot see this
 * project", on purpose: the two must not be distinguishable from outside, or
 * the assign route becomes an oracle for which usernames exist. The caller
 * answers one validation_failed either way. Mirrors `isLiveProjectMember` in
 * routes/changeset-approvals.ts — routing work at somebody who cannot act on
 * it is a validation failure, not a silent no-op.
 *
 * The stored name is the CANONICAL `users.username`, not the request's
 * spelling, so an assignee always matches the `author_id` of the messages
 * that person writes in the same channel.
 */
async function resolveAssignee(
  env: AuthHonoEnv["Bindings"],
  username: string,
  projectId: string,
): Promise<string | null> {
  const found = await lookupUserByUsername(env, username)
  if (!found) return null
  const full = await env.AQUILLA_PG.prepare("SELECT * FROM users WHERE id = ?")
    .bind(found.id)
    .first<AuthUser>()
  if (!full) return null
  // Any role at all is enough to be asked a question: a VIEWER who knows the
  // language is exactly the expert a handoff is looking for.
  const role = await resolveProjectRole(env, full, projectId)
  return role ? found.username : null
}

// GET /:projectId/team/handoffs — the project's asks, newest first (VIEWER).
// Ungated by the release flag, like every other read on this router: a
// project that switches Autopilot off still owns the questions its people
// asked and the answers they gave.
teamHandoffs.get(
  "/:projectId/team/handoffs",
  authMiddleware,
  zValidator("query", handoffListSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.VIEWER)
    if (!gate.ok) return gate.res
    const { open, limit } = c.req.valid("query")
    const handoffs = await listHandoffs(c.env.AQUILLA_PG, {
      projectId,
      openOnly: open === "1" || open === "true",
      limit,
    })
    c.header("Cache-Control", "no-store")
    return c.json({ handoffs })
  },
)

// POST /:projectId/team/handoffs — raise one (CONTRIBUTOR).
//
// The write floor matches POST /messages: this posts into the shared channel,
// and the requester is the authenticated session, never the request body.
//
// AQU-1050 — admission. Raising a handoff opens a thread in the AI team's
// channel and names agent work as waiting on it, so it rides the release flag
// for the same reason posting a message does. Answering and assigning
// deliberately do NOT (see below).
teamHandoffs.post(
  "/:projectId/team/handoffs",
  authMiddleware,
  zValidator("json", raiseHandoffSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.CONTRIBUTOR)
    if (!gate.ok) return gate.res
    const released = await requireAutopilotReleased(c, projectId)
    if (!released.ok) return released.res

    const input = c.req.valid("json")
    const user = c.get("user")
    const db = c.env.AQUILLA_PG

    if (!(await projectIsActive(db, projectId))) {
      const { body, status } = errorJson("invalid_state", "project is not active", 409)
      return c.json(body, status)
    }

    // A handoff may only name work in its OWN project. Same 404 body for
    // "no such run" and "someone else's run": this must not become an
    // existence oracle for other projects' run ids.
    if (input.runId !== undefined) {
      const run = await getRun(db, input.runId)
      if (!run || run.projectId !== projectId) {
        const { body, status } = errorJson("not_found", `run ${input.runId} not found`, 404)
        return c.json(body, status)
      }
    }

    // Idempotent retry: the same id replays the stored handoff; a DIFFERENT
    // question under a used id is a client bug and must not quietly become a
    // second ask (or overwrite the first). Mirrors POST /team/messages.
    if (input.id !== undefined) {
      const prior = await getHandoff(db, input.id)
      if (prior) {
        const same =
          prior.projectId === projectId &&
          prior.requestedBy === user.username &&
          prior.question === input.question &&
          prior.runId === (input.runId ?? null)
        if (!same) {
          const { body, status } = errorJson("invalid_state", "handoff id already used", 409)
          return c.json(body, status)
        }
        return c.json({ handoff: prior }, 201)
      }
    }

    let assignTo: string | null = null
    if (input.assignTo !== undefined) {
      assignTo = await resolveAssignee(c.env, input.assignTo, projectId)
      if (!assignTo) {
        const { body, status } = errorJson(
          "validation_failed",
          "assignTo must name someone with access to this project",
          400,
        )
        return c.json(body, status)
      }
    }

    const raised = await raiseHandoff(db, {
      id: input.id,
      projectId,
      requestedBy: user.username,
      question: input.question,
      runId: input.runId ?? null,
    })
    // Routing at raise time goes through the one code path that writes an
    // assignment, so `assignedBy`/`assignedAt` are recorded the same way they
    // would be an hour later.
    let handoff = raised.handoff
    if (assignTo) {
      const assigned = await assignHandoff(db, handoff.id, assignTo, user.username)
      if (assigned.status === "ok") handoff = assigned.handoff
    }
    return c.json({ handoff, thread: raised.thread, message: raised.message }, 201)
  },
)

/** One refusal shape for the transitions: "no such handoff" is a 404 and
 *  anything else is the state guard refusing, with the reason the caller can
 *  act on. */
function handoffError(
  c: Context<AuthHonoEnv>,
  result: Exclude<HandoffTransition, { status: "ok" }>,
  what: string,
): Response {
  if (result.status === "not_found") {
    const { body, status } = errorJson("not_found", "handoff not found", 404)
    return c.json(body, status)
  }
  const { body, status } = errorJson("invalid_state", what, 409)
  return c.json(body, status)
}

// POST /:projectId/team/handoffs/:handoffId/assign|answer|resume (CONTRIBUTOR).
//
// Release flag, per action, following lib/contextual/release-gate.ts:
//
//   assign  ungated — routing an open question starts no work, and a project
//           that has just switched Autopilot off is exactly when somebody
//           needs to hand the outstanding asks to the right person.
//   answer  ungated — the same carve-out draft review gets: a human closing
//           an ask that is already open is winding the work down, and
//           stranding it behind the flag would make disabling destructive
//           (the question could never be answered again).
//   resume  GATED — it puts a contextual run back to work, which is
//           admission by another name. Identical to POST /contextual/runs/
//           :runId/resume, which this delegates to.
teamHandoffs.post("/:projectId/team/handoffs/:handoffId/:action", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const handoffId = c.req.param("handoffId") ?? ""
  const action = c.req.param("action") ?? ""
  if (!["assign", "answer", "resume"].includes(action)) {
    const { body, status } = errorJson("not_found", `unknown action "${action}"`, 404)
    return c.json(body, status)
  }
  const gate = await requireRole(c, projectId, ROLE.CONTRIBUTOR)
  if (!gate.ok) return gate.res
  if (action === "resume") {
    const released = await requireAutopilotReleased(c, projectId)
    if (!released.ok) return released.res
  }

  const user = c.get("user")
  const db = c.env.AQUILLA_PG

  if (!(await projectIsActive(db, projectId))) {
    const { body, status } = errorJson("invalid_state", "project is not active", 409)
    return c.json(body, status)
  }

  // Scope BEFORE mutating: the transitions guard their UPDATE by id and
  // status only, so a CONTRIBUTOR on this project who supplies a handoff id
  // from another one must be rejected here. Same 404 body for "does not
  // exist" and "exists elsewhere" — the shape of the sibling decisions route.
  const existing = await getHandoff(db, handoffId)
  if (!existing || existing.projectId !== projectId) {
    const { body, status } = errorJson("not_found", "handoff not found", 404)
    return c.json(body, status)
  }

  if (action === "assign") {
    const parsed = assignHandoffSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      const { body, status } = errorJson("validation_failed", "assignTo is required", 400)
      return c.json(body, status)
    }
    const assignTo = await resolveAssignee(c.env, parsed.data.assignTo, projectId)
    if (!assignTo) {
      const { body, status } = errorJson(
        "validation_failed",
        "assignTo must name someone with access to this project",
        400,
      )
      return c.json(body, status)
    }
    const result = await assignHandoff(db, handoffId, assignTo, user.username)
    if (result.status !== "ok") {
      return handoffError(c, result, "handoff is already answered")
    }
    return c.json({ handoff: result.handoff })
  }

  if (action === "answer") {
    const parsed = answerHandoffSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      const { body, status } = errorJson("validation_failed", "answer is required", 400)
      return c.json(body, status)
    }
    const result = await answerHandoff(db, handoffId, parsed.data.answer, user.username)
    if (result.status !== "ok") {
      return handoffError(c, result, "handoff is already answered")
    }
    return c.json({ handoff: result.handoff })
  }

  // resume — the explicit restart of the work this ask was blocking.
  if (!existing.runId) {
    const { body, status } = errorJson(
      "invalid_state",
      "this handoff has no dependent run to resume",
      409,
    )
    return c.json(body, status)
  }
  if (existing.status !== "answered") {
    const { body, status } = errorJson(
      "invalid_state",
      "answer the handoff before resuming the work waiting on it",
      409,
    )
    return c.json(body, status)
  }
  if (existing.resumedAt) {
    const { body, status } = errorJson("invalid_state", "handoff already resumed", 409)
    return c.json(body, status)
  }
  const run = await getRun(db, existing.runId)
  if (!run || run.projectId !== projectId) {
    const { body, status } = errorJson("not_found", `run ${existing.runId} not found`, 404)
    return c.json(body, status)
  }
  // Resume the RUN first, then record it. The other order would let a failed
  // transition leave a record claiming work had carried on when it had not —
  // and a false entry in an audit trail is worse than a missing one.
  const resumed = await resumeRun(db, existing.runId)
  if (resumed.status !== "ok") {
    const { body, status } = errorJson(
      "invalid_state",
      `cannot resume a ${resumed.status === "invalid_state" ? resumed.current : "missing"} run`,
      409,
    )
    return c.json(body, status)
  }
  const marked = await markHandoffResumed(db, handoffId, user.username)
  await publishRunStateOutsideTick(c.env, db, projectId, resumed.run)
  kickLoop(c, projectId, existing.runId)
  if (marked.status !== "ok") {
    // The run IS running; only the bookkeeping lost a race with another
    // resume. Report the handoff as it now stands rather than inventing a
    // failure the caller cannot act on.
    const current = await getHandoff(db, handoffId)
    return c.json({ handoff: current ?? existing, runId: existing.runId })
  }
  return c.json({ handoff: marked.handoff, runId: existing.runId })
})

export default teamHandoffs
