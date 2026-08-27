// Authorization middleware. Verifies a frontier-style JWT (HS256, claim
// `sub` = username) against AQUILLA_PG and stashes the hydrated user on the
// Hono context.
//
// Adapted from frontier-server/cloudflare/src/middleware/auth.ts. Hydration is
// always Neon-only; the optional legacy bridge runs before token issuance.

import type { Context, Next } from "hono"
import type { Env, Variables } from "../types"
import { JWTService } from "../auth/jwt"
import { isTokenRevoked } from "../utils/token-revocation"

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

  // AQU-995: expiry gets its own response body and `code`. It is by far the
  // most common 401 here (30-day tokens, no refresh until now) and it is a
  // normal event, not a fault — separating it lets ops read real
  // malformed-token incidents out of the identity logs, and lets the SPA act
  // on a lapsed session without pattern-matching a shared message.
  const verification = await jwtService.verifyTokenDetailed(token)
  if (!verification.ok) {
    return verification.reason === "expired"
      ? c.json({ error: "Token expired", code: "token_expired" }, 401)
      : c.json({ error: "Invalid or expired token", code: "invalid_token" }, 401)
  }
  const payload = verification.payload

  // This replaces a `payload.exp < now` check that could never fire —
  // hono/jwt's `verify` already throws JwtTokenExpired on a lapsed `exp`, so
  // reaching here means expiry was checked. What it never covered, and this
  // does, is a token carrying *no* exp claim at all: that verifies cleanly and
  // would otherwise authenticate forever.
  if (typeof payload.exp !== "number") {
    return c.json({ error: "Invalid or expired token", code: "invalid_token" }, 401)
  }

  // [Pen test] Auth & session mgmt (2026-08-03): reject tokens the caller
  // explicitly logged out (POST /auth/logout) rather than only relying on
  // natural 30-day expiry or a full password reset. See
  // utils/token-revocation.ts.
  if (payload.jti && (await isTokenRevoked(c.env.AQUILLA_PG, payload.jti))) {
    return c.json({ error: "Token has been revoked. Please log in again." }, 401)
  }

  // AQU-994: hydration hitting a DB error must NOT read as an auth failure.
  // During the 2026-08-25 Postgres/Hyperdrive blip the old code answered 401
  // "User not found" for every authenticated request, and the SPA responded by
  // force-logging active editors out (and revoking their still-valid tokens).
  // 503 tells clients "retry later" without impugning the credential.
  let user: Awaited<ReturnType<typeof jwtService.getUserByUsername>>
  try {
    user = await jwtService.getUserByUsername(payload.sub)
  } catch {
    return c.json(
      { error: "Unable to verify session right now. Please retry." },
      503,
    )
  }
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
  c.set("tokenPayload", payload)
  await next()
}
