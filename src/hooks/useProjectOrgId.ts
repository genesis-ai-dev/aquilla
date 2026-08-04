import { useEffect, useState } from "react"
import { resolveCloudProjectResult } from "@/lib/sync/cloud-projects"
import { useFrontierSession } from "./useFrontierSession"

/**
 * Resolve the org a project belongs to, from the project record itself.
 *
 * The member-add suggestion surfaces (AQU-672) need the PROJECT's org roster —
 * keying off the active-org picker breaks whenever the user browses in
 * "All organizations" mode (activeOrgId is null there) or has a different org
 * active than the project's. Returns null while resolving, for personal
 * (org-less) projects, and on fetch failure — callers should treat null as
 * "fall back to the active-org context, then to no suggestions."
 */
export function useProjectOrgId(projectId: string | null): number | null {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [orgId, setOrgId] = useState<number | null>(null)

  useEffect(() => {
    if (!jwt || !projectId) {
      setOrgId(null)
      return
    }
    let alive = true
    resolveCloudProjectResult(projectId, jwt)
      .then((r) => {
        if (!alive) return
        // ProjectStateResponse has orgId: number | null; the list-endpoint
        // fallback (CloudProjectSummary) may omit it — treat absent as null.
        setOrgId(r.ok ? ((r.project as { orgId?: number | null }).orgId ?? null) : null)
      })
      .catch(() => { /* best-effort; callers fall back to active-org context */ })
    return () => { alive = false }
  }, [jwt, projectId])

  return orgId
}
