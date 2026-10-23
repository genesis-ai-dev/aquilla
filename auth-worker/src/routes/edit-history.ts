// A person's undo history for a project, kept on the server so it follows
// them between computers and browsers (decision 11, migration 0188). Mounted
// at /api/v2/projects in src/index.ts.
//
//   GET /:projectId/edit-history?since=<revision>
//       The caller's own copy: { revision, history } (revision 0 and history
//       null when there is none yet), or { revision, unchanged: true } when
//       `since` is still the stored revision — the cheap check an Undo makes
//       before it writes anything.
//   PUT /:projectId/edit-history   { baseRevision, history }
//       Store the caller's copy if `baseRevision` is still the stored one:
//       200 { revision }. Otherwise 409 { revision, history } with the current
//       copy, which the client merges with its own and writes again
//       (src/lib/history/history-merge.ts).
//
// Only ever the caller's OWN row: the user comes from the session, never the
// request, so one person can neither read nor write another's history. Any
// project member may keep one (VIEWER+): it holds only what they did, and
// every step is re-checked against today's permissions when it runs. The
// agent channel is refused — a history is a person's, not an agent's.

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { EDIT_HISTORY_MAX_BYTES, readEditHistory, writeEditHistory } from "../../../db/shared/edit-history"

const editHistory = new Hono<AuthHonoEnv>()

const AGENT_RUN_HEADER = "x-aquilla-agent-run"

function error(code: string, message: string) {
  return { error: { code, message } }
}

function parseHistory(text: string | null): unknown {
  if (text == null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** The shape every copy has; the server checks no more than that. */
function isHistoryDoc(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return ["undo", "redo", "log", "gone"].every((k) => Array.isArray(v[k]))
}

editHistory.get("/:projectId/edit-history", authMiddleware, async (c) => {
  if (c.req.header(AGENT_RUN_HEADER)) return c.json(error("agent_denied", "a history belongs to a person"), 403)
  const projectId = c.req.param("projectId") ?? ""
  const user = c.get("user")
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role || role.level < ROLE.VIEWER) {
    return c.json(error("permission_denied", "you do not have access to this project"), 403)
  }
  const stored = await readEditHistory(c.env.AQUILLA_PG, projectId, user.id)
  const sinceParam = c.req.query("since")
  if (sinceParam != null && Number(sinceParam) === stored.revision) {
    return c.json({ revision: stored.revision, unchanged: true })
  }
  return c.json({ revision: stored.revision, history: parseHistory(stored.history) })
})

editHistory.put("/:projectId/edit-history", authMiddleware, async (c) => {
  if (c.req.header(AGENT_RUN_HEADER)) return c.json(error("agent_denied", "a history belongs to a person"), 403)
  const projectId = c.req.param("projectId") ?? ""
  const user = c.get("user")
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role || role.level < ROLE.VIEWER) {
    return c.json(error("permission_denied", "you do not have access to this project"), 403)
  }
  const raw = await c.req.text()
  if (raw.length > EDIT_HISTORY_MAX_BYTES) {
    return c.json(error("too_large", "the history is larger than the server keeps"), 413)
  }
  let body: { baseRevision?: unknown; history?: unknown }
  try {
    body = JSON.parse(raw) as typeof body
  } catch {
    return c.json(error("validation_failed", "the body is not JSON"), 400)
  }
  const base = body.baseRevision
  if (typeof base !== "number" || !Number.isInteger(base) || base < 0) {
    return c.json(error("validation_failed", "baseRevision must be a whole number"), 400)
  }
  if (!isHistoryDoc(body.history)) {
    return c.json(error("validation_failed", "history must hold undo, redo, log and gone lists"), 400)
  }
  const result = await writeEditHistory(c.env.AQUILLA_PG, projectId, user.id, base, JSON.stringify(body.history))
  if (result.ok) return c.json({ revision: result.revision })
  return c.json(
    {
      ...error("conflict", "another device saved this history first"),
      revision: result.current.revision,
      history: parseHistory(result.current.history),
    },
    409,
  )
})

export default editHistory
