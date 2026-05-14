// Shared types for the aquilla-chat-worker.
//
// This worker verifies a frontier-style JWT against frontier-db-v2 (shared
// with codex-auth-worker and the legacy frontier-server) and forwards
// completion requests to OpenRouter. No billing tables are read or written
// here; we only need the fields that prove the bearer is a valid user.

export interface Env {
  /** Bound to frontier-db-v2 (prod) or frontier-db-v2-staging (staging). */
  AUTH_DB: D1Database

  // Frontier JWT signing — MUST match codex-auth-worker.
  SECRET_KEY: string
  ALGORITHM: string

  // Outbound auth for openrouter.ai.
  OPENROUTER_API_KEY: string

  // Used when the client sends model "default" / "free-tier" / "" /
  // null / undefined — mirrors the legacy frontier-server's behaviour so
  // existing codex-web clients don't break when they pass "default".
  DEFAULT_LLM_MODEL?: string

  ENVIRONMENT?: string
}

export type Variables = {
  user: AuthUser
}

/**
 * Row shape of the `users` table in frontier-db-v2. Mirrors the production
 * schema verified on 2026-05-12 — kept narrow so this worker only relies on
 * columns the legacy frontier-server also writes.
 */
export interface UserRow {
  id: number
  username: string
  email: string
  password_hash: string
  gitlab_user_id: number | null
  gitlab_username: string | null
  gitlab_token: string | null
  stripe_customer_id: string | null
  subscription_tier: string | null
  preferences: string | null
  created_at: string
  updated_at: string
}

/** Hydrated user injected into request context by `authMiddleware`. */
export interface AuthUser {
  id: number
  username: string
  email: string
  password_hash: string
  gitlab_user_id: number | null
  gitlab_username: string | null
  gitlab_token: string | null
  stripe_customer_id: string | null
  subscription_tier: string | null
  preferences: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface JWTPayload {
  /** Username — matches the legacy frontier-server's claim layout. */
  sub: string
  exp: number
  iat: number
  [k: string]: unknown
}
