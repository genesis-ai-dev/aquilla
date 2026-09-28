import { useMemo } from "react"
import { useActiveOrgOptional } from "@/context/OrgContext"
import { useProject } from "@/hooks/useProject"
import { useProjectOrgId } from "@/hooks/useProjectOrgId"
import type { ScopePath } from "@/lib/access/types"

/**
 * AQU-1352 §3.9 rules 1-2: the project's scope as a breadcrumb path
 * (org › project) for page titles and the add-people dialog header. The org
 * crumb is omitted for a personal project or an org the viewer can't list;
 * an empty path means the project name hasn't loaded yet.
 */
export function useProjectScopePath(projectId: string): ScopePath {
  const { project } = useProject(projectId)
  const { orgId } = useProjectOrgId(projectId)
  const orgs = useActiveOrgOptional()?.orgs
  const projectName = project?.name ?? null
  const orgName = orgId != null ? (orgs?.find((o) => o.id === orgId)?.name ?? null) : null
  return useMemo(() => {
    if (!projectName) return []
    const path: ScopePath = []
    if (orgId != null && orgName) path.push({ type: "org", id: String(orgId), name: orgName })
    path.push({ type: "project", id: projectId, name: projectName })
    return path
  }, [orgId, orgName, projectId, projectName])
}
