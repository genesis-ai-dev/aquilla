// Authorization middleware. Verifies a frontier-style JWT (HS256, claim
// `sub` = username) against AUTH_DB and stashes the hydrated user on the
// Hono context.
//
// Copied from codex-auth-worker (auth-worker/src/middleware/auth.ts). Kept
// 1:1 so any tightening of the auth path can be applied uniformly across
// both workers.

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

  c.set("user", user)
  await next()
}
