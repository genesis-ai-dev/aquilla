// FRO-190 — thin wrapper around useHealthRollup for use in ProjectCard.
//
// Called with a projectId that is null when:
//   - the card is in the trashed variant (irrelevant), OR
//   - the project has never been server-side (local-only; would 404)
//
// In both cases projectHealth stays null and the caller hides the ring.
//
// FRO-190 fix: the original implementation passed the raw auth-worker JWT
// (`session.jwt`) directly. The sync-worker rejects raw auth JWTs with 401
// "invalid token signature" because it only accepts tokens with `aud=sync`
// (minted by POST /api/v2/sync-token). This fix mints a proper project-scoped
// sync-token via `makeSyncTokenFetcher`, which the health-rollup route accepts.
//
// The health-rollup route uses `verifyTokenForProject` — it checks only:
//   aud=sync, projectId===expected, role>=100
// It does NOT check fileId, so any valid sync-token for the project passes,
// regardless of which fileId was used at mint time. We use the established
// sentinel "__project__" (same convention as useComments.ts and outbox-flush.ts)
// so identity issues a project-scoped token that the route accepts.
//
// Caching: `makeSyncTokenFetcher` already caches the minted token in-memory
// and auto-refreshes 30 s before expiry. We additionally cache the fetcher
// itself per projectId (via a module-level Map) so that many ProjectCards on
// the dashboard do not cause a token-mint stampede — each distinct projectId
// shares one in-flight fetcher/cache across all cards.

import { useRef, useMemo } from "react"
import { useFrontierSession } from "./useFrontierSession"
import { useHealthRollup } from "./useHealthRollup"
import { makeSyncTokenFetcher } from "@/lib/sync/sync-token"

// Sentinel fileId used when minting a project-scope-only token.
// Established convention in this codebase (useComments.ts, outbox-flush.ts,
// ProjectWorkspace.tsx line 1679). The health-rollup route's verifyTokenForProject
// does not validate fileId — it only checks projectId and role.
const HEALTH_SENTINEL_FILE_ID = "__project__"

// Module-level token fetcher cache keyed by projectId.
// Survives re-renders across all ProjectCard instances so a dashboard with
// many cards shares one in-flight mint per project rather than stampeding.
// The JWT accessor is held by ref so card remounts don't invalidate the cache.
const fetcherCache = new Map<string, () => Promise<string | null>>()

export interface UseProjectHealthResult {
  /** Overall project health 0-100. null = not yet loaded or unavailable. */
  projectHealth: number | null
  loading: boolean
}

export function useProjectHealth(projectId: string | null): UseProjectHealthResult {
  const { session } = useFrontierSession()

  // Keep a ref to the latest JWT so the module-level fetcher (which closes
  // over this ref) always uses the freshest session token without needing a
  // new fetcher per render.
  const jwtRef = useRef<string | null>(null)
  jwtRef.current = session?.jwt ?? null

  // Build (or retrieve from module-level cache) a token fetcher for this
  // projectId. The fetcher wraps makeSyncTokenFetcher which:
  //  1. Calls POST /api/v2/sync-token with the auth JWT → receives a sync JWT
  //     with aud=sync and the projectId embedded.
  //  2. Caches the sync JWT in-memory, auto-refreshing 30 s before expiry.
  // We only build a new fetcher when projectId changes and is non-null.
  const getToken = useMemo<(() => Promise<string | null>) | undefined>(() => {
    if (!projectId) return undefined

    let fetcher = fetcherCache.get(projectId)
    if (!fetcher) {
      fetcher = makeSyncTokenFetcher(
        () => jwtRef.current,
        projectId,
        HEALTH_SENTINEL_FILE_ID,
      )
      fetcherCache.set(projectId, fetcher)
    }
    return fetcher
  }, [projectId])

  const { projectHealth, loading } = useHealthRollup({
    projectId: projectId ?? undefined,
    getToken,
    // No cells on the dashboard — the refetch key is purely projectId.
    cells: [],
    enabled: projectId !== null && session?.jwt !== undefined,
  })

  return { projectHealth, loading }
}
