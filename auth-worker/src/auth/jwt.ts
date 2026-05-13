// Frontier-style JWT signing + user lookup. Same wire format as the legacy
// frontier-server (HS256, claim `sub` = username, configurable expiry) so
// tokens minted here verify against the old server and vice versa.
//
// Ported from frontier-server/cloudflare/src/auth/jwt.ts, narrowed to CODEX_DB
// and the strict UserRow shape (no `any`).

import { sign, verify } from "hono/jwt"
import type { Env, AuthUser, JWTPayload, UserRow } from "../types"

export class JWTService {
  private env: Env

  constructor(env: Env) {
    this.env = env
  }

  async createAccessToken(username: string): Promise<string> {
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
    }

    // hono/jwt's `sign` typing rejects arbitrary strings for `alg`, but we
    // validated the value above; cast narrowly to its allowed union.
    return await sign(
      payload,
      this.env.SECRET_KEY,
      this.env.ALGORITHM as "HS256",
    )
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
      const result = await this.env.CODEX_DB.prepare(
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

  async getUserByEmail(email: string): Promise<AuthUser | null> {
    try {
      const result = await this.env.CODEX_DB.prepare(
        "SELECT * FROM users WHERE email = ?",
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
  }
}
