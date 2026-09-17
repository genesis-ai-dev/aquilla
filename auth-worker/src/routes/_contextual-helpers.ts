// Shared helpers for the contextual routers (routes/contextual.ts and
// routes/contextual-decisions.ts). Pure move out of contextual.ts — no
// behaviour change. Kept in a leading-underscore file so it reads as an
// internal helper module, not a router of its own.

import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { AuthHonoEnv } from "../middleware/auth"
import { resolveProjectRole } from "../services/project-permissions"

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
