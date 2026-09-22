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
 * Whether the current request carries an active step-up elevation (granted by
 * POST /api/v2/admin/elevation/verify, see routes/admin.ts) — or elevation
 * isn't required in this environment at all (see adminElevationRequired), in
 * which case every platform admin counts as elevated.
 *
 * Extracted from requireAdminElevation so a handler outside `/admin/*` can
 * ask the same question imperatively — e.g. a governance WRITE reached only
 * via the platform-admin fallback (not genuine membership) on an org-scoped
 * route. Those routes stay open (no elevation) for a genuine owner; this is
 * for the platform-admin-only branch.
 *
 * [Pen test] Auth & session mgmt (2026-09-21, OPS-35): the elevated session is
 * bound to the CREDENTIAL that established it (`session_key`), not merely to
 * the account. It used to be keyed on `user_id` alone, which defeated this
 * gate against the one attacker it names: the brute-force comment on
 * /elevation/verify describes "a caller already holding a valid (e.g. stolen)
 * non-elevated admin JWT", and under an account-wide grant that caller became
 * elevated the moment the *real* operator elevated on their own machine — for
 * the whole ELEVATION_SESSION_HOURS window, without ever seeing the emailed
 * code. Matching on the session key means the code has to be redeemed by the
 * same token that then uses the console.
 *
 * The binding lives HERE rather than in requireAdminElevation so that every
 * caller inherits it — the imperative callers above reach the same
 * platform-admin power by a different route, and an account-scoped check there
 * would re-open OPS-35 on exactly the paths that skip the middleware.
 */
export const hasActiveElevation = async (c: Context<AuthHonoEnv>): Promise<boolean> => {
  if (!adminElevationRequired(c.env)) return true
  const user = c.get("user")
  const row = await c.env.AQUILLA_PG.prepare(
    `SELECT 1 AS ok FROM admin_elevations
      WHERE user_id = ? AND session_key = ? AND elevated_until > now()`,
  )
    .bind(user.id, c.get("sessionKey"))
    .first<{ ok: number }>()
  return row != null
}

/**
 * Step-up "sudo" gate. Requires a currently-valid elevated session before
 * reaching the console's data/config routes. Mounted AFTER the bootstrap
 * routes (/me, /elevation/request, /elevation/verify) so those stay reachable
 * to establish elevation.
 *
 * The session binding that makes this gate meaningful (OPS-35) lives in
 * {@link hasActiveElevation}, which this delegates to.
 *
 * No-op when elevation isn't required (see adminElevationRequired) — so local/dev
 * and the existing admin-route tests are unaffected.
 */
export const requireAdminElevation = async (
  c: Context<AuthHonoEnv>,
  next: Next,
): Promise<Response | void> => {
  if (!(await hasActiveElevation(c))) {
    return c.json({ error: "elevation required" }, 403)
  }
  await next()
}
