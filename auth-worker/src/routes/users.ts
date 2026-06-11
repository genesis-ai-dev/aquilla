// User lookup + prefix-search routes. Ported from frontier-server's
// `cloudflare/src/routes/users.ts` (feat/user-search-and-email-invites).
//
// Both routes are auth-gated so anonymous scrapers can't enumerate users.

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import {
  lookupUserByUsername,
  searchUsersByPrefix,
  searchUsersByScopedPrefix,
} from "../services/user-lookup"

const SEARCH_MIN_PREFIX_LEN = 2
const SEARCH_DEFAULT_LIMIT = 10
const SEARCH_MAX_LIMIT = 25

const users = new Hono<AuthHonoEnv>()

users.use("*", authMiddleware)

/**
 * GET /api/v2/users/lookup?username=X
 *
 * Resolve a username to a public user record. Auth-gated; case-sensitive to
 * match existing auth behaviour. Used by the "Add member" UX.
 */
users.get("/lookup", async (c) => {
  const username = c.req.query("username")
  if (!username || username.trim() === "") {
    return c.json({ error: "username query parameter is required" }, 400)
  }
  const user = await lookupUserByUsername(c.env, username)
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
 * FRO-321: When ?scoped=1 (the invite picker's default), results are limited
 * to users that share an org or maintainer-accessible project with the caller.
 * Exact-match lookup for out-of-scope users is done via GET /users/lookup, which
 * does not confirm-or-deny on miss for privacy reasons.
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

  // FRO-321: ?scoped=1 restricts results to org/project-overlap users.
  // Default is unscoped for backward compat; new invite picker passes scoped=1.
  const scoped = c.req.query("scoped") === "1" || c.req.query("scoped") === "true"

  const matches = scoped
    ? await searchUsersByScopedPrefix(c.env, user.id, prefix, limit)
    : await searchUsersByPrefix(c.env, prefix, limit)

  return c.json({ users: matches })
})

export default users
