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
import type { ProjectRecord } from "@/lib/parsers/types"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"
import { attentionRank, deadlineStatus, getPortfolios, translatedPct, type PortfolioProject } from "@/lib/frontier/portfolio"
import { UserError } from "@/lib/errors/user-error"
import { buttonVariants, Button } from "@/components/ui/button"
import { RoleLabel } from "@/components/RoleLabel"
import { Badge } from "@/components/ui/badge"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"
import { FolderOpen, Search } from "lucide-react"
import { EmptyState } from "@/components/ui/page"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

// ── Sort options ─────────────────────────────────────────────────────────────
type SortKey = "name" | "role"
type SortDir = "asc" | "desc"
type ProjectLens = "recent" | "attention" | "overdue" | "least-translated"

const PROJECT_LENS_STORAGE_KEY = "org:all-projects:view"
const PROJECT_LENS_VALUES: ProjectLens[] = ["recent", "attention", "overdue", "least-translated"]

const PROJECT_LENSES: { value: ProjectLens; labelKey: MessageKey; emptyKey: MessageKey }[] = [
  { value: "recent", labelKey: "org.orgHome.lens.recentLabel", emptyKey: "org.orgHome.lens.recentEmpty" },
  { value: "attention", labelKey: "autopilot.status.needsAttention", emptyKey: "org.orgHome.lens.attentionEmpty" },
  { value: "overdue", labelKey: "org.orgHome.overdue", emptyKey: "org.orgHome.emptyTitle.overdue" },
  { value: "least-translated", labelKey: "org.orgHome.lens.leastTranslatedLabel", emptyKey: "org.orgHome.noProjectsYet" },
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
      className={`inline-flex justify-self-start select-none text-start text-xs font-medium ${
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
  const t = useT()
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full grid-cols-[minmax(0,1fr)_7rem] items-center gap-x-6 px-4 py-3 text-start transition-colors hover:bg-muted/50"
      >
        {/* Name + status badge */}
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{p.name}</span>
          {isNew && (
            <Badge className="shrink-0" data-testid="new-shared-badge">
              {t("org.guestOrgHome.newBadge")}
            </Badge>
          )}
          {orgLabel && (
            <Badge variant="secondary" className="shrink-0">
              {orgLabel}
            </Badge>
          )}
          {p.isActive === false && (
            <Badge variant="secondary" className="shrink-0">
              {t("org.projectOverview.inactiveBadge")}
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
  const { activeOrgId, isAllOrgs, orgs, isLoading: orgLoading, error: orgError, refresh: refreshOrgs } = useActiveOrg()
  const t = useT()
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
    if (project.orgId == null) return t("org.projectsList.noOrgLabel")
    return orgNameById.get(project.orgId) ?? t("org.projectsList.externalOrgLabel")
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
  const projectLensEmpty = t(
    PROJECT_LENSES.find((lens) => lens.value === projectLens)?.emptyKey ?? "org.orgHome.noProjectsYet",
  )
  const projectCountLabel = filter.trim() || (isAllOrgs && projectLens === "overdue")
    ? t("org.projectsList.shownOfTotal", { visible: visibleProjectCount, total: totalProjectCount })
    : t("org.orgHome.organizationsPanel.projectCount", { count: totalProjectCount })

  // Signed-out or org-less: session finished loading but no JWT.
  if (!sessionLoading && !orgLoading && !jwt) {
    return (
      <AppShell
        sidebar={<OrgSidebar />}
        header={
          <div className="flex items-center justify-between pe-4">
            <OrgBreadcrumb section={t("nav.projects")} isProjectsLanding />
          </div>
        }
        statusBar={null}
        main={
          <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="text-lg font-medium">{t("org.projectsList.signedOutTitle")}</p>
            <p className="text-sm text-muted-foreground max-w-xs">
              {t("org.projectsList.signedOutBody")}
            </p>
            <Link
              to={`/login?next=${encodeURIComponent("/projects")}`}
              className={cn(buttonVariants())}
            >
              {t("auth.login.title")}
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
        <div className="flex items-center justify-between pe-4">
          <OrgBreadcrumb section={t("nav.projects")} />
          {activeOrgId != null ? (
            <ProjectCreateDialog orgId={activeOrgId} onCreated={handleCreated} />
          ) : (
            <Badge variant="outline">{t("org.orgHome.selectOrgToCreateProject")}</Badge>
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
            <LoadingPanel label={t("org.projectsList.loadingLabel")} className="min-h-[34rem]" />
          ) : unreachable || orgsUnreachable ? (
            // AQU-882: the sidebar org switcher now carries its own retry
            // affordance during an org-load failure, so this banner's Retry is
            // no longer the only one on the page — tests must scope to it.
            <div
              data-testid="projects-unreachable-banner"
              className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800 dark:bg-amber-950"
            >
              <span className="text-amber-800 dark:text-amber-200">
                {t("org.projectsList.unreachableBanner")}
              </span>
              <button
                type="button"
                onClick={retryUnreachable}
                className="shrink-0 rounded-md bg-amber-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600"
              >
                {t("common.retry")}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <section className="rounded-lg border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                  <div className="min-w-0">
                    <h1 className="text-base font-semibold">{isAllOrgs ? t("org.switcher.allProjects") : t("nav.projects")}</h1>
                    <p className="text-xs text-muted-foreground">{projectCountLabel}</p>
                  </div>
                  <InputGroup className="h-9 w-full sm:w-72">
                    <InputGroupAddon>
                      <Search />
                    </InputGroupAddon>
                    <InputGroupInput
                      type="search"
                      placeholder={t("org.orgHome.projectsPanel.filterPlaceholder")}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      aria-label={t("org.orgHome.projectsPanel.filterAria")}
                    />
                  </InputGroup>
                </div>

                {isAllOrgs && (
                  <div className="flex flex-wrap items-center gap-1 border-b px-4 py-3" aria-label={t("org.projectsList.lensGroupAriaLabel")}>
                    {PROJECT_LENSES.map((lens) => (
                      <Button
                        key={lens.value}
                        type="button"
                        size="xs"
                        variant={projectLens === lens.value ? "default" : "secondary"}
                        onClick={() => selectProjectLens(lens.value)}
                        aria-pressed={projectLens === lens.value}
                      >
                        {t(lens.labelKey)}
                      </Button>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-x-6 border-b bg-muted/30 px-4 py-2">
                  {isAllOrgs ? (
                    <>
                      <span className="text-xs font-medium text-muted-foreground">{t("common.name")}</span>
                      <span className="justify-self-start text-xs font-medium text-muted-foreground">{t("common.roleLabel")}</span>
                    </>
                  ) : (
                    <>
                      <SortButton
                        label={t("common.name")}
                        colKey="name"
                        sortKey={sortKey}
                        sortDir={sortDir}
                        onSort={handleSort}
                      />
                      <SortButton
                        label={t("common.roleLabel")}
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
                        ? t("org.projectsList.noFilterMatch")
                        : isAllOrgs
                          ? projectLensEmpty
                          : t("org.projectsList.noOrgProjectsYet")
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
                    <h2 className="text-sm font-medium">{t("editor.navTitle.sharedWithYou")}</h2>
                    <p className="text-xs text-muted-foreground">
                      {t("org.projectsList.sharedWithYouDescription")}
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
  )
}
