// Isolate-memory session cache for authMiddleware (perf, 2026-09).
//
// Before this, EVERY authenticated request ran two queries before the route
// handler even started: `SELECT 1 FROM revoked_tokens WHERE jti = ?` and
// `SELECT * FROM users WHERE LOWER(username) = LOWER(?)`. The SPA's pollers
// (autopilot inspector every 4s, presence, etc.) made those the largest query
// families on prod. A resolved session is cached here, per isolate, keyed by
// the token's `jti` (or a SHA-256 of the raw token for pre-`jti` tokens), for
// SESSION_CACHE_TTL_MS. A hit skips both queries.
//
// ACCEPTED REVOCATION WINDOW: a token revoked (logout) or invalidated
// (password reset / profile edit) on THIS isolate is evicted immediately. On
// any OTHER isolate the cached entry lives out its TTL, so a revoked token
// keeps authenticating there for at most SESSION_CACHE_TTL_MS (30s). The
// hard revocation controls (30-day expiry, `password_changed_at` cutoff —
// re-checked on every hit from the cached row) still bound a stolen token;
// this only widens the logout race by half a minute.
//
// The cached user row has `password_hash` blanked: no authMiddleware consumer
// reads it (login and password-reset do their own lookups), and we don't
// want hashes sitting in isolate memory for 30s per active session.

import type { AuthUser, JWTPayload } from "../types"

export const SESSION_CACHE_TTL_MS = 30_000

interface CachedSession {
  user: AuthUser
  expiresAt: number
}

const sessions = new Map<string, CachedSession>()

/** Cache key for a verified token: its `jti`, else a hash of the raw token. */
export async function sessionCacheKey(payload: JWTPayload, token: string): Promise<string> {
  if (payload.jti) return `jti:${payload.jti}`
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
  return `tok:${hex.join("")}`
}

export function getCachedSession(key: string, now = Date.now()): AuthUser | null {
  const hit = sessions.get(key)
  if (!hit) return null
  if (hit.expiresAt <= now) {
    sessions.delete(key)
    return null
  }
  return hit.user
}

/** Stores a stripped copy of `user`; returns that copy so hit and miss paths
 *  hand callers the identical shape. */
export function setCachedSession(key: string, user: AuthUser, now = Date.now()): AuthUser {
  const stripped: AuthUser = { ...user, password_hash: "" }
  sessions.set(key, { user: stripped, expiresAt: now + SESSION_CACHE_TTL_MS })
  return stripped
}

/** Evict one token (logout). */
export function evictSessionByJti(jti: string): void {
  sessions.delete(`jti:${jti}`)
}

/** Evict every cached token for a user — after a profile edit or password
 *  change, so the next request re-hydrates the row. */
export function evictUserSessions(userId: number): void {
  for (const [key, entry] of sessions) {
    if (entry.user.id === userId) sessions.delete(key)
  }
}

export function clearSessionCache(): void {
  sessions.clear()
}
