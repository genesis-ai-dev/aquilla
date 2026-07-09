import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import type { OrgSummary } from "@/lib/frontier/orgs"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getPortfolio, getPortfolios, translatedPct, validatedPct, attentionRank, audioPct, deadlineStatus, type PortfolioProject } from "@/lib/frontier/portfolio"
import { fetchAccessibleProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { partitionSharedProjects } from "@/lib/frontier/shared-projects"
import { listMyPendingInvites, type MyPendingInvite } from "@/lib/sync/invites"
import { WorkloadRollup } from "./WorkloadRollup"
import { UsageRollup } from "./UsageRollup"
import { CreditsPanel } from "./CreditsPanel"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"
import { ProjectCreateDialog } from "@/components/ProjectCreateDialog"
import { OrgSetupChecklist } from "./OrgSetupChecklist"
import type { ProjectRecord } from "@/lib/parsers/types"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Page, PageHeader, StatTile, EmptyState } from "@/components/ui/page"
import { Skeleton } from "@/components/ui/skeleton"
import { FolderPlus, X } from "lucide-react"

function ProjectRowSkeleton() {
  return (
    <div className="flex items-center gap-4 p-4">
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-1.5 w-full rounded-full" />
        <Skeleton className="h-1.5 w-full rounded-full" />
      </div>
      <div className="shrink-0 space-y-2 text-right">
        <Skeleton className="ml-auto h-3 w-16" />
        <Skeleton className="ml-auto h-3 w-16" />
      </div>
    </div>
  )
}

function OrgHomeSkeleton({ isAllOrgs }: { isAllOrgs: boolean }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[88px] space-y-2 rounded-2xl border bg-card p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-10" />
          </div>
        ))}
      </div>
      {isAllOrgs ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <section className="rounded-2xl border bg-card">
            <div className="border-b px-4 py-3">
              <Skeleton className="h-5 w-28" />
            </div>
            <div className="divide-y">
              {Array.from({ length: 3 }).map((_, i) => (
                <ProjectRowSkeleton key={i} />
              ))}
            </div>
          </section>
          <section className="rounded-2xl border bg-card">
            <div className="border-b px-4 py-3">
              <Skeleton className="h-5 w-20" />
            </div>
            <div className="divide-y">
              {Array.from({ length: 4 }).map((_, i) => (
                <ProjectRowSkeleton key={i} />
              ))}
            </div>
          </section>
        </div>
      ) : (
        <div className="rounded-2xl border divide-y">
          {Array.from({ length: 5 }).map((_, i) => (
            <ProjectRowSkeleton key={i} />
          ))}
        </div>
      )}
    </div>
  )
}

const STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000

type ActivityStatus = "not-started" | "stalled" | "active"

type StatusFilter = "all" | "stalled" | "overdue"

type ProjectLens = "recent" | "attention" | "least-translated" | "most-progress" | "name"

const PROJECT_LENS_STORAGE_KEY = "org:all-projects:view"
const PROJECT_LENS_VALUES: ProjectLens[] = ["recent", "attention", "least-translated", "most-progress", "name"]

type PortfolioProjectRow = PortfolioProject & {
  orgId?: number
  orgName?: string | null
}

type OrgPortfolioSummary = {
  org: OrgSummary
  projectCount: number
  avgTranslatedPct: number
  avgValidatedPct: number
  avgAudioPct: number
  stalledCount: number
  overdueCount: number
}

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "stalled", label: "Stalled" },
  { value: "overdue", label: "Overdue" },
]

const PROJECT_LENSES: { value: ProjectLens; label: string; description: string; empty: string }[] = [
  {
    value: "recent",
    label: "Recently updated",
    description: "Latest project activity across all organizations",
    empty: "No recently updated projects yet.",
  },
  {
    value: "attention",
    label: "Needs attention",
    description: "Highest-priority projects by deadline, activity, and progress",
    empty: "No projects need attention yet.",
  },
  {
    value: "least-translated",
    label: "Least translated",
    description: "Projects with the lowest translation progress",
    empty: "No projects yet.",
  },
  {
    value: "most-progress",
    label: "Most progress",
    description: "Projects with the highest translation progress",
    empty: "No projects yet.",
  },
  {
    value: "name",
    label: "Name",
    description: "Projects sorted alphabetically",
    empty: "No projects yet.",
  },
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

function isProjectLens(value: string | null | undefined): value is ProjectLens {
  return PROJECT_LENS_VALUES.includes(value as ProjectLens)
}

/**
 * A project that has never been edited and has no translated cells hasn't
 * stalled — it just hasn't started yet. "Stalled" is reserved for projects
 * that had activity and then went quiet for 14+ days.
 */
export function activityStatus(p: PortfolioProject, now: number): ActivityStatus {
  if (p.lastEditAt == null && p.filledCells === 0) return "not-started"
  if (p.lastEditAt == null || now - p.lastEditAt > STALE_THRESHOLD_MS) return "stalled"
  return "active"
}

function averagePct(projects: PortfolioProjectRow[], readPct: (project: PortfolioProjectRow) => number): number {
  return projects.length > 0 ? projects.reduce((sum, project) => sum + readPct(project), 0) / projects.length : 0
}

function orgDisplayName(org: OrgSummary): string {
  return org.name ?? "Workspace"
}

function roleLabel(org: OrgSummary): string {
  return org.role.name.replace(/_/g, " ")
}

function formatUpdatedAt(value: number | null): string {
  if (value == null) return "No activity yet"
  return `Updated ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value))}`
}

function sortProjectsByLens(projects: PortfolioProjectRow[], lens: ProjectLens, now: number): PortfolioProjectRow[] {
  return [...projects].sort((a, b) => {
    switch (lens) {
      case "recent":
        return (b.lastEditAt ?? 0) - (a.lastEditAt ?? 0) || a.name.localeCompare(b.name)
      case "least-translated":
        return translatedPct(a) - translatedPct(b) || a.name.localeCompare(b.name)
      case "most-progress":
        return translatedPct(b) - translatedPct(a) || a.name.localeCompare(b.name)
      case "name":
        return a.name.localeCompare(b.name)
      case "attention":
        return attentionRank(b, now) - attentionRank(a, now) || a.name.localeCompare(b.name)
    }
  })
}

export function OrgHome() {
  const { activeOrg, activeOrgId, isAllOrgs, orgs, isLoading: orgLoading, setActiveOrg } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const navigate = useNavigate()
  const jwt = session?.jwt ?? null

  const [projects, setProjects] = useState<PortfolioProjectRow[]>([])
  // FRO-335: accessible-project rows supply direct/group/org role attribution
  // and identify projects shared from orgs the portfolio endpoint can't see.
  const [accessibleProjects, setAccessibleProjects] = useState<CloudProjectSummary[]>([])
  // FRO-326: unredeemed invites addressed to the caller's email — without
  // this card, an invite whose link never arrived is undiscoverable in-app.
  const [pendingInvites, setPendingInvites] = useState<MyPendingInvite[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [projectQuery, setProjectQuery] = useState("")
  const [orgQuery, setOrgQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [projectLens, setProjectLens] = useState<ProjectLens>(readProjectLens)

  useEffect(() => {
    if (!jwt) {
      setProjects([])
      setLoading(false)
      return
    }
    if (isAllOrgs) {
      if (orgLoading) {
        setLoading(false)
        return
      }
      if (orgs.length === 0) {
        setProjects([])
        setLoading(false)
        return
      }
      let cancelled = false
      setLoading(true)
      setError(null)
      const orgById = new Map(orgs.map((org) => [org.id, org]))
      getPortfolios(jwt, orgs.map((org) => org.id))
        .then((portfolios) => {
          if (!cancelled) setProjects(portfolios.flatMap(({ orgId, projects: list }) => {
            const org = orgById.get(orgId)
            if (!org) return []
            return list.map((project) => ({
              ...project,
              orgId: org.id,
              orgName: org.name ?? "Workspace",
            }))
          }))
        })
        .catch((err) => {
          if (!cancelled) {
            if (err instanceof UserError && err.category === "session-expired") {
              notifySessionExpired()
            }
            setError(err instanceof Error ? err.message : String(err))
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      return () => { cancelled = true }
    }
    if (activeOrgId == null) {
      setProjects([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    getPortfolio(jwt, activeOrgId)
      .then((list) => {
        if (!cancelled) {
          setProjects(list.map((project) => ({
            ...project,
            orgId: activeOrgId,
            orgName: activeOrg?.name ?? "Workspace",
          })))
        }
      })
      .catch((err) => {
        if (!cancelled) {
          if (err instanceof UserError && err.category === "session-expired") {
            notifySessionExpired()
          }
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [jwt, activeOrgId, activeOrg?.name, isAllOrgs, orgLoading, orgs])

  // FRO-335: surface cross-org grants on the Projects page too — otherwise a user
  // whose only project arrived via an invite link sees an empty dashboard.
  useEffect(() => {
    if (!jwt) {
      setAccessibleProjects([])
      return
    }
    if (orgLoading) return
    let cancelled = false
    fetchAccessibleProjects(jwt)
      .then((all) => {
        if (cancelled) return
        setAccessibleProjects(all)
      })
      .catch(() => { if (!cancelled) setAccessibleProjects([]) })
    return () => { cancelled = true }
  }, [jwt, orgs, activeOrgId, orgLoading])

  // FRO-326: received-invites surface. Org-independent (matched by email).
  useEffect(() => {
    if (!jwt) { setPendingInvites([]); return }
    let cancelled = false
    listMyPendingInvites(jwt)
      .then((list) => { if (!cancelled) setPendingInvites(list) })
      .catch(() => { if (!cancelled) setPendingInvites([]) })
    return () => { cancelled = true }
  }, [jwt])

  // Signed-out state: session finished loading but no JWT.
  // Never show zero-stat fake-empty cards for unauthenticated visitors.
  if (!sessionLoading && !jwt) {
    return (
      <AppShell
        sidebar={<OrgSidebar />}
        header={<OrgBreadcrumb section="Projects" />}
        statusBar={null}
        main={
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="text-lg font-medium">Sign in to see your workspace</p>
            <p className="text-sm text-muted-foreground max-w-xs">
              Your session has ended or you are not signed in. Sign in to access your projects and translation data.
            </p>
            <Link
              to={`/login?next=${encodeURIComponent("/")}`}
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
  const workspaceLabel = isAllOrgs ? "All organizations" : activeOrg?.name ?? "Workspace"

  // Rollup stats
  const now = Date.now()
  const avgTranslatedPct =
    projects.length > 0
      ? projects.reduce((sum, p) => sum + translatedPct(p), 0) / projects.length
      : 0
  const avgValidatedPct =
    projects.length > 0
      ? projects.reduce((sum, p) => sum + validatedPct(p), 0) / projects.length
      : 0
  const stalledCount = projects.filter((p) => activityStatus(p, now) === "stalled").length
  const overdueCount = projects.filter((p) => deadlineStatus(p, now) === "overdue").length
  const avgAudioPct =
    projects.length > 0 ? projects.reduce((sum, p) => sum + audioPct(p), 0) / projects.length : 0
  const accessByProjectId = new Map(accessibleProjects.map((project) => [project.id, project]))
  const sharedProjects = partitionSharedProjects(accessibleProjects, orgs, activeOrgId).sharedWithMe

  const orgSummaries: OrgPortfolioSummary[] = orgs
    .map((org) => {
      const orgProjects = projects.filter((project) => project.orgId === org.id)
      return {
        org,
        projectCount: orgProjects.length,
        avgTranslatedPct: averagePct(orgProjects, translatedPct),
        avgValidatedPct: averagePct(orgProjects, validatedPct),
        avgAudioPct: averagePct(orgProjects, audioPct),
        stalledCount: orgProjects.filter((project) => activityStatus(project, now) === "stalled").length,
        overdueCount: orgProjects.filter((project) => deadlineStatus(project, now) === "overdue").length,
      }
    })
    .sort((a, b) => orgDisplayName(a.org).localeCompare(orgDisplayName(b.org)))

  const visibleOrgSummaries = orgSummaries.filter((summary) => {
    if (!orgQuery) return true
    return orgDisplayName(summary.org).toLowerCase().includes(orgQuery.toLowerCase())
  })

  function openOrg(orgId: number) {
    setActiveOrg(orgId)
    navigate({ pathname: "/", search: `?org=${orgId}` })
  }

  function selectProjectLens(lens: ProjectLens) {
    setProjectLens(lens)
    writeProjectLens(lens)
  }

  function handleProjectLensChange(value: string | null) {
    if (!isProjectLens(value)) return
    selectProjectLens(value)
  }

  function handleCreated(project: ProjectRecord) {
    navigate(`/projects/${project.id}`)
  }

  const projectSearchClassName =
    "h-9 w-full rounded-md border border-border bg-background px-3 pr-9 text-sm focus-visible:border-muted-foreground/40 focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-sm"
  const projectControlGroupClassName =
    "flex min-w-fit shrink-0 items-center gap-2 whitespace-nowrap"

  // Project lists
  const currentProjectLens = PROJECT_LENSES.find((lens) => lens.value === projectLens) ?? PROJECT_LENSES[0]

  // Filter bar — narrows the listed projects only; the rollup strip above
  // continues to reflect the full portfolio.
  const filteredProjects = projects.filter((p) => {
    if (projectQuery && !p.name.toLowerCase().includes(projectQuery.toLowerCase())) return false
    switch (statusFilter) {
      case "stalled":
        return activityStatus(p, now) === "stalled"
      case "overdue":
        return deadlineStatus(p, now) === "overdue"
      default:
        return true
    }
  })
  const visible = sortProjectsByLens(filteredProjects, projectLens, now)

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
        <Page size="wide">
          <PageHeader title={workspaceLabel} />
          {isPageLoading ? (
            <OrgHomeSkeleton isAllOrgs={isAllOrgs} />
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <div className="space-y-6">
              {/* FRO-326: received invites — the user has been invited but
                  hasn't accepted yet. Without this, an invite whose email/link
                  never arrived is undiscoverable in-app. */}
              {pendingInvites.length > 0 && (
                <section data-testid="pending-invitations" className="space-y-2">
                  <h2 className="text-sm font-medium text-muted-foreground">Pending invitations</h2>
                  <div className="rounded-2xl border divide-y">
                    {pendingInvites.map((inv) => (
                      <div key={inv.token} className="flex flex-wrap items-center gap-3 p-4">
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-sm font-medium">
                            {inv.projects.map((p) => p.projectName).join(", ")}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Invited by {inv.createdBy} as {inv.role.name.replace(/_/g, " ")}
                            {inv.expiresAt ? ` · expires ${new Date(inv.expiresAt).toLocaleDateString()}` : ""}
                          </p>
                        </div>
                        <Link
                          to={`/join/${inv.token}`}
                          className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                        >
                          Review &amp; accept
                        </Link>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {!isAllOrgs && activeOrgId != null && (
                <OrgSetupChecklist
                  orgId={activeOrgId}
                  projectCount={projects.length}
                  onProjectCreated={handleCreated}
                />
              )}

              {isAllOrgs ? (
                <>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
                    <StatTile label="Organizations" value={orgs.length} />
                    <StatTile label="Projects" value={projects.length} />
                    <StatTile label="Avg translated" value={`${Math.round(avgTranslatedPct * 100)}%`} />
                    <StatTile label="Avg validated" value={`${Math.round(avgValidatedPct * 100)}%`} />
                    <StatTile label="Stalled" value={stalledCount} />
                    <StatTile
                      label="Overdue"
                      value={
                        <span className={overdueCount > 0 ? "text-destructive" : undefined}>
                          {overdueCount}
                        </span>
                      }
                    />
                  </div>

                  <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                    <section className="rounded-2xl border bg-card">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                        <div>
                          <h2 className="text-base font-semibold">Organizations</h2>
                          <p className="text-xs text-muted-foreground">
                            {visibleOrgSummaries.length} of {orgSummaries.length}
                          </p>
                        </div>
                        {orgSummaries.length > 0 && (
                          <input
                            type="search"
                            value={orgQuery}
                            onChange={(e) => setOrgQuery(e.target.value)}
                            placeholder="Filter organizations…"
                            aria-label="Filter organizations by name"
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-56"
                          />
                        )}
                      </div>

                      {orgSummaries.length === 0 ? (
                        <div className="px-4 py-10 text-center">
                          <p className="text-sm text-muted-foreground">No organizations yet.</p>
                        </div>
                      ) : visibleOrgSummaries.length === 0 ? (
                        <div className="px-4 py-10 text-center">
                          <p className="text-sm text-muted-foreground">No matching organizations.</p>
                        </div>
                      ) : (
                        <div className="divide-y">
                          {visibleOrgSummaries.map((summary) => (
                            <button
                              key={summary.org.id}
                              type="button"
                              onClick={() => openOrg(summary.org.id)}
                              className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-muted/50"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="truncate font-medium">{orgDisplayName(summary.org)}</p>
                                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                    {roleLabel(summary.org)}
                                  </span>
                                </div>
                                <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                                  <span>{summary.projectCount} project{summary.projectCount === 1 ? "" : "s"}</span>
                                  <span>{Math.round(summary.avgTranslatedPct * 100)}% translated</span>
                                  <span>{Math.round(summary.avgValidatedPct * 100)}% validated</span>
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </section>

                    <section className="rounded-2xl border bg-card">
                      <div className="space-y-3 border-b px-4 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h2 className="text-base font-semibold">Projects</h2>
                            <p className="text-xs text-muted-foreground">{currentProjectLens.description}</p>
                          </div>
                        </div>
                        <div className="flex w-full flex-nowrap items-center gap-2 overflow-x-auto overflow-y-hidden">
                          <div className="relative min-w-[12rem] flex-[1_1_13rem] max-w-52">
                            <input
                              type="text"
                              value={projectQuery}
                              onChange={(e) => setProjectQuery(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") e.currentTarget.blur()
                              }}
                              placeholder="Filter projects…"
                              aria-label="Filter projects by name"
                              autoCorrect="off"
                              autoCapitalize="none"
                              spellCheck={false}
                              className={projectSearchClassName}
                            />
                            {projectQuery && (
                              <button
                                type="button"
                                aria-label="Clear project filter"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => setProjectQuery("")}
                                className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                              >
                                <X className="size-3.5" aria-hidden />
                              </button>
                            )}
                          </div>
                          <div className={projectControlGroupClassName}>
                            <div className="flex items-center gap-2" aria-label="Project status filter">
                              <span className="text-xs font-medium text-muted-foreground">Status</span>
                              <div className="flex items-center gap-1">
                                {STATUS_FILTERS.map((f) => (
                                  <button
                                    key={f.value}
                                    type="button"
                                    onClick={() => setStatusFilter(f.value)}
                                    aria-pressed={statusFilter === f.value}
                                    className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                                      statusFilter === f.value
                                        ? "bg-primary text-primary-foreground"
                                        : "bg-muted text-muted-foreground hover:bg-muted/70"
                                    }`}
                                  >
                                    {f.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div className="flex items-center gap-2" aria-label="Project sort">
                              <span className="text-xs font-medium text-muted-foreground">Sort by</span>
                              <Select
                                items={PROJECT_LENSES.map((lens) => ({ value: lens.value, label: lens.label }))}
                                value={projectLens}
                                onValueChange={handleProjectLensChange}
                              >
                                <SelectTrigger aria-label="Sort projects" size="sm" className="min-w-40 bg-background">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
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
                          </div>
                        </div>
                      </div>

                      {projects.length === 0 ? (
                        <div className="px-4 py-10 text-center">
                          <p className="text-sm text-muted-foreground">No projects yet.</p>
                        </div>
                      ) : visible.length === 0 ? (
                        <div className="px-4 py-10 text-center">
                          <p className="text-sm text-muted-foreground">
                            {projectQuery ? "No matching projects." : currentProjectLens.empty}
                          </p>
                        </div>
                      ) : (
                        <div className="divide-y">
                          {visible.map((p) => {
                            const access = accessByProjectId.get(p.id)
                            const tpct = Math.round(translatedPct(p) * 100)
                            const pct = Math.round(validatedPct(p) * 100)
                            const apct = Math.round(audioPct(p) * 100)
                            const status = activityStatus(p, now)
                            const dstatus = deadlineStatus(p, now)
                            const statusText =
                              projectLens === "recent"
                                ? formatUpdatedAt(p.lastEditAt)
                                : status === "stalled"
                                  ? "Stalled"
                                  : status === "not-started"
                                    ? "Not started"
                                    : `${tpct}% translated`
                            return (
                              <Link
                                key={p.id}
                                to={`/projects/${p.id}`}
                                className="flex items-center gap-4 p-4 hover:bg-muted/50 transition-colors"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <p className="truncate font-medium">{p.name}</p>
                                    {p.orgName && (
                                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                        {p.orgName}
                                      </span>
                                    )}
                                    {access && (
                                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                        {access.role.name}
                                      </span>
                                    )}
                                    {dstatus === "overdue" && (
                                      <span className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">
                                        Overdue
                                      </span>
                                    )}
                                    {dstatus === "soon" && (
                                      <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                                        Due soon
                                      </span>
                                    )}
                                  </div>
                                  <div
                                    className="mt-1 space-y-0.5"
                                    aria-label={`${tpct}% translated, ${pct}% validated`}
                                  >
                                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                                      <div className="h-full rounded-full bg-amber-500" style={{ width: `${tpct}%` }} />
                                    </div>
                                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                                    </div>
                                  </div>
                                </div>
                                <div className="shrink-0 text-right">
                                  <p className={`text-xs ${status === "stalled" ? "text-destructive" : "text-muted-foreground"}`}>
                                    {statusText}
                                  </p>
                                  <p className="text-xs text-muted-foreground">{pct}% validated</p>
                                  <p className="text-xs text-muted-foreground">{apct}% audio</p>
                                </div>
                              </Link>
                            )
                          })}
                        </div>
                      )}
                    </section>
                  </div>
                </>
              ) : (
                <>
                  {/* Rollup strip */}
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
                    <StatTile label="Projects" value={projects.length} />
                    <StatTile label="Avg translated" value={`${Math.round(avgTranslatedPct * 100)}%`} />
                    <StatTile label="Avg validated" value={`${Math.round(avgValidatedPct * 100)}%`} />
                    <StatTile label="Avg audio" value={`${Math.round(avgAudioPct * 100)}%`} />
                    <StatTile label="Stalled" value={stalledCount} />
                    <StatTile
                      label="Overdue"
                      value={
                        <span className={overdueCount > 0 ? "text-destructive" : undefined}>
                          {overdueCount}
                        </span>
                      }
                    />
                  </div>

                  {/* Filter bar */}
                  {projects.length > 0 && (
                    <div className="flex w-full flex-nowrap items-center gap-2 overflow-x-auto overflow-y-hidden">
                      <div className="relative min-w-[12rem] flex-[1_1_13rem] max-w-52">
                        <input
                          type="text"
                          value={projectQuery}
                          onChange={(e) => setProjectQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") e.currentTarget.blur()
                          }}
                          placeholder="Filter projects…"
                          aria-label="Filter projects by name"
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          className={projectSearchClassName}
                        />
                        {projectQuery && (
                          <button
                            type="button"
                            aria-label="Clear project filter"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setProjectQuery("")}
                            className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <X className="size-3.5" aria-hidden />
                          </button>
                        )}
                      </div>
                      <div className={projectControlGroupClassName}>
                        <div className="flex items-center gap-2" aria-label="Project status filter">
                          <span className="text-xs font-medium text-muted-foreground">Status</span>
                          <div className="flex items-center gap-1">
                            {STATUS_FILTERS.map((f) => (
                              <button
                                key={f.value}
                                type="button"
                                onClick={() => setStatusFilter(f.value)}
                                aria-pressed={statusFilter === f.value}
                                className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                                  statusFilter === f.value
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-muted text-muted-foreground hover:bg-muted/70"
                                }`}
                              >
                                {f.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center gap-2" aria-label="Project sort">
                          <span className="text-xs font-medium text-muted-foreground">Sort by</span>
                          <Select
                            items={PROJECT_LENSES.map((lens) => ({ value: lens.value, label: lens.label }))}
                            value={projectLens}
                            onValueChange={handleProjectLensChange}
                          >
                            <SelectTrigger aria-label="Sort projects" size="sm" className="min-w-40 bg-background">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
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
                      </div>
                    </div>
                  )}

                  {/* Project directory */}
                  {projects.length === 0 ? (
                    <EmptyState
                      icon={FolderPlus}
                      title="Your organization is ready"
                      description="Start a translation project, or bring your team in first — Aquilla is built for people working together."
                      action={
                        <div className="flex flex-wrap items-center justify-center gap-2">
                          {activeOrgId != null && (
                            <ProjectCreateDialog orgId={activeOrgId} onCreated={handleCreated} />
                          )}
                          <Button variant="outline" onClick={() => navigate("/members")}>
                            Invite your team
                          </Button>
                        </div>
                      }
                    />
                  ) : visible.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No matching projects.</p>
                  ) : (
                    <div className="rounded-2xl border divide-y">
                      {visible.map((p) => {
                        const access = accessByProjectId.get(p.id)
                        const tpct = Math.round(translatedPct(p) * 100)
                        const pct = Math.round(validatedPct(p) * 100)
                        const apct = Math.round(audioPct(p) * 100)
                        const status = activityStatus(p, now)
                        const dstatus = deadlineStatus(p, now)
                        return (
                          <Link
                            key={p.id}
                            to={`/projects/${p.id}`}
                            className="flex items-center gap-4 p-4 hover:bg-muted/50 transition-colors"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="font-medium truncate">{p.name}</p>
                                {access && (
                                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                    {access.role.name}
                                  </span>
                                )}
                                {dstatus === "overdue" && (
                                  <span className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">
                                    Overdue
                                  </span>
                                )}
                                {dstatus === "soon" && (
                                  <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                                    Due soon
                                  </span>
                                )}
                              </div>
                              <div
                                className="mt-1 space-y-0.5"
                                aria-label={`${tpct}% translated, ${pct}% validated`}
                              >
                                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                                  <div className="h-full rounded-full bg-amber-500" style={{ width: `${tpct}%` }} />
                                </div>
                                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                                  <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                                </div>
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className={`text-xs ${status === "stalled" ? "text-destructive" : "text-muted-foreground"}`}>
                                {status === "stalled"
                                  ? "Stalled"
                                  : status === "not-started"
                                    ? "Not started"
                                    : `${tpct}% translated`}
                              </p>
                              <p className="text-xs text-muted-foreground">{pct}% validated</p>
                              <p className="text-xs text-muted-foreground">{apct}% audio</p>
                            </div>
                          </Link>
                        )
                      })}
                    </div>
                  )}

                  {/* FRO-335: cross-org projects (invite-link / bulk-add grants).
                      Listed separately — they're not part of this org's portfolio,
                      but hiding them made them unreachable from every nav surface. */}
                  {sharedProjects.length > 0 && (
                    <section data-testid="shared-with-you" className="space-y-2">
                      <h2 className="text-sm font-medium text-muted-foreground">Shared with you</h2>
                      <div className="rounded-2xl border divide-y">
                        {sharedProjects.map((p) => (
                          <Link
                            key={p.id}
                            to={`/projects/${p.id}`}
                            className="flex items-center gap-4 p-4 hover:bg-muted/50 transition-colors"
                          >
                            <p className="flex-1 min-w-0 truncate font-medium">{p.name}</p>
                            <span className="shrink-0 text-xs text-muted-foreground">{p.role.name}</span>
                          </Link>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}

              {jwt && !isAllOrgs && activeOrgId != null && <WorkloadRollup jwt={jwt} orgId={activeOrgId} />}
              {jwt && !isAllOrgs && activeOrgId != null && <UsageRollup jwt={jwt} orgId={activeOrgId} />}
              {jwt && !isAllOrgs && activeOrgId != null && (
                <CreditsPanel
                  jwt={jwt}
                  orgId={activeOrgId}
                  orgRoleLevel={activeOrg?.role.level ?? 0}
                />
              )}
            </div>
          )}
        </Page>
      }
    />
  )
}
