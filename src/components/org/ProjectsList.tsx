import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchAccessibleProjectsResult, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { ProjectCreateDialog } from "@/components/ProjectCreateDialog"
import type { ProjectRecord } from "@/lib/parsers/types"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"

export function ProjectsList() {
  const { activeOrgId, isLoading: orgLoading, error: orgError, refresh: refreshOrgs } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [unreachable, setUnreachable] = useState(false)

  // RES-5 (UI-QA follow-up): when the ORGS fetch fails, activeOrgId stays null,
  // loadProjects() never runs, and the page used to fall through to the
  // misleading "No projects in this org yet." empty state. Treat a failed org
  // load with no resolved org as unreachable too.
  const orgsUnreachable = !orgLoading && orgError != null && activeOrgId == null

  function retryUnreachable() {
    if (orgsUnreachable) {
      // refresh() re-fetches orgs; on success activeOrgId resolves and the
      // [jwt, activeOrgId] effect re-runs loadProjects automatically.
      void refreshOrgs()
    } else {
      loadProjects()
    }
  }

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
          // FRO-293: 401/403 from the projects fetch means the session is no
          // longer valid — raise the global session-expired banner.
          if (result.reason === "unauthorized") notifySessionExpired()
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

  // Signed-out or org-less: session finished loading but no JWT.
  // Resolve to a clear signed-out state — never spin forever.
  if (!sessionLoading && !orgLoading && !jwt) {
    return (
      <AppShell
        sidebar={<OrgSidebar />}
        header={
          <div className="flex items-center justify-between pr-4">
            <OrgBreadcrumb section="Projects" />
          </div>
        }
        statusBar={null}
        main={
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="text-lg font-medium">Sign in to see your projects</p>
            <p className="text-sm text-muted-foreground max-w-xs">
              Your session has ended or you are not signed in. Sign in to access your projects.
            </p>
            <Link
              to={`/login?next=${encodeURIComponent("/projects")}`}
              className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Sign in
            </Link>
          </div>
        }
      />
    )
  }

  const isPageLoading = sessionLoading || orgLoading || loading

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
          {isPageLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : unreachable || orgsUnreachable ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800 dark:bg-amber-950">
              <span className="text-amber-800 dark:text-amber-200">
                Can't reach the server — project list unavailable.
              </span>
              <button
                type="button"
                onClick={retryUnreachable}
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
