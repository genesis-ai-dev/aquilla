// Shared types for the codex-auth-worker.
//
// This worker is a side-by-side writer alongside the legacy frontier-server,
// both pointing at the same prod frontier-db-v2. Column names mirror the
// production schema (verified via wrangler d1 execute on 2026-05-12) so DB
// row casts are strongly typed without `any`.

export interface Env {
  /** Bound to frontier-db-v2 (prod) or frontier-db-v2-staging (staging). */
  AUTH_DB: D1Database

  // Frontier JWT signing (interchangeable with the old frontier-server).
  SECRET_KEY: string
  ALGORITHM: string
  ACCESS_TOKEN_EXPIRE_MINUTES: string

  // Sync-token signing (shared with codex-sync-worker; distinct from SECRET_KEY).
  SYNC_SECRET_KEY?: string

  // GitLab user provisioning for /register and PAT refresh on /token.
  GITLAB_URL?: string
  GITLAB_ADMIN_TOKEN?: string

  // Email (Resend) for password reset.
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
  BASE_URL?: string

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

export interface UserResponse {
  id: number
  username: string
  email: string
  gitlab_username: string | null
  preferences: Record<string, unknown>
}

export interface AuthResponse {
  access_token: string
  token_type: "bearer"
  gitlab_token?: string
  gitlab_url?: string
}

export interface JWTPayload {
  /** Username — matches the legacy frontier-server's claim layout. */
  sub: string
  exp: number
  iat: number
  [k: string]: unknown
}

/**
 * Sync-token claim shape — must match codex-sync-worker/src/auth.ts.
 * See `docs/SYNC.md` (this repo) for the security model.
 */
export interface SyncTokenClaims {
  userId: number
  username: string
  projectId: string
  fileId: string
  role: number
  aud: "sync"
  iat: number
  exp: number
}

export interface RoleResolution {
  level: number
  name: string
  source: "override" | "creator" | "gitlab"
}

export interface SyncTokenResponse {
  token: string
  expiresIn: number
  role: RoleResolution
}

/** Row shape of `project_invites` in frontier-db-v2. */
export interface ProjectInviteRow {
  token: string
  project_id: string
  role_level: number
  created_by: number
  created_at: string
  expires_at: string | null
  used_by: number | null
  used_at: string | null
}

/** Row shape of `project_members` in frontier-db-v2. */
export interface ProjectMemberRow {
  project_id: string
  user_id: number
  role_level: number
  granted_by: number | null
  granted_at: string
}

/** Row shape of `projects` in frontier-db-v2 — only the columns we read. */
export interface ProjectRow {
  id: string
  name: string
  gitlab_project_id: number | null
  org_id: number | null
  created_by: number
  archived_at: string | null
}

/** Numeric ladder; mirrors src/lib/frontier/roles.ts and the sync-worker. */
export const ROLE = {
  VIEWER: 100,
  COMMENTER: 200,
  REVIEWER: 300,
  CONTRIBUTOR: 400,
  PROJECT_LEAD: 500,
  MAINTAINER: 600,
  OWNER: 700,
} as const

/** Hard cap for link-share invites: never grant managerial roles via URL. */
export const LINK_ROLE_CAP = ROLE.CONTRIBUTOR

/** Minimum role required to mint a share-link invite for a project. */
export const INVITE_MIN_ROLE = ROLE.PROJECT_LEAD
