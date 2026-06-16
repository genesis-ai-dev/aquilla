import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchAccessibleProjectsResult, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { partitionSharedProjects } from "@/lib/frontier/shared-projects"
import { ProjectCreateDialog } from "@/components/ProjectCreateDialog"
import type { ProjectRecord } from "@/lib/parsers/types"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"
import { attentionRank, deadlineStatus, getPortfolios, translatedPct, type PortfolioProject } from "@/lib/frontier/portfolio"
import { UserError } from "@/lib/errors/user-error"

// ── Sort options ─────────────────────────────────────────────────────────────
type SortKey = "name" | "role"
type SortDir = "asc" | "desc"
type ProjectLens = "recent" | "attention" | "overdue" | "least-translated"

const PROJECT_LENS_STORAGE_KEY = "org:all-projects:view"
const PROJECT_LENS_VALUES: ProjectLens[] = ["recent", "attention", "overdue", "least-translated"]

const PROJECT_LENSES: { value: ProjectLens; label: string; empty: string }[] = [
  { value: "recent", label: "Recently updated", empty: "No recently updated projects yet." },
  { value: "attention", label: "Needs attention", empty: "No projects need attention yet." },
  { value: "overdue", label: "Overdue", empty: "No overdue projects." },
  { value: "least-translated", label: "Least translated", empty: "No projects yet." },
]

function readProjectLens(): ProjectLens {
  try {
    const stored = localStorage.getItem(PROJECT_LENS_STORAGE_KEY)
    return PROJECT_LENS_VALUES.includes(stored as ProjectLens) ? stored as ProjectLens : "recent"
  } catch {
    return "recent"
  }
}

function writeProjectLens(lens: ProjectLens) {
  try {
    localStorage.setItem(PROJECT_LENS_STORAGE_KEY, lens)
  } catch {
    // Ignore local storage restrictions; the in-memory state still updates.
  }
}

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

function sortProjectsByLens(
  projects: CloudProjectSummary[],
  lens: ProjectLens,
  portfolioById: Map<string, PortfolioProject>,
  now: number,
): CloudProjectSummary[] {
  const visible = lens === "overdue"
    ? projects.filter((project) => {
      const portfolio = portfolioById.get(project.id)
      return portfolio != null && deadlineStatus(portfolio, now) === "overdue"
    })
    : projects

  return [...visible].sort((a, b) => {
    const aPortfolio = portfolioById.get(a.id)
    const bPortfolio = portfolioById.get(b.id)
    switch (lens) {
      case "recent":
        return (bPortfolio?.lastEditAt ?? 0) - (aPortfolio?.lastEditAt ?? 0)
      case "least-translated":
        return (aPortfolio ? translatedPct(aPortfolio) : 1) - (bPortfolio ? translatedPct(bPortfolio) : 1)
      case "attention":
      case "overdue":
        return (bPortfolio ? attentionRank(bPortfolio, now) : -1) - (aPortfolio ? attentionRank(aPortfolio, now) : -1)
    }
  })
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
      className={`inline-flex justify-self-start select-none text-left text-xs font-medium uppercase tracking-wide ${
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

// ── Project row (shared by the org list and the "Shared with you" list) ─────
function ProjectRow({
  project: p,
  orgLabel,
  onOpen,
}: {
  project: CloudProjectSummary
  orgLabel?: string
  onOpen: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full grid-cols-[minmax(0,1fr)_7rem] items-center gap-x-6 px-4 py-3 text-left transition-colors hover:bg-muted/50"
      >
        {/* Name + status badge */}
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{p.name}</span>
          {orgLabel && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {orgLabel}
            </span>
          )}
          {p.isActive === false && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              inactive
            </span>
          )}
        </span>

        {/* Role */}
        <span className="shrink-0 justify-self-start text-xs text-muted-foreground">{p.role.name}</span>
      </button>
    </li>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export function ProjectsList() {
  const { activeOrgId, isAllOrgs, orgs, isLoading: orgLoading, error: orgError, refresh: refreshOrgs } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [portfolioProjects, setPortfolioProjects] = useState<PortfolioProject[]>([])
  const [loading, setLoading] = useState(false)
  const [unreachable, setUnreachable] = useState(false)

  // Filter + sort state
  const [filter, setFilter] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("name")
  const [sortDir, setSortDir] = useState<SortDir>("asc")
  const [projectLens, setProjectLens] = useState<ProjectLens>(readProjectLens)

  // RES-5 (UI-QA follow-up): when the ORGS fetch fails, activeOrgId stays null,
  // loadProjects() never runs, and the page used to fall through to the
  // misleading "No projects in this org yet." empty state. Treat a failed org
  // load with no resolved org as unreachable too.
  const orgsUnreachable = !orgLoading && orgError != null && !isAllOrgs && activeOrgId == null

  function retryUnreachable() {
    if (orgsUnreachable) {
      void refreshOrgs()
    } else {
      loadProjects()
    }
  }

  function loadProjects() {
    if (!jwt || (!isAllOrgs && activeOrgId == null)) {
      setProjects([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setUnreachable(false)
    // FRO-335: fetch UNfiltered — the server returns every project the caller
    // can access across all grant paths. We partition client-side so projects
    // shared from orgs the caller doesn't belong to (magic-link invite,
    // bulk-add) still surface instead of being org-filtered into oblivion.
    fetchAccessibleProjectsResult(jwt)
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
  }, [jwt, activeOrgId, isAllOrgs])

  useEffect(() => {
    if (!jwt || !isAllOrgs || orgLoading) {
      setPortfolioProjects([])
      return
    }
    if (orgs.length === 0) {
      setPortfolioProjects([])
      return
    }
    let cancelled = false
    getPortfolios(jwt, orgs.map((org) => org.id))
      .then((portfolios) => {
        if (!cancelled) setPortfolioProjects(portfolios.flatMap(({ projects }) => projects))
      })
      .catch((err) => {
        if (!cancelled) {
          setPortfolioProjects([])
          if (err instanceof UserError && err.category === "session-expired") notifySessionExpired()
        }
      })
    return () => { cancelled = true }
  }, [jwt, isAllOrgs, orgLoading, orgs])

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

  function selectProjectLens(lens: ProjectLens) {
    setProjectLens(lens)
    writeProjectLens(lens)
  }

  // FRO-335: projects in orgs the caller is not a member of (invite-link /
  // bulk-add grants) render in their own "Shared with you" section — they
  // belong to no org the switcher can reach.
  const { inActiveOrg, sharedWithMe } = useMemo(
    () => partitionSharedProjects(projects, orgs, activeOrgId, isAllOrgs ? "all-orgs" : "active-org"),
    [projects, orgs, activeOrgId, isAllOrgs],
  )

  const orgNameById = useMemo(() => new Map(orgs.map((o) => [o.id, o.name ?? "Workspace"])), [orgs])
  const portfolioById = useMemo(() => new Map(portfolioProjects.map((project) => [project.id, project])), [portfolioProjects])
  const now = Date.now()

  function projectOrgLabel(project: CloudProjectSummary): string | undefined {
    if (!isAllOrgs) return undefined
    if (project.orgId == null) return "No org"
    return orgNameById.get(project.orgId) ?? "External org"
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q ? inActiveOrg.filter((p) => p.name.toLowerCase().includes(q)) : inActiveOrg
    if (isAllOrgs) return sortProjectsByLens(list, projectLens, portfolioById, now)
    return sortProjects(list, sortKey, sortDir)
  }, [inActiveOrg, filter, isAllOrgs, projectLens, portfolioById, now, sortKey, sortDir])

  const filteredShared = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q ? sharedWithMe.filter((p) => p.name.toLowerCase().includes(q)) : sharedWithMe
    return sortProjects(list, sortKey, sortDir)
  }, [sharedWithMe, filter, sortKey, sortDir])
  const totalProjectCount = inActiveOrg.length + sharedWithMe.length
  const visibleProjectCount = filtered.length + filteredShared.length
  const projectLensEmpty = PROJECT_LENSES.find((lens) => lens.value === projectLens)?.empty ?? "No projects yet."
  const projectCountLabel = filter.trim() || (isAllOrgs && projectLens === "overdue")
    ? `${visibleProjectCount} shown of ${totalProjectCount}`
    : `${totalProjectCount} ${totalProjectCount === 1 ? "project" : "projects"}`

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
          {activeOrgId != null ? (
            <ProjectCreateDialog orgId={activeOrgId} onCreated={handleCreated} />
          ) : (
            <span className="rounded-full border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
              Select an organization to create a project
            </span>
          )}
        </div>
      }
      statusBar={null}
      main={
        <div className="h-full overflow-y-auto p-6">
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
            <div className="space-y-4">
              <section className="rounded-lg border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                  <div className="min-w-0">
                    <h1 className="text-base font-semibold">{isAllOrgs ? "All projects" : "Projects"}</h1>
                    <p className="text-xs text-muted-foreground">{projectCountLabel}</p>
                  </div>
                  <input
                    type="search"
                    placeholder="Filter projects…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:w-72"
                  />
                </div>

                {isAllOrgs && (
                  <div className="flex flex-wrap items-center gap-1 border-b px-4 py-3" aria-label="Project list view">
                    {PROJECT_LENSES.map((lens) => (
                      <button
                        key={lens.value}
                        type="button"
                        onClick={() => selectProjectLens(lens.value)}
                        aria-pressed={projectLens === lens.value}
                        className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                          projectLens === lens.value
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/70"
                        }`}
                      >
                        {lens.label}
                      </button>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-x-6 border-b bg-muted/30 px-4 py-2">
                  {isAllOrgs ? (
                    <>
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Name</span>
                      <span className="justify-self-start text-xs font-medium uppercase tracking-wide text-muted-foreground">Role</span>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                </div>

                {filtered.length === 0 ? (
                  <div className="px-4 py-10 text-center">
                    <p className="text-sm text-muted-foreground">
                      {filter
                        ? "No projects match your filter."
                        : isAllOrgs
                          ? projectLensEmpty
                          : "No projects in this org yet."}
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y">
                    {filtered.map((p) => (
                      <ProjectRow
                        key={p.id}
                        project={p}
                        orgLabel={projectOrgLabel(p)}
                        onOpen={() => navigate(`/projects/${p.id}`)}
                      />
                    ))}
                  </ul>
                )}
              </section>

              {/* FRO-335: projects shared from orgs the caller doesn't belong
                  to (magic-link invite, bulk-add by username). Without this
                  section they're URL-accessible but unreachable from any nav. */}
              {filteredShared.length > 0 && (
                <section className="rounded-lg border bg-card" data-testid="shared-with-you">
                  <div className="border-b px-4 py-3">
                    <h2 className="text-sm font-medium">Shared with you</h2>
                    <p className="text-xs text-muted-foreground">
                      Projects from organizations outside the current scope.
                    </p>
                  </div>
                  <ul className="divide-y">
                    {filteredShared.map((p) => (
                      <ProjectRow key={p.id} project={p} onOpen={() => navigate(`/projects/${p.id}`)} />
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      }
    />
  )
}
