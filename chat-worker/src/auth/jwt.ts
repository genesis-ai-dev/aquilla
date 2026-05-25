// Frontier-style JWT verification + user lookup. Same wire format as the
// legacy frontier-server (HS256, claim `sub` = username) so tokens minted by
// aquilla-identity (or the legacy frontier-server) verify here transparently.
//
// Copied from aquilla-identity (auth-worker/src/auth/jwt.ts) and trimmed:
// the chat worker never *mints* tokens, so the signing helper is omitted.

import { verify } from "hono/jwt"
import type { Env, AuthUser, JWTPayload, UserRow } from "../types"

export class JWTService {
  private env: Env

  constructor(env: Env) {
    this.env = env
  }

  async verifyToken(token: string): Promise<JWTPayload | null> {
    if (!this.env.SECRET_KEY || !this.env.ALGORITHM) {
      return null
    }
    try {
      const payload = await verify(
        token,
        this.env.SECRET_KEY,
        this.env.ALGORITHM as "HS256",
      )
      return payload as unknown as JWTPayload
    } catch (error) {
      console.error("JWT verification failed:", error)
      return null
    }
  }

  /**
   * Lenient parser for the Authorization header. Accepts the canonical
   * `Bearer <jwt>`, a bare JWT, and a few non-standard schemes seen in the
   * wild (e.g. `token <jwt>`). Kept permissive to match the legacy
   * frontier-server's behaviour exactly so existing clients don't break.
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
      const result = await this.env.AUTH_DB.prepare(
        "SELECT * FROM users WHERE username = ?",
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
      // Bad JSON in legacy rows -> empty prefs; don't fail auth.
      prefs = {}
    }
  }
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    password_hash: row.password_hash,
    gitlab_user_id: row.gitlab_user_id,
    gitlab_username: row.gitlab_username,
    gitlab_token: row.gitlab_token,
    stripe_customer_id: row.stripe_customer_id,
    subscription_tier: row.subscription_tier,
    preferences: prefs,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
