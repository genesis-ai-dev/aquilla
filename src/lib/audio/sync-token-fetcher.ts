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

// Module-level singleton cache, shared across every `makeAudioSyncTokenFetcher`
// instance — mirrors the established pattern for audio caches in this codebase
// (bytes-cache.ts, peaks-cache.ts already live at module scope). EditorRow
// mounts useCellAudio twice per row (recorded + generated voice), so a
// per-instance cache meant a 500-row file could mint up to 1000 independent
// tokens for the same (projectId, fileId) instead of sharing one mint.
//
// CORRECTNESS CONSTRAINT: because this cache now outlives any single hook
// instance, it also outlives a logout/login (or multi-account switch) that
// happens without a full page reload. Without a session-identity component in
// the key, a token minted under user A's role could be served back to user B
// after an account switch — a real authorization leak, since sync-tokens are
// role-scoped per project. We key on `session.username`, the same field
// session-store.ts already uses as the canonical per-account identity
// (`sessionKey(s) = s.username`), so switching the active session naturally
// partitions the cache instead of leaking across it.
const cache = new Map<string, CachedToken>()

/** @internal — test seam; clears the shared cache between test cases. */
export function __resetAudioSyncTokenCacheForTests(): void {
  cache.clear()
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
  return async (projectId, fileId) => {
    // Resolve the session first: the cache key is scoped by username, so we
    // need it before we can even look up a hit (see module-level comment on
    // `cache` for why identity must be part of the key). This also means a
    // logged-out call (no session) can never accidentally serve a token that
    // was cached under a still-active session.
    const session = getSession()
    if (!session?.jwt) return null
    const key = `${session.username}::${projectId}::${fileId}`
    const now = Date.now()
    const cached = cache.get(key)
    if (cached && cached.expiresAtMs > now + REFRESH_SAFETY_MS) {
      return cached.value
    }
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
