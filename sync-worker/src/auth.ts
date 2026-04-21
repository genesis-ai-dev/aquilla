// Pure JWT verification for sync-token claims issued by frontier-server's
// POST /api/v2/sync-token. Kept dependency-free from Durable Object / worker
// bindings so it can be unit-tested directly.

import { verify } from "hono/jwt"

export interface SyncTokenClaims {
  userId: number
  projectId: string
  fileId: string
  role: number
  aud: "sync"
  iat: number
  exp: number
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
