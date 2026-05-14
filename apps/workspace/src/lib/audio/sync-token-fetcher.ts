// Default singleton fetcher (re-exported below) used by call sites that
// don't have a React-scoped session in hand — synth-and-attach, bulk-audio.
//
// Minimal sync-token fetcher for the audio REST endpoints.
//
// Unlike useFileSync (which holds one cached fetcher per WS connection),
// audio HTTP calls fan out across many (projectId, fileId) pairs over the
// lifetime of a session. We mint tokens on demand and cache them in a
// per-(projectId,fileId) map so back-to-back PUT+GET on the same cell
// doesn't double-fetch.
//
// Tokens are JWTs with a 15-minute TTL; we refresh when within 30 s of
// expiry, mirroring `makeSyncTokenFetcher` in src/lib/sync/sync-token.ts.

import { fetchSyncToken, SyncTokenError } from "@/lib/sync/sync-token"
import type { FrontierSession } from "@/lib/frontier/types"
import type { SyncTokenForFile } from "./upload"

const REFRESH_SAFETY_MS = 30_000

interface CachedToken {
  value: string
  expiresAtMs: number
}

/**
 * Build a sync-token fetcher tied to a Frontier session. Re-uses cached
 * tokens for the same (projectId, fileId) until they're within 30 s of
 * expiry, then transparently mints a fresh one.
 *
 * Returns null when the session has no JWT (anonymous) or the server
 * rejects the request — callers surface that as "audio not available"
 * rather than failing loudly, matching how the WS sync layer behaves.
 */
/** Convenience: wrap a single FrontierSession (rather than a getter) into
 *  a SyncTokenForFile. Used by call sites that already hold a session and
 *  only fire one upload (synth-and-attach, bulk-audio). */
export function audioSyncTokenFetcherForSession(
  session: FrontierSession | null,
): SyncTokenForFile {
  return makeAudioSyncTokenFetcher(() => session)
}

export function makeAudioSyncTokenFetcher(
  getSession: () => FrontierSession | null,
): SyncTokenForFile {
  const cache = new Map<string, CachedToken>()
  return async (projectId, fileId) => {
    const key = `${projectId}::${fileId}`
    const now = Date.now()
    const cached = cache.get(key)
    if (cached && cached.expiresAtMs > now + REFRESH_SAFETY_MS) {
      return cached.value
    }
    const session = getSession()
    if (!session?.jwt) return null
    try {
      const resp = await fetchSyncToken(session.jwt, projectId, fileId)
      cache.set(key, {
        value: resp.token,
        expiresAtMs: now + resp.expiresIn * 1000,
      })
      return resp.token
    } catch (err) {
      if (err instanceof SyncTokenError) {
        console.warn("[audio sync-token] fetch failed:", err.status, err.body.slice(0, 200))
      } else {
        console.warn("[audio sync-token] fetch failed:", err)
      }
      return null
    }
  }
}
