// Pure JWT verification for sync-token claims issued by frontier-server's
// POST /api/v2/sync-token. Kept dependency-free from Durable Object / worker
// bindings so it can be unit-tested directly.

import { verify } from "hono/jwt"

export interface SyncTokenClaims {
  userId: number
  /** Frontier username stamped by /sync-token. Older tokens may omit it. */
  username?: string
  projectId: string
  fileId: string
  role: number
  aud: "sync"
  iat: number
  exp: number
}

/**
 * Contributor role level — minimum required to push Y.Doc updates. Viewer
 * (100), commenter (200), and reviewer (300) all connect successfully but
 * their writes are silently dropped by isReadOnly. Kept here (alongside the
 * token claims) so the DO and any future role-gating logic share one source.
 */
export const WRITE_ROLE_LEVEL = 400

/**
 * Pure read-only check. null/undefined role means "role unknown" — happens in
 * ALLOW_UNAUTHENTICATED dev mode when onBeforeConnect doesn't stash a role
 * header on the request — and defaults to permissive (return false) so local
 * dev without tokens still lets edits through.
 */
export function shouldBeReadOnly(role: number | null | undefined): boolean {
  if (role == null) return false
  return role < WRITE_ROLE_LEVEL
}

export type AuthResult =
  | { ok: true; claims: SyncTokenClaims }
  | { ok: false; status: 401 | 403 | 500; reason: string }

export async function verifyTokenForDoc(
  token: string | null | undefined,
  expected: { projectId: string; fileId: string },
  secret: string | undefined
): Promise<AuthResult> {
  if (!secret) {
    return { ok: false, status: 500, reason: "SYNC_SECRET_KEY not configured" }
  }
  if (!token) {
    return { ok: false, status: 401, reason: "missing token" }
  }

  let claims: SyncTokenClaims
  try {
    claims = (await verify(token, secret, "HS256")) as unknown as SyncTokenClaims
  } catch (err) {
    // hono/jwt throws distinct error names for exp vs signature; surface them
    // so the diag log tells us why the client was rejected.
    const name = (err as { name?: string }).name
    if (name === "JwtTokenExpired") {
      return { ok: false, status: 401, reason: "token expired" }
    }
    return { ok: false, status: 401, reason: "invalid token signature" }
  }

  if (claims.aud !== "sync") {
    // Frontier access tokens have sub but no aud=sync; rejecting here prevents
    // a frontier JWT from being replayed against the sync worker.
    return { ok: false, status: 401, reason: "wrong audience" }
  }

  if (claims.projectId !== expected.projectId) {
    return { ok: false, status: 403, reason: "token scoped to different project" }
  }
  if (claims.fileId !== expected.fileId) {
    return { ok: false, status: 403, reason: "token scoped to different file" }
  }

  return { ok: true, claims }
}

/**
 * Verify a sync-token JWT for a project-scoped operation. Unlike
 * verifyTokenForDoc / verifyTokenForFile, this checks only the projectId —
 * useful for project-level reads (list files, list cells across files) and
 * for the per-project Durable Object WS connection (presence + focus locks
 * span every file in the project, so the file scope is irrelevant). The
 * token must still be a valid `aud=sync` token; the claims' role doubles as
 * the project-membership check (every sync-token issued by auth-worker is
 * gated on project_members at mint time, so a valid token with
 * `projectId === expected` implies the user is a viewer (100) or higher on
 * that project).
 */
export async function verifyTokenForProject(
  token: string | null | undefined,
  expectedProjectId: string,
  secret: string | undefined,
): Promise<AuthResult> {
  if (!secret) {
    return { ok: false, status: 500, reason: "SYNC_SECRET_KEY not configured" }
  }
  if (!token) {
    return { ok: false, status: 401, reason: "missing token" }
  }

  let claims: SyncTokenClaims
  try {
    claims = (await verify(token, secret, "HS256")) as unknown as SyncTokenClaims
  } catch (err) {
    const name = (err as { name?: string }).name
    if (name === "JwtTokenExpired") {
      return { ok: false, status: 401, reason: "token expired" }
    }
    return { ok: false, status: 401, reason: "invalid token signature" }
  }

  if (claims.aud !== "sync") {
    return { ok: false, status: 401, reason: "wrong audience" }
  }

  if (claims.projectId !== expectedProjectId) {
    return { ok: false, status: 403, reason: "token scoped to different project" }
  }

  // Viewer-level (100+) is required to read. All sync-tokens are issued at
  // role 100+ by auth-worker, so this primarily guards against malformed
  // claims; a legitimate token from a non-member will never reach here.
  if (typeof claims.role !== "number" || claims.role < 100) {
    return { ok: false, status: 403, reason: "insufficient role" }
  }

  return { ok: true, claims }
}

/**
 * Like verifyTokenForDoc but only requires fileId match — projectId comes
 * from the verified token's claims. Used by reads where the caller doesn't
 * have the project context up front (e.g. GET /events?fileId=...).
 */
export async function verifyTokenForFile(
  token: string | null | undefined,
  expectedFileId: string,
  secret: string | undefined,
): Promise<AuthResult> {
  if (!secret) {
    return { ok: false, status: 500, reason: "SYNC_SECRET_KEY not configured" }
  }
  if (!token) {
    return { ok: false, status: 401, reason: "missing token" }
  }

  let claims: SyncTokenClaims
  try {
    claims = (await verify(token, secret, "HS256")) as unknown as SyncTokenClaims
  } catch (err) {
    const name = (err as { name?: string }).name
    if (name === "JwtTokenExpired") {
      return { ok: false, status: 401, reason: "token expired" }
    }
    return { ok: false, status: 401, reason: "invalid token signature" }
  }

  if (claims.aud !== "sync") {
    return { ok: false, status: 401, reason: "wrong audience" }
  }

  if (claims.fileId !== expectedFileId) {
    return { ok: false, status: 403, reason: "token scoped to different file" }
  }

  return { ok: true, claims }
}
