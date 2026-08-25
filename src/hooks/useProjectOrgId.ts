import { useEffect, useState } from "react"
import { resolveCloudProjectResult } from "@/lib/sync/cloud-projects"
import { useFrontierSession } from "./useFrontierSession"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"
import { toUserFacingError, UserError } from "@/lib/errors/user-error"

/**
 * Resolve the org a project belongs to, from the project record itself.
 *
 * The member-add suggestion surfaces (AQU-672) need the PROJECT's org roster —
 * keying off the active-org picker breaks whenever the user browses in
 * "All organizations" mode (activeOrgId is null there) or has a different org
 * active than the project's. Resolution failures remain explicit so callers
 * can degrade to manual entry without pretending the project is org-less.
 */
export function useProjectOrgId(projectId: string | null): {
  orgId: number | null
  isLoading: boolean
  error: string | null
} {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [orgId, setOrgId] = useState<number | null>(null)
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolvedProjectId, setResolvedProjectId] = useState<string | null>(null)

  useEffect(() => {
    if (!jwt || !projectId) {
      setOrgId(null)
      setLoading(false)
      setError(null)
      setResolvedProjectId(null)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    resolveCloudProjectResult(projectId, jwt)
      .then((r) => {
        if (!alive) return
        if (!r.ok) {
          if (r.reason === "unauthenticated") void notifySessionExpiredIfCurrent(jwt)
          setOrgId(null)
          const resolutionError = r.reason === "unreachable"
            ? new TypeError("Failed to fetch")
            : new UserError(
                r.reason === "unauthenticated" ? 401 : r.reason === "forbidden" ? 403 : 404,
                "",
                "project",
              )
          setError(toUserFacingError(resolutionError, "project").message)
          setResolvedProjectId(projectId)
          return
        }
        setOrgId((r.project as { orgId?: number | null }).orgId ?? null)
        setResolvedProjectId(projectId)
      })
      .catch((caught) => {
        if (!alive) return
        setOrgId(null)
        setError(toUserFacingError(caught, "project").message)
        setResolvedProjectId(projectId)
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [jwt, projectId])

  // Never expose the previous project's organization during the render where
  // projectId changes but the new effect has not started yet.
  const isCurrent = resolvedProjectId === projectId
  return {
    orgId: isCurrent ? orgId : null,
    isLoading: Boolean(jwt && projectId) && (!isCurrent || isLoading),
    error: isCurrent ? error : null,
  }
}
