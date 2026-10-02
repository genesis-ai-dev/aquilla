// Durable team channel — the v2 one-channel model's read/write surface
// (docs/superpowers/specs/2026-08-28-agent-social-workspace-design.md).
// Mounted at /api/v2/projects in src/index.ts:
//
//   GET  /:projectId/team/messages                       main channel (VIEWER)
//   GET  /:projectId/team/threads/:threadId/messages     one thread (VIEWER)
//   POST /:projectId/team/messages                       post as a human (CONTRIBUTOR)
//
// The handoff half of this channel — the ask that runs the other way, when a
// contributor needs a human expert — is the sibling router in
// routes/team-handoffs.ts (AQU-1052), mounted at the same base.
//
// Ported from the AQU-1049→1053 `team-threads` router. Intentional
// divergences from that donor:
//
//   • The release flag is dev's own, not the donor's. The donor gated every
//     route behind a PLATFORM `aiTeamWorkspace` flag and 404'd when off;
//     `withTeamWrite`/`resolveReleaseFlags` and the admin flag console are
//     still not ported. What AQU-1050 did port is the BEHAVIOUR, onto the
//     gate dev already has: the per-project `autopilotEnabled` opt-in of
//     AQU-1246. POST is refused with 409 when a project has Autopilot off;
//     the two GETs stay open, because disabling must stop new work without
//     taking the shared history away from the people who own it. See
//     lib/contextual/release-gate.ts.
//   • No POST /threads. Threads are opened by the work they cover — the
//     ingestion write-through creates a run's thread (lib/team-ingest.ts).
//     A human-opened thread has no producer yet, so the endpoint would have
//     no caller.
//   • The donor's overview aggregation, questions/decision, and work/
//     contribution endpoints are dropped: in the one-channel model the main
//     channel IS the overview, so those panels dissolve into it.
//
// Role floors mirror the contextual routes next door: VIEWER reads (same as
// GET /contextual/runs), CONTRIBUTOR writes (same as POST /contextual/
// steering, which this endpoint is the conversational sibling of).

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import {
  errorJson,
  projectIsActive,
  requireAutopilotReleased,
  requireRole,
} from "./_contextual-helpers"
import {
  appendMessage,
  getMessage,
  getThread,
  readPage,
  touchThread,
} from "../lib/team-channel"
import {
  TEAM_MESSAGE_PAGE_DEFAULT,
  TEAM_MESSAGE_PAGE_MAX,
  TEAM_MESSAGE_TEXT_MAX,
} from "../../../shared/team-channel"

const team = new Hono<AuthHonoEnv>()

const UUID = z.string().uuid()

const pagingSchema = z.object({
  before: UUID.optional(),
  after: UUID.optional(),
  limit: z.coerce.number().int().min(1).max(TEAM_MESSAGE_PAGE_MAX).default(TEAM_MESSAGE_PAGE_DEFAULT),
})

const postMessageSchema = z
  .object({
    /** Client-supplied so a retried POST is not a duplicate message. */
    id: UUID.optional(),
    threadId: UUID.optional(),
    text: z.string().trim().min(1).max(TEAM_MESSAGE_TEXT_MAX),
  })
  .strict()

// GET /:projectId/team/messages — the main channel, newest-last (VIEWER).
team.get(
  "/:projectId/team/messages",
  authMiddleware,
  zValidator("query", pagingSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.VIEWER)
    if (!gate.ok) return gate.res
    const { before, after, limit } = c.req.valid("query")
    if (before !== undefined && after !== undefined) {
      const { body, status } = errorJson(
        "validation_failed",
        "pass at most one of before/after",
        400,
      )
      return c.json(body, status)
    }
    const result = await readPage(c.env.AQUILLA_PG, { projectId, before, after, limit })
    if (result.status === "invalid_cursor") {
      const { body, status } = errorJson("validation_failed", "unknown cursor", 400)
      return c.json(body, status)
    }
    c.header("Cache-Control", "no-store")
    return c.json(result.page)
  },
)

// GET /:projectId/team/threads/:threadId/messages — one work item (VIEWER).
team.get(
  "/:projectId/team/threads/:threadId/messages",
  authMiddleware,
  zValidator("query", pagingSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const threadId = c.req.param("threadId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.VIEWER)
    if (!gate.ok) return gate.res
    const { before, after, limit } = c.req.valid("query")
    if (before !== undefined && after !== undefined) {
      const { body, status } = errorJson(
        "validation_failed",
        "pass at most one of before/after",
        400,
      )
      return c.json(body, status)
    }
    const thread = await getThread(c.env.AQUILLA_PG, projectId, threadId)
    if (!thread) {
      const { body, status } = errorJson("not_found", "thread not found", 404)
      return c.json(body, status)
    }
    const result = await readPage(c.env.AQUILLA_PG, {
      projectId,
      threadId,
      before,
      after,
      limit,
    })
    if (result.status === "invalid_cursor") {
      const { body, status } = errorJson("validation_failed", "unknown cursor", 400)
      return c.json(body, status)
    }
    c.header("Cache-Control", "no-store")
    return c.json({ thread, ...result.page })
  },
)

// POST /:projectId/team/messages — a human speaks (CONTRIBUTOR). The author
// is the authenticated session, never the request body: a forged author is
// the one thing a shared history cannot survive.
team.post(
  "/:projectId/team/messages",
  authMiddleware,
  zValidator("json", postMessageSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.CONTRIBUTOR)
    if (!gate.ok) return gate.res
    // AQU-1050 — admission. A message in this channel addresses the
    // orchestrator, so posting one is how a human asks the team for work;
    // it rides the release flag for the same reason POST /contextual/runs
    // does. Reads above are untouched.
    const released = await requireAutopilotReleased(c, projectId)
    if (!released.ok) return released.res

    const input = c.req.valid("json")
    const user = c.get("user")
    const db = c.env.AQUILLA_PG

    if (!(await projectIsActive(db, projectId))) {
      const { body, status } = errorJson("invalid_state", "project is not active", 409)
      return c.json(body, status)
    }
    if (input.threadId !== undefined) {
      const thread = await getThread(db, projectId, input.threadId)
      if (!thread) {
        const { body, status } = errorJson("not_found", "thread not found", 404)
        return c.json(body, status)
      }
    }

    // Idempotent retry: the same id replays the stored message, a DIFFERENT
    // message under a used id is a client bug and must not silently overwrite.
    if (input.id !== undefined) {
      const existing = await getMessage(db, projectId, input.id)
      if (existing) {
        const same =
          existing.threadId === (input.threadId ?? null) &&
          existing.author.kind === "human" &&
          existing.author.id === user.username &&
          (existing.body as { text?: string }).text === input.text
        if (!same) {
          const { body, status } = errorJson(
            "invalid_state",
            "message id already used",
            409,
          )
          return c.json(body, status)
        }
        return c.json(existing, 201)
      }
    }

    const message = await appendMessage(db, {
      id: input.id,
      projectId,
      threadId: input.threadId ?? null,
      author: { kind: "human", id: user.username },
      bodyKind: "text",
      body: { text: input.text },
    })
    if (input.threadId !== undefined) await touchThread(db, input.threadId)
    return c.json(message, 201)
  },
)


export default team
