// Platform-operator (site-wide admin) gate.
//
// A SEPARATE authorization axis from the org-scoped role ladder: the
// 100–700 levels in types.ts only ever grant access *within* an org, so a
// user with org role 700 (owner) still cannot read another org's data.
// Platform admin is the cross-tenant primitive — it lets a named operator
// read every org/user/project for support and oversight.
//
// Identity is by EMAIL: `ADMIN_EMAILS` (a comma-separated allowlist) lists the
// exact account emails that are site admins. Usernames do not matter. Membership
// lives in deploy config rather than a DB column, so god-mode can't be conferred
// by a stray SQL write and is auditable in the worker config. Mount this AFTER
// authMiddleware so `c.get("user")` is hydrated.

import type { Context, Next } from "hono"
import type { Env } from "../types"
import type { AuthHonoEnv } from "./auth"

/** Parse `ADMIN_EMAILS` into a set of trimmed, lowercased emails. */
export const parseAdminEmails = (env: Env): Set<string> => {
  const raw = env.ADMIN_EMAILS ?? ""
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  )
}

/**
 * Context-free identity check, usable from services (no hono Context).
 * The permission resolvers call this to grant platform operators owner-level
 * access on every org/project — see resolveProjectRole / getEffectiveOrgRole.
 */
export const isPlatformAdminEmail = (env: Env, email: string): boolean =>
  parseAdminEmails(env).has(email.trim().toLowerCase())

/** True when the hydrated request user is a platform operator (by email). */
export const isPlatformAdmin = (c: Context<AuthHonoEnv>): boolean => {
  const user = c.get("user")
  if (!user) return false
  return isPlatformAdminEmail(c.env, user.email)
}

/**
 * Whether the admin console requires step-up elevation (the emailed 6-digit
 * code → 6h session). On when `ADMIN_REQUIRE_ELEVATION="true"`, EXCEPT under
 * `WRANGLER_LOCAL=1` (the local dev-stack / e2e signal, which also relaxes other
 * security for seeding) — so local dev and e2e keep the open console even though
 * the prod-shaped top-level [vars] turn elevation on. Separate from WHO is an
 * admin (`ADMIN_EMAILS`): identity is always enforced; this only governs the
 * extra step-up.
 */
export const adminElevationRequired = (env: Env): boolean =>
  env.ADMIN_REQUIRE_ELEVATION === "true" && env.WRANGLER_LOCAL !== "1"

/**
 * Reject any caller whose account email is not in the `ADMIN_EMAILS` allowlist.
 * Returns the same 403 shape as the org-role guards so the client handles it
 * uniformly. Every `/api/v2/admin/*` route mounts behind this — a single choke
 * point so there is no "forgot the check" path into cross-tenant data.
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

/**
 * Step-up "sudo" gate. Requires a currently-valid elevated session (granted by
 * POST /api/v2/admin/elevation/verify, see routes/admin.ts) before reaching the
 * console's data/config routes. Mounted AFTER the bootstrap routes (/me,
 * /elevation/request, /elevation/verify) so those stay reachable to establish
 * elevation.
 *
 * No-op when elevation isn't required (see adminElevationRequired) — so local/dev
 * and the existing admin-route tests are unaffected.
 */
export const requireAdminElevation = async (
  c: Context<AuthHonoEnv>,
  next: Next,
): Promise<Response | void> => {
  if (!adminElevationRequired(c.env)) {
    await next()
    return
  }
  const user = c.get("user")
  const row = await c.env.AQUILLA_PG.prepare(
    `SELECT 1 AS ok FROM admin_elevations WHERE user_id = ? AND elevated_until > now()`,
  )
    .bind(user.id)
    .first<{ ok: number }>()
  if (!row) {
    return c.json({ error: "elevation required" }, 403)
  }
  await next()
}
