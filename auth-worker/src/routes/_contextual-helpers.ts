// Shared helpers for the contextual routers (routes/contextual.ts and
// routes/contextual-decisions.ts). Pure move out of contextual.ts — no
// behaviour change. Kept in a leading-underscore file so it reads as an
// internal helper module, not a router of its own.

import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { AuthHonoEnv } from "../middleware/auth"
import { resolveProjectRole } from "../services/project-permissions"
import {
  AUTOPILOT_DISABLED_MESSAGE,
  isAutopilotReleased,
} from "../lib/contextual/release-gate"

type ErrorCode =
  | "not_found"
  | "permission_denied"
  | "validation_failed"
  | "context_required"
  | "invalid_state"
  | "not_projected"
  | "run_exists"
  | "credit_cap_exceeded"
  | "not_configured"
  | "segmentation_failed"
  | "usage_rehearsal_unavailable"
  | "usage_accounting_unavailable"
  | "weekly_ai_allowance_exhausted"
  | "release_disabled"

export function errorJson(code: ErrorCode, message: string, status: ContentfulStatusCode, details?: unknown) {
  return {
    body: { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    status,
  } as const
}

export async function requireRole(
  c: Context<AuthHonoEnv>,
  projectId: string,
  floor: number,
): Promise<{ ok: true; level: number } | { ok: false; res: Response }> {
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
  return { ok: true, level: role.level }
}

/**
 * AQU-1050: the server side of the Autopilot release flag, for the routes
 * that START or CONTINUE agent work. See lib/contextual/release-gate.ts for
 * which surfaces are gated and — just as deliberately — which are not.
 *
 * 409 rather than 404: the project and the route both exist, and its history
 * is still readable through the GET siblings next door. 404 would tell a
 * client that switched the flag off mid-session that its runs had vanished.
 */
export async function requireAutopilotReleased(
  c: Context<AuthHonoEnv>,
  projectId: string,
): Promise<{ ok: true } | { ok: false; res: Response }> {
  if (await isAutopilotReleased(c.env.AQUILLA_PG, projectId)) return { ok: true }
  const { body, status } = errorJson("release_disabled", AUTOPILOT_DISABLED_MESSAGE, 409)
  return { ok: false, res: c.json(body, status) }
}
