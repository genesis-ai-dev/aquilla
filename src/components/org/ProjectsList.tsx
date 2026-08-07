import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchAccessibleProjectsResult, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { partitionSharedProjects } from "@/lib/frontier/shared-projects"
import { isProjectNew, readProjectOpenedAt } from "@/lib/frontier/opened-shared-store"
import { ProjectCreateDialog } from "@/components/ProjectCreateDialog"
import { OrgCreateDialog } from "./OrgCreateDialog"
import type { ProjectRecord } from "@/lib/parsers/types"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"
import { attentionRank, deadlineStatus, getPortfolios, translatedPct, type PortfolioProject } from "@/lib/frontier/portfolio"
import { UserError } from "@/lib/errors/user-error"
import { buttonVariants, Button } from "@/components/ui/button"
import { RoleLabel } from "@/components/RoleLabel"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"
import { Building2, FolderOpen, Search } from "lucide-react"
import { EmptyState } from "@/components/ui/page"
import { orgHomePath } from "@/lib/navigation/org-paths"

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
      className={`inline-flex justify-self-start select-none text-left text-xs font-medium ${
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
  isNew = false,
}: {
  project: CloudProjectSummary
  orgLabel?: string
  onOpen: () => void
  /** AQU-696: show the "New" badge (shared-projects list only). */
  isNew?: boolean
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
          {isNew && (
            <Badge className="shrink-0" data-testid="new-shared-badge">
              New
            </Badge>
          )}
          {orgLabel && (
            <Badge variant="secondary" className="shrink-0">
              {orgLabel}
            </Badge>
          )}
          {p.isActive === false && (
            <Badge variant="secondary" className="shrink-0">
              inactive
            </Badge>
          )}
        </span>

        {/* Role */}
        <RoleLabel name={p.role.name} className="shrink-0 justify-self-start text-xs text-muted-foreground" />
      </button>
    </li>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export function ProjectsList() {
  const {
    activeOrgId,
    isAllOrgs,
    orgs,
    isLoading: orgLoading,
    error: orgError,
    refresh: refreshOrgs,
    setActiveOrg,
  } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const username = session?.username ?? null
  const navigate = useNavigate()
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [portfolioProjects, setPortfolioProjects] = useState<PortfolioProject[]>([])
  // Start unresolved so the first render cannot briefly claim the org has no
  // projects before the initial request effect has had a chance to begin.
  const [loading, setLoading] = useState(true)
  const [unreachable, setUnreachable] = useState(false)
  const [createOrgOpen, setCreateOrgOpen] = useState(false)

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
    if (!jwt) {
      setProjects([])
      setLoading(false)
      return
    }
    if (!isAllOrgs && activeOrgId == null) {
      setProjects([])
      // Org hydration can publish the membership list and its automatically
      // selected org across adjacent renders. Keep the project surface
      // unresolved through that hand-off; only a genuinely org-less account
      // has a resolved empty project scope.
      if (!orgLoading && orgs.length === 0) setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setUnreachable(false)
    // AQU-335: fetch UNfiltered — the server returns every project the caller
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
          // AQU-293: 401/403 from the projects fetch means the session is no
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
  }, [jwt, activeOrgId, isAllOrgs, orgLoading, orgs.length])

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

  async function handleOrgCreated(orgId: number) {
    await refreshOrgs()
    setActiveOrg(orgId)
    navigate(orgHomePath(orgId))
  }

  const noOrgs = !orgLoading && orgs.length === 0 && jwt != null && orgError == null

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

  // AQU-335: projects in orgs the caller is not a member of (invite-link /
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
              className={cn(buttonVariants())}
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
    <>
    <AppShell
      sidebar={<OrgSidebar />}
      header={
        <div className="flex items-center justify-between pr-4">
          <OrgBreadcrumb section="Projects" />
          {activeOrgId != null ? (
            <ProjectCreateDialog orgId={activeOrgId} onCreated={handleCreated} />
          ) : noOrgs ? (
            <Button type="button" size="sm" onClick={() => setCreateOrgOpen(true)}>
              Create organization
            </Button>
          ) : (
            <Badge variant="outline">Select an organization to create a project</Badge>
          )}
        </div>
      }
      statusBar={null}
      main={
        // AQU-366: the AppShell `main` slot is height-constrained by the shell's
        // flex chain (h-screen -> min-h-0/flex-1/overflow-hidden all the way
        // down), so `h-full` here resolves against a definite height and
        // `overflow-y-auto` is the intended (and only) scroll surface for this
        // list — see AQU-164 for the sibling "one primary scroll" rule.
        // `overscroll-contain` stops wheel/trackpad momentum from chaining to
        // (and getting swallowed by) an ancestor once this list's own scroll
        // is exhausted, which otherwise reads as "scrolling does nothing".
        <div className="h-full overflow-y-auto overscroll-contain p-6" data-testid="projects-list-scroll">
          {isPageLoading ? (
            <LoadingPanel label="Loading projects" className="min-h-[34rem]" />
          ) : noOrgs ? (
            <EmptyState
              icon={Building2}
              title="Create an organization to get started"
              description="Organizations hold your projects, members, and settings. Create one to start collaborating."
              action={
                <Button type="button" onClick={() => setCreateOrgOpen(true)}>
                  Create organization
                </Button>
              }
            />
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
                  <InputGroup className="h-9 w-full sm:w-72">
                    <InputGroupAddon>
                      <Search />
                    </InputGroupAddon>
                    <InputGroupInput
                      type="search"
                      placeholder="Filter projects…"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      aria-label="Filter projects by name"
                    />
                  </InputGroup>
                </div>

                {isAllOrgs && (
                  <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
                    <span className="text-xs font-medium text-muted-foreground">View</span>
                    <Select
                      items={PROJECT_LENSES.map((lens) => ({ value: lens.value, label: lens.label }))}
                      value={projectLens}
                      onValueChange={(v) => {
                        if (v && PROJECT_LENS_VALUES.includes(v as ProjectLens)) {
                          selectProjectLens(v as ProjectLens)
                        }
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        className="bg-background"
                        aria-label="Project list view"
                      >
                        <SelectValue className="flex-none" />
                      </SelectTrigger>
                      <SelectContent align="start">
                        <SelectGroup>
                          {PROJECT_LENSES.map((lens) => (
                            <SelectItem key={lens.value} value={lens.value}>
                              {lens.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-x-6 border-b bg-muted/30 px-4 py-2">
                  {isAllOrgs ? (
                    <>
                      <span className="text-xs font-medium text-muted-foreground">Name</span>
                      <span className="justify-self-start text-xs font-medium text-muted-foreground">Role</span>
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
                  <EmptyState
                    variant="inline"
                    className="py-10"
                    icon={filter ? Search : FolderOpen}
                    title={
                      filter
                        ? "No projects match your filter."
                        : isAllOrgs
                          ? projectLensEmpty
                          : "No projects in this org yet."
                    }
                  />
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

              {/* AQU-335: projects shared from orgs the caller doesn't belong
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
                      <ProjectRow
                        key={p.id}
                        project={p}
                        isNew={
                          username
                            ? isProjectNew(p.grantedAt, readProjectOpenedAt(username, p.id))
                            : false
                        }
                        onOpen={() => navigate(`/projects/${p.id}`)}
                      />
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      }
    />
    <OrgCreateDialog
      open={createOrgOpen}
      onOpenChange={setCreateOrgOpen}
      onCreated={(orgId) => void handleOrgCreated(orgId)}
    />
    </>
  )
}
