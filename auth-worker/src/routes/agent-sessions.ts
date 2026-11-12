// Team chat history (AQU-1653). Mounted at /api/v2/projects in src/index.ts,
// sibling to the other per-project routers.
//
// WHY this exists: `agent_sessions` has always held every Team chat a user has
// had on a project, but nothing outside the admin routes could read it back.
// The client kept the ONE session id it knew about in localStorage, so
// "start a new chat" was unofferable — calling AgentSessionStore.reset() would
// have dropped the visible conversation with no way back to it. These two
// reads are what make a new chat safe: the old one is still reachable.
//
// Ownership: a session belongs to (project_id, user_id). A member never lists
// or opens another member's chats, and a session that exists but is not the
// caller's is indistinguishable from one that does not exist — same 404, no
// "forbidden" that would confirm it is there.
//
// Error envelope mirrors agent-memory / changeset-approvals:
// `{ error: { code, message } }`.

import { Hono, type Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { listSessionsForUser, loadSessionForUser } from "../lib/agent/sessions"

const agentSessions = new Hono<AuthHonoEnv>()

/** Most chats a list read returns. A user with more sees their recent ones;
 *  the switcher is a "jump back to a recent chat" affordance, not an archive. */
const LIST_LIMIT = 50

type ErrorCode = "not_found" | "permission_denied"

function errorJson(code: ErrorCode, message: string, status: ContentfulStatusCode) {
  return { body: { error: { code, message } }, status } as const
}

/** Resolve the caller's live role floor on a project; below it → 403. */
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

// GET /:projectId/agent-sessions — the caller's own chats, newest first.
// VIEWER+ because reading your own conversations needs no more access than
// seeing the project; the (project, user) scope is what protects the rows.
agentSessions.get("/:projectId/agent-sessions", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res

  const user = c.get("user")
  const sessions = await listSessionsForUser(c.env.AQUILLA_PG, projectId, user.id, LIST_LIMIT)
  return c.json({ sessions })
})

// GET /:projectId/agent-sessions/:sessionId — one of the caller's own chats as
// a readable transcript. 404 covers "no such session" AND "not yours", so the
// response never confirms that someone else's session id exists.
agentSessions.get("/:projectId/agent-sessions/:sessionId", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const sessionId = c.req.param("sessionId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res

  const user = c.get("user")
  const session = await loadSessionForUser(c.env.AQUILLA_PG, projectId, user.id, sessionId)
  if (!session) {
    const { body, status } = errorJson("not_found", "no such chat on this project", 404)
    return c.json(body, status)
  }
  return c.json({ session })
})

export default agentSessions
