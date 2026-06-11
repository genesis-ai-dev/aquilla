import { useEffect, useMemo, useState } from "react"
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

// ── Sort options ─────────────────────────────────────────────────────────────
type SortKey = "name" | "role"
type SortDir = "asc" | "desc"

function sortProjects(
  projects: CloudProjectSummary[],
  key: SortKey,
  dir: SortDir,
): CloudProjectSummary[] {
  const sorted = [...projects].sort((a, b) => {
    if (key === "name") {
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    }
    if (key === "role") {
      return a.role.level - b.role.level
    }
    return 0
  })
  return dir === "desc" ? sorted.reverse() : sorted
}

// ── Small header button for sort columns ────────────────────────────────────
function SortButton({
  label,
  colKey,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string
  colKey: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
}) {
  const active = colKey === sortKey
  const indicator = active ? (sortDir === "asc" ? " ↑" : " ↓") : ""
  return (
    <button
      type="button"
      onClick={() => onSort(colKey)}
      className={`select-none text-xs font-medium uppercase tracking-wide ${
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
      {indicator}
    </button>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export function ProjectsList() {
  const { activeOrgId, isLoading: orgLoading, error: orgError, refresh: refreshOrgs } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [unreachable, setUnreachable] = useState(false)

  // Filter + sort state
  const [filter, setFilter] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("name")
  const [sortDir, setSortDir] = useState<SortDir>("asc")

  // RES-5 (UI-QA follow-up): when the ORGS fetch fails, activeOrgId stays null,
  // loadProjects() never runs, and the page used to fall through to the
  // misleading "No projects in this org yet." empty state. Treat a failed org
  // load with no resolved org as unreachable too.
  const orgsUnreachable = !orgLoading && orgError != null && activeOrgId == null

  function retryUnreachable() {
    if (orgsUnreachable) {
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

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects
    return sortProjects(list, sortKey, sortDir)
  }, [projects, filter, sortKey, sortDir])

  // Signed-out or org-less: session finished loading but no JWT.
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
          <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
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
        <div className="min-h-screen p-6">
          {isPageLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : unreachable || orgsUnreachable ? (
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
            <div className="flex flex-col gap-3">
              {/* Filter bar */}
              <div className="flex items-center gap-2">
                <input
                  type="search"
                  placeholder="Filter projects…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="h-8 w-full max-w-xs rounded-md border bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="text-xs text-muted-foreground">
                  {filtered.length} {filtered.length === 1 ? "project" : "projects"}
                </span>
              </div>

              {/* Column headers */}
              <div className="grid grid-cols-[1fr_auto] gap-x-4 border-b pb-1 sm:grid-cols-[1fr_120px]">
                <SortButton
                  label="Name"
                  colKey="name"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <SortButton
                  label="Role"
                  colKey="role"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
              </div>

              {/* Rows */}
              {filtered.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {filter ? "No projects match your filter." : "No projects in this org yet."}
                </p>
              ) : (
                <ul className="divide-y">
                  {filtered.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => navigate(`/projects/${p.id}`)}
                        className="grid w-full grid-cols-[1fr_auto] items-center gap-x-4 py-2.5 text-left hover:bg-accent/30 sm:grid-cols-[1fr_120px]"
                      >
                        {/* Name + status badge */}
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">{p.name}</span>
                          {p.isActive === false && (
                            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              inactive
                            </span>
                          )}
                        </span>

                        {/* Role */}
                        <span className="shrink-0 text-xs text-muted-foreground">{p.role.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      }
    />
  )
}
