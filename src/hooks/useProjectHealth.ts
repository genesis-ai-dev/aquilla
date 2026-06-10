// FRO-190 — thin wrapper around useHealthRollup for use in ProjectCard.
//
// Called with a projectId that is null when:
//   - the card is in the trashed variant (irrelevant), OR
//   - the project has never been server-side (local-only; would 404)
//
// In both cases projectHealth stays null and the caller hides the ring.

import { useFrontierSession } from "./useFrontierSession"
import { useHealthRollup } from "./useHealthRollup"

export interface UseProjectHealthResult {
  /** Overall project health 0-100. null = not yet loaded or unavailable. */
  projectHealth: number | null
  loading: boolean
}

export function useProjectHealth(projectId: string | null): UseProjectHealthResult {
  const { session } = useFrontierSession()

  // getToken must be stable across renders — memoised via an inline async fn
  // is fine here because useHealthRollup captures it via ref internally.
  const getToken = session?.jwt
    ? async () => session.jwt ?? null
    : undefined

  const { projectHealth, loading } = useHealthRollup({
    projectId: projectId ?? undefined,
    getToken,
    // No cells on the dashboard — the refetch key is purely projectId.
    cells: [],
    enabled: projectId !== null && session?.jwt !== undefined,
  })

  return { projectHealth, loading }
}
