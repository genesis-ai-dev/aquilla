// Frontier-style JWT signing + user lookup. Same wire format as the legacy
// frontier-server (HS256, claim `sub` = username, configurable expiry) so
// tokens minted here verify against the old server and vice versa.
//
// Ported from frontier-server/cloudflare/src/auth/jwt.ts, narrowed to AQUILLA_PG
// and the strict UserRow shape (no `any`).

import { sign, verify } from "hono/jwt"
import { JwtTokenExpired } from "hono/utils/jwt/types"
import type { Env, AuthUser, JWTPayload, UserRow } from "../types"

/**
 * Outcome of {@link JWTService.verifyTokenDetailed}. AQU-995: callers need to
 * tell a lapsed token apart from a malformed/forged one. Both are 401s, but
 * only one of them is a normal, expected event in a long-lived session — and
 * conflating them is what made the identity logs unreadable (thousands of
 * `Invalid or expired token` 401s a day, almost all of them routine expiry).
 */
export type TokenVerification =
  | { ok: true; payload: JWTPayload }
  | { ok: false; reason: "expired" | "invalid" }

/**
 * True when hono/jwt rejected the token specifically because `exp` has passed.
 * `instanceof` is the primary check; the `name` comparison covers the case
 * where the throwing hono copy isn't the one we imported (each worker package
 * installs its own — see the per-package lockfiles).
 */
function isExpiredTokenError(error: unknown): boolean {
  if (error instanceof JwtTokenExpired) return true
  return error instanceof Error && error.name === "JwtTokenExpired"
}

/**
 * AQU-995: a token becomes refreshable once it is past the half-way point of
 * its own lifetime. Expressed as a fraction of `exp - iat` rather than a fixed
 * number of days so it tracks ACCESS_TOKEN_EXPIRE_MINUTES automatically, and
 * so a client that polls more often than the half-life simply gets its own
 * token back instead of minting a new one on every call.
 *
 * A non-positive lifetime can only come from a hand-crafted token, which
 * cannot outlive `exp` anyway — treat it as refreshable rather than special.
 */
export function isPastHalfLife(
  payload: Pick<JWTPayload, "iat" | "exp">,
  nowSeconds: number,
): boolean {
  const lifetime = payload.exp - payload.iat
  if (!Number.isFinite(lifetime) || lifetime <= 0) return true
  return nowSeconds - payload.iat >= lifetime / 2
}

export class JWTService {
  private env: Env

  constructor(env: Env) {
    this.env = env
  }

  async createAccessToken(
    username: string,
    sessionStartedAt?: number,
  ): Promise<string> {
    const { token } = await this.createAccessTokenWithPayload(
      username,
      sessionStartedAt,
    )
    return token
  }

  /**
   * Mint a token and hand back its claims too, so a caller that needs to tell
   * the client when the new credential lapses doesn't have to re-verify the
   * token it just signed (or duplicate the lifetime arithmetic).
   *
   * `sessionStartedAt` is the original login time, carried forward by the
   * sliding refresh in POST /auth/refresh (AQU-995). Omit it on a real login.
   */
  async createAccessTokenWithPayload(
    username: string,
    sessionStartedAt?: number,
  ): Promise<{ token: string; payload: JWTPayload }> {
    if (!this.env.SECRET_KEY) {
      throw new Error("SECRET_KEY is not configured for JWT signing")
    }
    if (!this.env.ALGORITHM) {
      throw new Error("ALGORITHM is not configured for JWT signing")
    }
    const now = Math.floor(Date.now() / 1000)
    const expiresIn =
      parseInt(this.env.ACCESS_TOKEN_EXPIRE_MINUTES || "43200", 10) * 60

    const payload: JWTPayload = {
      sub: username,
      iat: now,
      exp: now + expiresIn,
      // [Pen test] Auth & session mgmt (2026-08-03): unique id so a logged-out
      // token can be denylisted individually — see utils/token-revocation.ts.
      jti: crypto.randomUUID(),
      // AQU-995: when the *session* began, as distinct from when this token was
      // minted. A refreshed token gets a fresh iat/exp, so without this claim
      // the chain forgets the original login and "how old is this session"
      // stops being answerable after the first refresh.
      sst: sessionStartedAt ?? now,
    }

    // hono/jwt's `sign` typing rejects arbitrary strings for `alg`, but we
    // validated the value above; cast narrowly to its allowed union.
    const token = await sign(
      payload,
      this.env.SECRET_KEY,
      this.env.ALGORITHM as "HS256",
    )
    return { token, payload }
  }

  async verifyToken(token: string): Promise<JWTPayload | null> {
    const result = await this.verifyTokenDetailed(token)
    return result.ok ? result.payload : null
  }

  /**
   * Same verification as {@link verifyToken}, but says *why* it failed.
   * Routine expiry is deliberately not logged: in a 30-day-token deployment it
   * is the single most common rejection and drowns out the malformed-token
   * cases that actually warrant a look (AQU-995).
   */
  async verifyTokenDetailed(token: string): Promise<TokenVerification> {
    if (!this.env.SECRET_KEY || !this.env.ALGORITHM) {
      return { ok: false, reason: "invalid" }
    }
    try {
      const payload = await verify(
        token,
        this.env.SECRET_KEY,
        this.env.ALGORITHM as "HS256",
      )
      return { ok: true, payload: payload as unknown as JWTPayload }
    } catch (error) {
      if (isExpiredTokenError(error)) return { ok: false, reason: "expired" }
      console.error("JWT verification failed:", error)
      return { ok: false, reason: "invalid" }
    }
  }

  /**
   * Lenient parser for the Authorization header. Accepts the canonical
   * `Bearer <jwt>`, a bare JWT, and a few non-standard schemes seen in the
   * wild (e.g. `token <jwt>`). Kept permissive to match the legacy
   * frontier-server's behaviour exactly.
   */
  extractTokenFromHeader(authHeader: string | null): string | null {
    if (!authHeader) return null
    const trimmed = authHeader.trim()
    const parts = trimmed.split(/\s+/)
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      return parts[1]
    }
    if (parts.length === 1 && parts[0].split(".").length === 3) {
      return parts[0]
    }
    for (const segment of parts) {
      if (segment.split(".").length === 3) return segment
    }
    return null
  }

  async getUserByUsername(username: string): Promise<AuthUser | null> {
    try {
      const result = await this.env.AQUILLA_PG.prepare(
        "SELECT * FROM users WHERE LOWER(username) = LOWER(?)",
      )
        .bind(username)
        .first<UserRow>()
      if (!result) return null
      return rowToUser(result)
    } catch (error) {
      console.error("Error fetching user by username:", error)
      return null
    }
  }

  async getUserByEmail(email: string): Promise<AuthUser | null> {
    try {
      const result = await this.env.AQUILLA_PG.prepare(
        "SELECT * FROM users WHERE LOWER(email) = LOWER(?)",
      )
        .bind(email)
        .first<UserRow>()
      if (!result) return null
      return rowToUser(result)
    } catch (error) {
      console.error("Error fetching user by email:", error)
      return null
    }
  }
}

export function rowToUser(row: UserRow): AuthUser {
  let prefs: Record<string, unknown> = {}
  if (row.preferences) {
    try {
      const parsed = JSON.parse(row.preferences) as unknown
      if (parsed && typeof parsed === "object") {
        prefs = parsed as Record<string, unknown>
      }
    } catch {
      // Bad JSON in legacy rows -> empty prefs; don't fail the login.
      prefs = {}
    }
  }
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    password_hash: row.password_hash,
    preferences: prefs,
    created_at: row.created_at,
    updated_at: row.updated_at,
    password_changed_at: row.password_changed_at ?? null,
  }
}
