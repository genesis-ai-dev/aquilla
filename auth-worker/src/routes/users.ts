// User lookup + prefix-search routes. Ported from frontier-server's
// `cloudflare/src/routes/users.ts` (feat/user-search-and-email-invites).
//
// Both routes are auth-gated so anonymous scrapers can't enumerate users.

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import {
  lookupUserByUsername,
  searchUsersByPrefix,
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
 * GET /api/v2/users/search?prefix=X&limit=N
 *
 * Username prefix search for the Add-member typeahead. Empty result set
 * returns 200 with an empty array.
 */
users.get("/search", async (c) => {
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

  const matches = await searchUsersByPrefix(c.env, prefix, limit)
  return c.json({ users: matches })
})

export default users
