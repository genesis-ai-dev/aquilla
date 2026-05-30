import { useParams, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useProject } from "@/hooks/useProject"

export function ProjectOverview() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const { project, status } = useProject(id)
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={project?.name ?? "Project"} />}
      statusBar={null}
      main={
        <div className="p-6">
          {status !== "ready" ? <p className="text-sm text-muted-foreground">Loading…</p> : (
            <div className="max-w-xl rounded-lg border p-6">
              <h1 className="text-lg font-semibold">{project?.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{project?.files.length ?? 0} files</p>
              <button onClick={() => navigate(`/project/${id}`)} className="mt-4 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">Open project</button>
            </div>
          )}
        </div>
      }
    />
  )
}
