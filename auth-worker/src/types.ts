// Shared types for the codex-auth-worker.
//
// Single D1 (`codex` prod, `codex-staging` staging) owns everything codex-web
// touches — identity, orgs, projects, members, invites, plus the file/cell
// projections sync-worker writes. Schema is defined in
// `auth-worker/migrations/0001_initial.sql`.

export interface Env {
  /** Bound to `codex` (prod) or `codex-staging` (staging). Shared with
   *  codex-sync-worker (same database_id). */
  AQUILLA_DB: D1Database

  // Frontier JWT signing. Rotated for the clean break — tokens minted by
  // the legacy frontier-server no longer verify here.
  SECRET_KEY: string
  ALGORITHM: string
  ACCESS_TOKEN_EXPIRE_MINUTES: string

  // Sync-token signing AND admin auth to codex-sync-worker. Shared between
  // auth-worker and sync-worker.
  SYNC_SECRET_KEY?: string

  /** codex-sync-worker base URL for archive / file-delete notifications. */
  SYNC_WORKER_URL?: string

  // Email (Resend) for password reset.
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
  BASE_URL?: string

  ENVIRONMENT?: string

  /**
   * When set to "1", exposes `/__test__/reset` and skips authentication on
   * sensitive routes that the E2E harness needs to seed. NEVER set in
   * production — gated explicitly so an accidental config flip doesn't
   * expose admin routes.
   */
  WRANGLER_LOCAL?: string
}

export type Variables = {
  user: AuthUser
}

/**
 * Row shape of the `users` table. Mirrors the schema in
 * `auth-worker/migrations/0001_initial.sql`. Legacy gitlab_* / stripe_*
 * columns were removed in the clean-break migration (2026-05-13).
 */
export interface UserRow {
  id: number
  username: string
  email: string
  password_hash: string
  preferences: string
  created_at: string
  updated_at: string
}

/** Hydrated user injected into request context by `authMiddleware`. */
export interface AuthUser {
  id: number
  username: string
  email: string
  password_hash: string
  preferences: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface UserResponse {
  id: number
  username: string
  email: string
  preferences: Record<string, unknown>
}

export interface AuthResponse {
  access_token: string
  token_type: "bearer"
}

export interface JWTPayload {
  /** Username — sub claim. */
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
  source: "override" | "creator" | "org"
}

export interface SyncTokenResponse {
  token: string
  expiresIn: number
  role: RoleResolution
}

/** Row shape of `project_invites`. */
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

/** Row shape of `project_members`. */
export interface ProjectMemberRow {
  project_id: string
  user_id: number
  role_level: number
  granted_by: number | null
  granted_at: string
}

/** Row shape of `projects` — only the columns we read. */
export interface ProjectRow {
  id: string
  name: string
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
