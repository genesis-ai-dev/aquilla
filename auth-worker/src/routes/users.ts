// User lookup + prefix-search routes. Ported from frontier-server's
// `cloudflare/src/routes/users.ts` (feat/user-search-and-email-invites).
//
// Both routes are auth-gated so anonymous scrapers can't enumerate users.

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { enforceRateLimit, userRateLimitIdentifier } from "../../../db/shared/rate-limit"
import { isPlatformAdmin } from "../middleware/platform-admin"
import {
  lookupUserByUsername,
  lookupUserByUsernameOrEmail,
  searchUsersByPrefix,
  searchUsersByScopedPrefix,
} from "../services/user-lookup"
import { callerCanSearchUsers } from "../services/user-search-access"
import { resolveProjectRole } from "../services/project-permissions"
import { ROLE } from "../types"
import { looksLikeEmail } from "../../../db/shared/mask-email"

const SEARCH_MIN_PREFIX_LEN = 2
const SEARCH_DEFAULT_LIMIT = 10
const SEARCH_MAX_LIMIT = 25

// Pen-test 2026-10-15: /lookup is an exact username -> id oracle open to any
// self-registered account. A per-user window makes bulk enumeration slow while
// leaving the Add-member flow (a handful of lookups) untouched.
const LOOKUP_MAX_PER_USER_PER_WINDOW = 60

const users = new Hono<AuthHonoEnv>()

users.use("*", authMiddleware)

/**
 * GET /api/v2/users/lookup?username=X[&projectId=UUID]
 *
 * Resolve a username to a public user record. Auth-gated. Trimmed +
 * case-insensitive (AQU-457) — matches lookupUserByUsername. Used by the
 * "Add member" UX.
 *
 * AQU-2576: with `projectId`, the identifier may ALSO be an email address,
 * resolved to the account whose login email matches (case-insensitive). A
 * project owner staffing a project usually has the person's email and nothing
 * else — the account exists, only the lookup key was missing, and walking
 * other projects' rosters to recover a username is not a workflow.
 *
 * The email branch is behind `projectId` precisely because it is an
 * email -> account oracle, so it is scoped to the people who can already act
 * on that answer: the same `role >= project_lead` bar that POST
 * /projects/:id/members enforces. Without `projectId` the route behaves
 * exactly as before — username only — so no existing caller gains the oracle,
 * and a caller who names a project they cannot staff is refused before any
 * lookup runs (the refusal must not depend on whether the address exists).
 */
users.get("/lookup", async (c) => {
  const username = c.req.query("username")
  const trimmed = username?.trim() ?? ""
  if (!trimmed) {
    return c.json({ error: "username query parameter is required" }, 400)
  }
  const projectId = c.req.query("projectId")?.trim() ?? ""
  let allowEmail = false
  if (projectId) {
    const callerRole = await resolveProjectRole(c.env, c.get("user"), projectId)
    if (!callerRole || callerRole.level < ROLE.PROJECT_LEAD) {
      return c.json(
        { error: "role >= project_lead required to look a member up by email" },
        403,
      )
    }
    allowEmail = true
  }
  if (!allowEmail && looksLikeEmail(trimmed)) {
    // Fail closed rather than silently falling through to a username lookup
    // that can never match: the caller asked a question this route will not
    // answer unscoped, and saying so is what sends them to the scoped call.
    return c.json(
      { error: "email lookup requires a projectId you can add members to" },
      400,
    )
  }
  const limit = await enforceRateLimit(c.env.AQUILLA_PG, {
    kind: "users_lookup",
    identifier: userRateLimitIdentifier(c.get("user").id),
    limit: LOOKUP_MAX_PER_USER_PER_WINDOW,
    failMode: "open",
  })
  if (!limit.allowed) {
    return c.json(
      { error: "Too many lookups. Try again shortly." },
      429,
      { "Retry-After": String(limit.retryAfterSeconds) },
    )
  }
  const user = allowEmail
    ? await lookupUserByUsernameOrEmail(c.env, trimmed)
    : await lookupUserByUsername(c.env, trimmed)
  if (!user) {
    return c.json({ error: "user not found" }, 404)
  }
  return c.json(user)
})

/**
 * GET /api/v2/users/search?prefix=X&limit=N[&scoped=1]
 *
 * Username prefix search for the Add-member typeahead. Empty result set
 * returns 200 with an empty array.
 *
 * AQU-321 / pen-test (2026-07-21): results are always scoped to users that
 * share an org or maintainer-accessible project with the caller — the
 * `?scoped=1` param is accepted for backward compat but no longer has an
 * "off" position for ordinary callers. The unscoped branch used to be the
 * *default* (reachable by any authenticated user simply by omitting the
 * param), which let anyone walk two-character prefixes to enumerate every
 * username/id on the platform regardless of org/project membership —
 * defeating the point of the scoping this route already claimed to enforce.
 * Platform admins (ADMIN_EMAILS) keep the unscoped path for cross-tenant
 * support lookups, mirroring the access they already have via /admin/users.
 * Exact-match lookup for out-of-scope users is done via GET /users/lookup, which
 * is per-user rate limited (it does confirm hits, so it must not be bulk-walkable).
 *
 * AQU-625: a caller who cannot see a member roster is rejected here, not only
 * in the Share panel. Hiding the field still leaves this route callable.
 * Platform admins keep the unscoped support path.
 */
users.get("/search", async (c) => {
  const user = c.get("user")
  const prefix = c.req.query("prefix")?.trim() ?? ""
  if (prefix.length < SEARCH_MIN_PREFIX_LEN) {
    return c.json(
      { error: `prefix must be at least ${SEARCH_MIN_PREFIX_LEN} characters` },
      400,
    )
  }

  const limitRaw = c.req.query("limit")
  let limit = SEARCH_DEFAULT_LIMIT
  if (limitRaw) {
    const n = parseInt(limitRaw, 10)
    if (Number.isFinite(n) && n > 0) {
      limit = Math.min(n, SEARCH_MAX_LIMIT)
    }
  }

  const wantsUnscoped = !(
    c.req.query("scoped") === "1" || c.req.query("scoped") === "true"
  )
  // Platform admins can see every roster (resolveProjectRole grants them
  // owner). The client always sends scoped=1, so the exemption cannot be
  // limited to the unscoped support path or Share search 403s for them.
  const admin = await isPlatformAdmin(c)
  if (admin && wantsUnscoped) {
    return c.json({ users: await searchUsersByPrefix(c.env, prefix, limit) })
  }
  if (!admin && !(await callerCanSearchUsers(c.env, user.id))) {
    return c.json({ error: "roster hidden by org policy", rosterHidden: true }, 403)
  }
  return c.json({ users: await searchUsersByScopedPrefix(c.env, user.id, prefix, limit) })
})

export default users
