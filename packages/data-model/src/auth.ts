// Auth types — identity service (apps/identity/ once
// 3e merges; currently auth-worker/).

export interface User {
  id: number
  username: string
  email: string
  displayName?: string
  preferences: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface LoginRequest {
  email: string
  password: string
}

export interface LoginResponse {
  /** JWT, sub=username, aud=access. Stored in a parent-domain cookie. */
  accessToken: string
  user: User
  /** Memberships on the user's projects (lightweight; for the project list). */
  memberships?: Array<{
    projectId: string
    projectName: string
    roleLevel: number
  }>
}

export interface SignupRequest {
  email: string
  password: string
  displayName?: string
}

export interface PasswordResetRequestBody {
  email: string
}

export interface PasswordResetSubmitBody {
  token: string
  newPassword: string
}

/**
 * Claims on the access-token JWT. aud=access; separate from sync-tokens
 * (aud=sync) which are minted per-project for sync-worker authorization.
 */
export interface AccessTokenClaims {
  sub: string
  /** Numeric user id. */
  userId: number
  username: string
  /** Issued-at, seconds since epoch. */
  iat: number
  /** Expires-at, seconds since epoch. */
  exp: number
  aud: "access"
}

/** Sync-token claims — minted per project for sync-worker WS + REST auth. */
export interface SyncTokenClaims {
  sub: string
  userId: number
  username: string
  projectId: string
  /** Optional file scoping (legacy; project DO ignores). */
  fileId?: string
  /** Numeric role level (100=viewer..700=owner). */
  role: number
  iat: number
  exp: number
  aud: "sync"
}
