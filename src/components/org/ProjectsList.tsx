import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchAccessibleProjectsResult, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { ProjectCreateDialog } from "@/components/ProjectCreateDialog"
import type { ProjectRecord } from "@/lib/parsers/types"

export function ProjectsList() {
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [unreachable, setUnreachable] = useState(false)

  function loadProjects() {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    setLoading(true)
    setUnreachable(false)
    fetchAccessibleProjectsResult(jwt, activeOrgId)
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setProjects(result.projects)
          setUnreachable(false)
        } else {
          setProjects([])
          setUnreachable(result.reason === "unreachable")
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }

  useEffect(() => {
    const cleanup = loadProjects()
    return cleanup
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, activeOrgId])

  function handleCreated(project: ProjectRecord) {
    navigate(`/projects/${project.id}`)
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={
        <div className="flex items-center justify-between pr-4">
          <OrgBreadcrumb section="Projects" />
          <ProjectCreateDialog orgId={activeOrgId ?? undefined} onCreated={handleCreated} />
        </div>
      }
      statusBar={null}
      main={
        <div className="h-full overflow-y-auto p-6">
          {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : unreachable ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800 dark:bg-amber-950">
              <span className="text-amber-800 dark:text-amber-200">
                Can't reach the server — project list unavailable.
              </span>
              <button
                type="button"
                onClick={loadProjects}
                className="shrink-0 rounded-md bg-amber-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => (
                <button key={p.id} onClick={() => navigate(`/projects/${p.id}`)} className="rounded-lg border p-4 text-left hover:bg-accent/40">
                  <span className="block font-medium">{p.name}</span>
                  <span className="block text-xs text-muted-foreground">{p.role.name}</span>
                </button>
              ))}
              {projects.length === 0 && <p className="text-sm text-muted-foreground">No projects in this org yet.</p>}
            </div>
          )}
        </div>
      }
    />
  )
}
