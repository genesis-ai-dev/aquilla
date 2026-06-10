// Platform-operator (site-wide admin) gate.
//
// A SEPARATE authorization axis from the org-scoped role ladder: the
// 100–700 levels in types.ts only ever grant access *within* an org, so a
// user with org role 700 (owner) still cannot read another org's data.
// Platform admin is the cross-tenant primitive — it lets a named operator
// read every org/user/project for support and oversight.
//
// Membership lives in deploy config (`PLATFORM_ADMINS`, a comma-separated
// username allowlist) rather than a DB column, so god-mode can't be
// conferred by a stray SQL write and is auditable in the worker config.
// Mount this AFTER authMiddleware so `c.get("user")` is hydrated.

import type { Context, Next } from "hono"
import type { Env } from "../types"
import type { AuthHonoEnv } from "./auth"

/** Parse the comma-separated allowlist into a set of trimmed usernames. */
export const parsePlatformAdmins = (env: Env): Set<string> => {
  const raw = env.PLATFORM_ADMINS ?? ""
  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  )
}

/**
 * Context-free allowlist check, usable from services (no hono Context).
 * The permission resolvers call this to grant platform operators owner-level
 * access on every org/project — see resolveProjectRole / getEffectiveOrgRole.
 */
export const isPlatformAdminUsername = (env: Env, username: string): boolean =>
  parsePlatformAdmins(env).has(username)

/** True when the hydrated request user is a platform operator. */
export const isPlatformAdmin = (c: Context<AuthHonoEnv>): boolean => {
  const user = c.get("user")
  if (!user) return false
  return isPlatformAdminUsername(c.env, user.username)
}

/**
 * Reject any caller who is not on the platform-admin allowlist. Returns the
 * same 403 shape as the org-role guards so the client handles it uniformly.
 * Every `/api/v2/admin/*` route mounts behind this — a single choke point so
 * there is no "forgot the check" path into cross-tenant data.
 */
export const requirePlatformAdmin = async (
  c: Context<AuthHonoEnv>,
  next: Next,
): Promise<Response | void> => {
  if (!isPlatformAdmin(c)) {
    return c.json({ error: "platform admin required" }, 403)
  }
  await next()
}
