// Fetch short-lived JWTs from the frontier-server identity worker's
// POST /api/v2/sync-token. One token per (projectId, fileId) scope; 15-min
// TTL. Cache the token in memory and refresh when within 30 s of expiry so
// reconnects don't race with expiration.
//
// AUTH_API_URL is the canonical base for every codex-web → backend call now
// (auth, sync-token, invites, orgs, members, projects, users, health). The
// legacy frontier-server fallback was removed on 2026-05-13 when these routes
// were ported into the codex-web identity worker. Phase 3e then relocated
// that worker from auth-worker/ to apps/frontier-server/. Production deploys
// use the bare aquilla-frontier-server worker name; staging deploys use
// aquilla-dev-frontier-server.

const AUTH_DEFAULT = "https://aquilla-frontier-server.blue-darkness-7674.workers.dev"

export const AUTH_API_URL =
  ((import.meta.env.VITE_AUTH_BASE as string | undefined)?.replace(/\/+$/, "")) ||
  AUTH_DEFAULT

/** @deprecated alias for AUTH_API_URL. Kept while callers are migrated. */
export const FRONTIER_API_URL = AUTH_API_URL

export interface SyncTokenResponse {
  token: string
  expiresIn: number
  role: { level: number; name: string; source: "override" | "creator" | "gitlab" }
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
      if (err instanceof SyncTokenError && err.status === 403) {
        callbacks.onForbidden?.()
      }
      // Most common paths: 401 (stale jwt), 403 (no project access), 5xx (transient).
      // Log and surface null — useFileSync treats null as "no sync for now".
      console.warn("[sync-token] fetch failed:", err)
      return null
    }
  }
}
