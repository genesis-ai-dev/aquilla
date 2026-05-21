// Authorization middleware. Verifies a frontier-style JWT (HS256, claim
// `sub` = username) and stashes a JWT-derived user on the Hono context.
//
// We trust the JWT signature — anyone who can mint a token under the shared
// SECRET_KEY (aquilla-identity, or the legacy frontier-server) is a valid
// caller. The codex-web user landscape spans both directories (new users
// land in aquilla-db; legacy users live in frontier-db-v2) and there is no
// per-request data on the user record the chat route actually needs. A DB
// lookup against either directory in isolation would lock out half the
// population. The route never reads any user field beyond auth-success.

import type { Context, Next } from "hono"
import type { AuthUser, Env, Variables } from "../types"
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

  if (typeof payload.sub !== "string" || !payload.sub) {
    return c.json({ error: "Invalid token claims" }, 401)
  }

  c.set("user", userFromClaims(payload.sub))
  await next()
}

function userFromClaims(username: string): AuthUser {
  return {
    id: 0,
    username,
    email: "",
    password_hash: "",
    gitlab_user_id: null,
    gitlab_username: null,
    gitlab_token: null,
    stripe_customer_id: null,
    subscription_tier: null,
    preferences: {},
    created_at: "",
    updated_at: "",
  }
}
