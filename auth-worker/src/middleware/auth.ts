// Authorization middleware. Verifies a frontier-style JWT (HS256, claim
// `sub` = username) against AQUILLA_PG and stashes the hydrated user on the
// Hono context.
//
// Adapted from frontier-server/cloudflare/src/middleware/auth.ts. Hydration is
// always Neon-only; the optional legacy bridge runs before token issuance.
//
// [Pen test] Auth & session mgmt (2026-08-31, OPS-25): every session check
// below lives in `resolveSession` rather than inline in `authMiddleware`, so
// the *optional*-identity routes (public invite previews) run the identical
// checks. Three route files previously hand-rolled their own "best-effort
// caller" helper that verified only the signature and `exp` — skipping the
// `jti` denylist and the `password_changed_at` cutoff, i.e. both of this
// codebase's revocation controls. See `optionalCaller` below.

import type { Context, Next } from "hono"
import type { AuthUser, Env, JWTPayload, Variables } from "../types"
import { JWTService } from "../auth/jwt"
import { isTokenRevoked } from "../utils/token-revocation"
import { getCachedSession, sessionCacheKey, setCachedSession } from "../lib/session-cache"

export type AuthHonoEnv = { Bindings: Env; Variables: Variables }

/**
 * Why a session was rejected. Each maps to a distinct response in
 * `authMiddleware`; `optionalCaller` collapses them all to "anonymous".
 */
export type SessionRejection =
  | "missing_header"
  | "malformed_header"
  | "expired"
  | "invalid_token"
  | "revoked"
  | "user_not_found"
  | "password_changed"
  /** Session's total age (from `sst`) exceeds MAX_SESSION_AGE_DAYS — see the
   *  [Pen test] comment below `resolveSession`'s absolute-age check. */
  | "session_expired"
  /** Lookup failed (DB unreachable), as opposed to "no such user" — AQU-994. */
  | "hydration_error"

export type SessionResolution =
  | { ok: true; user: AuthUser; payload: JWTPayload; sessionKey: string }
  | { ok: false; reason: SessionRejection }

/**
 * The single implementation of "is this Authorization header a live session?".
 *
 * Both callers in this file go through it, which is the point: a check added
 * here (revocation, password-reset invalidation, whatever comes next) applies
 * to the optional-identity routes automatically instead of having to be
 * remembered at each hand-written copy.
 */
export async function resolveSession(
  env: Env,
  authHeader: string | null | undefined,
): Promise<SessionResolution> {
  if (!authHeader) return { ok: false, reason: "missing_header" }

  const jwtService = new JWTService(env)
  const token = jwtService.extractTokenFromHeader(authHeader)
  if (!token) return { ok: false, reason: "malformed_header" }

  // AQU-995: expiry gets its own reason. It is by far the most common
  // rejection here (30-day tokens, no refresh until now) and it is a normal
  // event, not a fault — separating it lets ops read real malformed-token
  // incidents out of the identity logs, and lets the SPA act on a lapsed
  // session without pattern-matching a shared message.
  const verification = await jwtService.verifyTokenDetailed(token)
  if (!verification.ok) {
    return {
      ok: false,
      reason: verification.reason === "expired" ? "expired" : "invalid_token",
    }
  }
  const payload = verification.payload

  // This replaces a `payload.exp < now` check that could never fire —
  // hono/jwt's `verify` already throws JwtTokenExpired on a lapsed `exp`, so
  // reaching here means expiry was checked. What it never covered, and this
  // does, is a token carrying *no* exp claim at all: that verifies cleanly and
  // would otherwise authenticate forever.
  if (typeof payload.exp !== "number") {
    return { ok: false, reason: "invalid_token" }
  }

  // [Pen test] Auth & session mgmt (2026-09-14): the sliding refresh (AQU-995,
  // POST /auth/refresh) re-mints a token past its half-life with no ceiling on
  // the *session's* total age — `sst` (original login time) is carried
  // forward across every refresh but was never actually checked against
  // anything. A token kept alive by a script calling /auth/refresh every ~15
  // days (half the 30-day lifetime) never had to die: the 30-day bound on a
  // leaked/stolen credential's blast radius didn't hold once refresh shipped.
  // This caps total session age at MAX_SESSION_AGE_DAYS (default 90) from the
  // original login, independent of how often it's been refreshed, and is
  // checked on every request (not just at refresh) so a session that crosses
  // the cap is cut off immediately rather than merely losing its ability to
  // extend further. `sst` falls back to `iat` for tokens minted before AQU-995
  // added the claim, matching the fallback POST /auth/refresh already uses.
  const sessionStartedAt = typeof payload.sst === "number" ? payload.sst : payload.iat
  const maxSessionAgeSeconds = parseInt(env.MAX_SESSION_AGE_DAYS || "90", 10) * 24 * 60 * 60
  if (Math.floor(Date.now() / 1000) - sessionStartedAt > maxSessionAgeSeconds) {
    return { ok: false, reason: "session_expired" }
  }

  // Perf (2026-09): the revocation lookup + user hydration below are cached
  // per isolate for SESSION_CACHE_TTL_MS (see lib/session-cache.ts for the
  // accepted cross-isolate revocation window). The password_changed_at cutoff
  // still runs on every hit — it only needs the cached row and the token.
  //
  // [Pen test] Auth & session mgmt (2026-09-21, OPS-35): this key doubles as
  // the request's *session identity* and is handed to callers as
  // `sessionKey`. It is the one value in this file that names THIS token
  // rather than its bearer, which is what a per-session (as opposed to
  // per-account) authorization state has to be bound to — see
  // `requireAdminElevation`. Reusing the cache key rather than reading
  // `payload.jti` directly is deliberate: `sessionCacheKey` already handles
  // pre-`jti` tokens by falling back to a SHA-256 of the raw token, so a
  // binding built on it covers legacy tokens too, and neither arm stores a
  // replayable secret (a `jti` is already denylisted in the clear in
  // `revoked_tokens`; the fallback is a hash).
  const cacheKey = await sessionCacheKey(payload, token)
  let user = getCachedSession(cacheKey)

  if (!user) {
    // [Pen test] Auth & session mgmt (2026-08-03): reject tokens the caller
    // explicitly logged out (POST /auth/logout) rather than only relying on
    // natural 30-day expiry or a full password reset. See
    // utils/token-revocation.ts.
    if (payload.jti && (await isTokenRevoked(env.AQUILLA_PG, payload.jti))) {
      return { ok: false, reason: "revoked" }
    }

    // AQU-994: hydration hitting a DB error must NOT read as an auth failure.
    // During the 2026-08-25 Postgres/Hyperdrive blip the old code answered 401
    // "User not found" for every authenticated request, and the SPA responded by
    // force-logging active editors out (and revoking their still-valid tokens).
    // The caller turns this into a 503 "retry later" rather than impugning the
    // credential.
    let hydrated: Awaited<ReturnType<typeof jwtService.getUserByUsername>>
    try {
      hydrated = await jwtService.getUserByUsername(payload.sub)
    } catch {
      return { ok: false, reason: "hydration_error" }
    }
    if (!hydrated) return { ok: false, reason: "user_not_found" }
    user = setCachedSession(cacheKey, hydrated)
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
      return { ok: false, reason: "password_changed" }
    }
  }

  return { ok: true, user, payload, sessionKey: cacheKey }
}

/**
 * AQU-347: best-effort caller identity for the *public* invite-preview routes
 * (`routes/invites.ts`, `routes/orgs.ts`, `routes/projects.ts`). A
 * missing/invalid/expired token is not an error — it just means "treat this
 * preview as anonymous", since those routes must stay reachable for signed-out
 * visitors following a share link.
 *
 * OPS-25: "not an error" is not the same as "not checked". This resolves
 * through {@link resolveSession}, so a logged-out (`jti`-denylisted) or
 * password-reset-invalidated token now reads as anonymous instead of as its
 * former owner. A hydration failure also reads as anonymous here — unlike
 * `authMiddleware` there is no credential to impugn and no 503 to return, and
 * anonymous is the conservative answer for a route whose caller identity only
 * ever *widens* what the response discloses.
 */
export async function optionalCaller(
  env: Env,
  authHeader: string | null | undefined,
): Promise<AuthUser | null> {
  const resolved = await resolveSession(env, authHeader)
  return resolved.ok ? resolved.user : null
}

export const authMiddleware = async (
  c: Context<AuthHonoEnv>,
  next: Next,
): Promise<Response | void> => {
  const resolved = await resolveSession(c.env, c.req.header("Authorization"))

  if (!resolved.ok) {
    switch (resolved.reason) {
      case "missing_header":
        return c.json({ error: "Authorization header required" }, 401)
      case "malformed_header":
        return c.json({ error: "Invalid authorization header format" }, 401)
      case "expired":
        return c.json({ error: "Token expired", code: "token_expired" }, 401)
      case "invalid_token":
        return c.json({ error: "Invalid or expired token", code: "invalid_token" }, 401)
      case "revoked":
        return c.json({ error: "Token has been revoked. Please log in again." }, 401)
      case "hydration_error":
        return c.json(
          { error: "Unable to verify session right now. Please retry." },
          503,
        )
      case "user_not_found":
        return c.json({ error: "User not found" }, 401)
      case "password_changed":
        return c.json(
          { error: "Token invalidated by a password change. Please log in again." },
          401,
        )
      case "session_expired":
        return c.json(
          {
            error: "Session expired after prolonged use. Please log in again.",
            code: "session_expired",
          },
          401,
        )
    }
  }

  c.set("user", resolved.user)
  c.set("tokenPayload", resolved.payload)
  c.set("sessionKey", resolved.sessionKey)
  await next()
}
