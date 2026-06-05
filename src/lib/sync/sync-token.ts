// Fetch short-lived JWTs from the aquilla-identity's POST /api/v2/sync-token.
// One token per (projectId, fileId) scope; 15-min TTL. Cache the token in memory
// and refresh when within 30 s of expiry so reconnects don't race with expiration.
//
// AUTH_API_URL points at aquilla-identity (auth, sync-token, invites). It
// falls back to VITE_FRONTIER_BASE so legacy environments that only have the
// old frontier-server still work. The plain `FRONTIER_API_URL` re-export is
// kept around for chat/LLM/payments routes that haven't been ported.

// Phase D: default points at aquilla-identity (aquilla-identity).
// VITE_FRONTIER_BASE is retained as a fallback for E2E test environments that
// set it to a mock server URL.
const AUTH_FALLBACK =
  ((import.meta.env.VITE_FRONTIER_BASE as string | undefined)?.replace(/\/+$/, "")) ||
  "https://api.aquilla.app/identity"

export const AUTH_API_URL =
  ((import.meta.env.VITE_AUTH_BASE as string | undefined)?.replace(/\/+$/, "")) ||
  AUTH_FALLBACK

/** @deprecated Use AUTH_API_URL. Kept for callers not yet migrated. */
export const FRONTIER_API_URL = AUTH_API_URL

export interface SyncTokenResponse {
  token: string
  expiresIn: number
  role: { level: number; name: string; source: "override" | "group" | "creator" | "org" }
}

export class SyncTokenError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`sync-token fetch failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "SyncTokenError"
  }
}

/** Optional bootstrap payload so the server can auto-register an unknown
 *  projectId on the caller's first /sync-token request. */
export interface ProjectBootstrap {
  projectName?: string
  gitlabProjectId?: number
}

export async function fetchSyncToken(
  jwt: string,
  projectId: string,
  fileId: string,
  bootstrap: ProjectBootstrap = {},
  apiUrl: string = AUTH_API_URL
): Promise<SyncTokenResponse> {
  const body: Record<string, unknown> = { projectId, fileId }
  if (bootstrap.projectName) body.projectName = bootstrap.projectName
  if (typeof bootstrap.gitlabProjectId === "number") {
    body.gitlabProjectId = bootstrap.gitlabProjectId
  }
  const res = await fetch(`${apiUrl}/api/v2/sync-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => "")
    throw new SyncTokenError(res.status, errBody)
  }
  return (await res.json()) as SyncTokenResponse
}

interface CachedToken {
  value: string
  expiresAtMs: number
}

const REFRESH_SAFETY_MS = 30_000

/**
 * Build a getToken callback suitable for YProvider's `params` option. Caches
 * the minted token in memory and refreshes it when within 30 s of expiry.
 * Returns null when the fetch fails — caller decides how to surface that.
 */
export interface SyncTokenCallbacks {
  /** Fires whenever a fresh token is successfully minted. Callers persist the
   * role to IDB so Dashboard rendering can decide owner-only actions without
   * a round-trip. */
  onRole?: (role: SyncTokenResponse["role"]) => void
  /** Fires when the server rejects with 403, typically because the project was
   * archived. Callers use this to drive local tombstone reconciliation. */
  onForbidden?: () => void
  /**
   * Fires when the session JWT is rejected with 401 — i.e. the stored token is
   * stale or was invalidated by a backend migration (e.g. Postgres switch).
   * The caller should clear the cached session so the user is directed to
   * re-authenticate rather than silently failing on every file open.
   * FRO-159: without this hook the 401 was swallowed, leaving the user stuck.
   */
  onUnauthorized?: () => void
}

export function makeSyncTokenFetcher(
  getJwt: () => string | null,
  projectId: string,
  fileId: string,
  bootstrap: ProjectBootstrap = {},
  apiUrl?: string,
  callbacks: SyncTokenCallbacks = {}
): () => Promise<string | null> {
  let cached: CachedToken | null = null
  return async () => {
    const now = Date.now()
    if (cached && cached.expiresAtMs > now + REFRESH_SAFETY_MS) {
      return cached.value
    }
    const jwt = getJwt()
    if (!jwt) return null
    try {
      const resp = await fetchSyncToken(jwt, projectId, fileId, bootstrap, apiUrl)
      cached = {
        value: resp.token,
        expiresAtMs: now + resp.expiresIn * 1000,
      }
      callbacks.onRole?.(resp.role)
      return resp.token
    } catch (err) {
      if (err instanceof SyncTokenError) {
        if (err.status === 403) {
          callbacks.onForbidden?.()
        } else if (err.status === 401) {
          // Session JWT is stale or was invalidated (e.g. after Postgres migration).
          // Evict the in-memory sync token cache so the next call re-fetches,
          // and notify the caller so it can clear the persisted session and
          // redirect to login — FRO-159.
          cached = null
          callbacks.onUnauthorized?.()
        }
      }
      // Most common paths: 401 (stale jwt), 403 (no project access), 5xx (transient).
      // Log and surface null — useFileSync treats null as "no sync for now".
      console.warn("[sync-token] fetch failed:", err)
      return null
    }
  }
}
