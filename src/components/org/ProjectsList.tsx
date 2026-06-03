import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchAccessibleProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { ProjectCreateDialog } from "@/components/ProjectCreateDialog"
import type { ProjectRecord } from "@/lib/parsers/types"

export function ProjectsList() {
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    setLoading(true)
    fetchAccessibleProjects(jwt, activeOrgId)
      .then((list) => { if (!cancelled) setProjects(list) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
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
          {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
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
