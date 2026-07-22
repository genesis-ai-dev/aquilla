// Authorization middleware. Verifies a frontier-style JWT (HS256, claim
// `sub` = username) against AQUILLA_PG and stashes the hydrated user on the
// Hono context.
//
// Adapted from frontier-server/cloudflare/src/middleware/auth.ts. The
// Hetzner fallback path is gone — codex-web users always live in
// frontier-db-v2 by the time they reach this worker.

import type { Context, Next } from "hono"
import type { Env, Variables } from "../types"
import { JWTService } from "../auth/jwt"

export type AuthHonoEnv = { Bindings: Env; Variables: Variables }

export const authMiddleware = async (
  c: Context<AuthHonoEnv>,
  next: Next,
): Promise<Response | void> => {
  const authHeader = c.req.header("Authorization")
  if (!authHeader) {
    return c.json({ error: "Authorization header required" }, 401)
  }

  const jwtService = new JWTService(c.env)
  const token = jwtService.extractTokenFromHeader(authHeader)
  if (!token) {
    return c.json({ error: "Invalid authorization header format" }, 401)
  }

  const payload = await jwtService.verifyToken(token)
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401)
  }

  const now = Math.floor(Date.now() / 1000)
  if (payload.exp < now) {
    return c.json({ error: "Token expired" }, 401)
  }

  const user = await jwtService.getUserByUsername(payload.sub)
  if (!user) {
    return c.json({ error: "User not found" }, 401)
  }

  // [Pen test] Auth & session mgmt (2026-07-20): access tokens are stateless
  // and long-lived (ACCESS_TOKEN_EXPIRE_MINUTES, 30 days by default) with no
  // other revocation path, so a token minted before a password reset would
  // otherwise keep authenticating for up to 30 more days after the reset —
  // defeating the point of resetting a compromised password. Reject any
  // token issued before the account's last reset.
  if (user.password_changed_at) {
    const changedAtSeconds = Math.floor(
      new Date(user.password_changed_at).getTime() / 1000,
    )
    if (payload.iat < changedAtSeconds) {
      return c.json(
        { error: "Token invalidated by a password change. Please log in again." },
        401,
      )
    }
  }

  c.set("user", user)
  await next()
}
