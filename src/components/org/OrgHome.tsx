import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import type { OrgSummary } from "@/lib/frontier/orgs"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getPortfolio, getPortfolios, translatedPct, validatedPct, attentionRank, audioPct, deadlineStatus, type PortfolioProject } from "@/lib/frontier/portfolio"
import { portfolioActivityStatus } from "@/lib/project-status"
import { ProjectDeadlineStatuses } from "@/components/ProjectStatus"
import { fetchAccessibleProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { partitionSharedProjects } from "@/lib/frontier/shared-projects"
import { listMyPendingInvites, type MyPendingInvite } from "@/lib/sync/invites"
import { WorkloadRollup } from "./WorkloadRollup"
import { UsageRollup } from "./UsageRollup"
import { CreditsPanel } from "./CreditsPanel"
import {
  SectionVisibilityBadge,
  SectionVisibilityGate,
  sectionTintClass,
} from "./SectionVisibilityBadge"
import { useOrgSettings, canEditRosterProgressFloor } from "@/hooks/useOrgSettings"
import { ROLE, roleDisplayText } from "@/lib/frontier/roles"
import { RoleLabel } from "@/components/RoleLabel"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"
import { ProjectCreateDialog } from "@/components/ProjectCreateDialog"
import { OrgSetupChecklist } from "./OrgSetupChecklist"
import { OrgProjectsDataTable } from "./OrgProjectsDataTable"
import type { ProjectRecord } from "@/lib/parsers/types"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button, buttonVariants } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Page, PageHeader, StatTile, EmptyState } from "@/components/ui/page"
import { AppTooltip, TooltipDelegationBoundary } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { FolderPlus, Search, X, Building2 } from "lucide-react"

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


type ActivityStatus = "not-started" | "stalled" | "active"

/** @deprecated Import portfolioActivityStatus from @/lib/project-status */
export function activityStatus(p: PortfolioProject, now: number): ActivityStatus {
  return portfolioActivityStatus(p, now)
}

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

function averagePct(projects: PortfolioProjectRow[], readPct: (project: PortfolioProjectRow) => number): number {
  return projects.length > 0 ? projects.reduce((sum, project) => sum + readPct(project), 0) / projects.length : 0
}

function orgDisplayName(org: OrgSummary): string {
  return org.name ?? "Workspace"
}

function roleLabel(org: OrgSummary): string {
  return roleDisplayText(org.role.name)
}

function formatShortDate(value: number | null): string {
  if (value == null) return "—"
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value))
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

// Shared column template keeps headers and data aligned. The identity cell is
// flexible; metric/date columns stay fixed. In all-orgs mode the organization
// remains a compact secondary badge inside that cell and yields space to the
// project name first. Audio is 5rem to keep "Has Audio" on one line.
const PROJECT_TABLE_COLS = [
  "grid-cols-[minmax(0,1fr)_4.5rem_4.5rem]",
  "@xl/project-table:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5rem]",
  "@2xl/project-table:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5rem_5.5rem]",
  "@3xl/project-table:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5rem_5.5rem_6rem]",
].join(" ")

/**
 * The org/portfolio project list as a compact table — one row per project with
 * aligned Translated / Validated / Has Audio / Updated columns — instead of a
 * stack of full-width progress-bar cards. Rows stay `<Link>`s so cmd-click
 * still opens a project in a new tab. Wrapped in `overflow-x-auto` so the
 * fixed columns can scroll rather than squash on a narrow viewport.
 *
 * AQU-489: column headers ARE the visible label for each number (no hover
 * required to identify what a figure means); the header tooltips below are
 * retained as EXTRA detail only. "Has Audio" (not bare "Audio") mirrors the
 * ProjectOverview.tsx relabel from AQU-490 — this table has no per-medium
 * validation figure to show (server doesn't track one; see AQU-490's
 * in-code note there), so unlike ProjectOverview there is no separate
 * "Audio Validated" column here — just the coverage figure, honestly named.
 *
 * SWARM-TODO(AQU-489): verify live — open the org home / all-organizations
 * projects table and confirm each column header ("Translated", "Validated",
 * "Has Audio") reads as a permanent visible label with NO hover required;
 * hovering a header may show extra detail (a one-line tooltip) but the
 * meaning must already be legible from the header text alone. Then open a
 * single project's overview (ProjectOverview.tsx Progress card) and confirm
 * the same three terms — plus "Audio Validated" — are used identically
 * (not "Audio" bare, not "Approved" instead of "Validated").
 */
export function ProjectTable({
  projects,
  now,
  showOrg,
  roleByProjectId,
}: {
  projects: PortfolioProjectRow[]
  now: number
  showOrg: boolean
  roleByProjectId?: Map<string, CloudProjectSummary["role"]>
}) {
  return (
    <TooltipDelegationBoundary>
      <div data-testid="project-table" className="@container/project-table overflow-hidden">
        <div className="w-full">
        <div
          className={`grid ${PROJECT_TABLE_COLS} gap-x-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground`}
        >
          <span>Name</span>
          <AppTooltip content="Percentage of cells with target-language content filled in.">
            <span className="whitespace-nowrap text-right">Translated</span>
          </AppTooltip>
          <AppTooltip content="Percentage of cells marked validated by a reviewer.">
            <span className="whitespace-nowrap text-right">Validated</span>
          </AppTooltip>
          <AppTooltip content="Percentage of cells that have at least one audio recording attached. This is coverage, not validation — audio-specific validation isn't tracked yet (see AQU-490).">
            <span className="hidden whitespace-nowrap text-right @xl/project-table:block">Has Audio</span>
          </AppTooltip>
          <span className="hidden whitespace-nowrap text-right @2xl/project-table:block">Role</span>
          <span className="hidden whitespace-nowrap text-right @3xl/project-table:block">Updated</span>
        </div>
        <div className="divide-y">
          {projects.map((p) => {
            const tpct = Math.round(translatedPct(p) * 100)
            const pct = Math.round(validatedPct(p) * 100)
            const apct = Math.round(audioPct(p) * 100)
            const role = roleByProjectId?.get(p.id)
            const status = activityStatus(p, now)
            const dstatus = deadlineStatus(p, now)
            return (
              <Link
                key={p.id}
                to={`/projects/${p.id}`}
                data-project-id={p.id}
                className={`grid ${PROJECT_TABLE_COLS} items-center gap-x-3 px-4 py-2.5 text-sm transition-colors hover:bg-muted/50`}
              >
                <span data-testid="project-table-identity" className="flex min-w-0 items-center gap-2">
                  <AppTooltip content={p.name} side="top" delay={300}>
                    <span data-testid="project-table-name" className="min-w-0 flex-1 truncate font-medium">
                      {p.name}
                    </span>
                  </AppTooltip>
                  {showOrg && p.orgName && (
                    <AppTooltip content={p.orgName} side="top" delay={300}>
                      <span
                        data-testid="project-table-organization"
                        className="inline-flex w-[clamp(4rem,35%,10rem)] min-w-0 flex-none overflow-hidden"
                      >
                        <Badge variant="secondary" className="min-w-0 w-full">
                          <span className="truncate">{p.orgName}</span>
                        </Badge>
                      </span>
                    </AppTooltip>
                  )}
                  <ProjectDeadlineStatuses deadline={dstatus} className="shrink-0" />
                </span>

                <span className="text-right font-medium tabular-nums text-foreground" aria-label={`${tpct}% translated`}>
                  {tpct}%
                </span>
                <span className="text-right tabular-nums text-muted-foreground" aria-label={`${pct}% validated`}>
                  {pct}%
                </span>
                <span className="hidden text-right tabular-nums text-muted-foreground @xl/project-table:block" aria-label={`${apct}% audio`}>
                  {apct}%
                </span>
                <span className="hidden truncate text-right text-xs text-muted-foreground @2xl/project-table:block">
                  {role?.name ? <RoleLabel name={role.name} /> : "—"}
                </span>
                <span
                  className={`hidden truncate text-right text-xs @3xl/project-table:block ${
                    status === "stalled" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                  }`}
                >
                  {status === "not-started"
                    ? "Not started"
                    : status === "stalled"
                      ? "Stalled"
                      : formatShortDate(p.lastEditAt)}
                </span>
              </Link>
            )
          })}
        </div>
        </div>
      </div>
    </TooltipDelegationBoundary>
  )
}

/**
 * AQU-335 / AQU-475: projects reachable only via a project-level grant (an
 * invite accept or bulk-add) into an org the caller isn't a member of.
 * Shared across both the active-org and all-orgs views so a zero-org guest
 * never lands on an empty dashboard. `orgLabel` annotates each row with the
 * host org — AQU-473: the accessible-projects endpoint now joins `orgName`,
 * so the label falls back to "Org #N" only on older servers/absent data.
 */
function SharedWithYouSection({
  projects,
  orgLabel,
}: {
  projects: CloudProjectSummary[]
  orgLabel?: (project: CloudProjectSummary) => string | null
}) {
  if (projects.length === 0) return null
  return (
    <section data-testid="shared-with-you" className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">Shared with you</h2>
      <div className="rounded-2xl border divide-y">
        {projects.map((p) => {
          const label = orgLabel?.(p) ?? null
          return (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              className="flex items-center gap-4 p-4 hover:bg-muted/50 transition-colors"
            >
              <p className="flex-1 min-w-0 truncate font-medium">{p.name}</p>
              {label && (
                <Badge variant="secondary" className="shrink-0 truncate">
                  {label}
                </Badge>
              )}
              <RoleLabel name={p.role.name} className="shrink-0 text-xs text-muted-foreground" />
            </Link>
          )
        })}
      </div>
    </section>
  )
}

export function OrgHome() {
  const { activeOrg, activeOrgId, isAllOrgs, orgs, isLoading: orgLoading, setActiveOrg } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const navigate = useNavigate()
  const jwt = session?.jwt ?? null

  // AQU-486: per-section visibility chrome for Team workload / Team usage
  // (both gated by the AQU-485 memberProgressViewMinRole floor — they're both
  // per-member productivity views) and the credits panel (a static
  // maintainer-only floor hardcoded in CreditsPanel; no org-setting backs it
  // yet, so its badge is informational only, with no advanced toggle).
  const orgSettings = useOrgSettings(activeOrgId, activeOrg?.role?.level)
  const canEditVisibility = canEditRosterProgressFloor(activeOrg?.role?.level)
  const memberProgressReady = orgSettings.hasFetched
  const memberProgressViewerRole = activeOrg?.role?.level ?? null

  const [projects, setProjects] = useState<PortfolioProjectRow[]>([])
  // AQU-335: accessible-project rows supply direct/group/org role attribution
  // and identify projects shared from orgs the portfolio endpoint can't see.
  const [accessibleProjects, setAccessibleProjects] = useState<CloudProjectSummary[]>([])
  // AQU-326: unredeemed invites addressed to the caller's email — without
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

  // AQU-335: surface cross-org grants on the Projects page too — otherwise a user
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

  // AQU-326: received-invites surface. Org-independent (matched by email).
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
  // AQU-475: in all-orgs mode there's no single activeOrgId to compare
  // against — classify by org membership alone so a project reached purely
  // via a project-level grant (zero orgs, or a grant in an org the caller
  // doesn't belong to) still surfaces instead of vanishing into an empty
  // dashboard.
  const sharedProjects = partitionSharedProjects(
    accessibleProjects,
    orgs,
    activeOrgId,
    isAllOrgs ? "all-orgs" : "active-org",
  ).sharedWithMe
  const roleByProjectId = new Map(accessibleProjects.map((project) => [project.id, project.role]))

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

  const statusFilteredProjects = projects.filter((p) => {
    switch (statusFilter) {
      case "stalled":
        return activityStatus(p, now) === "stalled"
      case "overdue":
        return deadlineStatus(p, now) === "overdue"
      default:
        return true
    }
  })

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={
        <div className="flex items-center justify-between pr-4">
          <OrgBreadcrumb section="Projects" />
          {activeOrgId != null ? (
            <ProjectCreateDialog orgId={activeOrgId} onCreated={handleCreated} />
          ) : (
            <Badge variant="outline">Select an organization to create a project</Badge>
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
              {/* AQU-326: received invites — the user has been invited but
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
                            Invited by {inv.createdBy} as <RoleLabel name={inv.role.name} />
                            {inv.expiresAt ? ` · expires ${new Date(inv.expiresAt).toLocaleDateString()}` : ""}
                          </p>
                        </div>
                        <Link
                          to={`/join/${inv.token}`}
                          className={cn(buttonVariants({ size: "sm" }), "shrink-0")}
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
                    <section data-testid="organizations-panel" className="rounded-2xl border bg-card">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                        <div>
                          <h2 className="text-base font-semibold">Organizations</h2>
                          <p className="text-xs text-muted-foreground">
                            {visibleOrgSummaries.length} of {orgSummaries.length}
                          </p>
                        </div>
                        {orgSummaries.length > 0 && (
                          <InputGroup className="h-9 w-full sm:w-56">
                            <InputGroupAddon>
                              <Search />
                            </InputGroupAddon>
                            <InputGroupInput
                              type="search"
                              value={orgQuery}
                              onChange={(e) => setOrgQuery(e.target.value)}
                              placeholder="Filter organizations…"
                              aria-label="Filter organizations by name"
                            />
                          </InputGroup>
                        )}
                      </div>

                      {orgSummaries.length === 0 ? (
                        <EmptyState
                          variant="inline"
                          className="py-10"
                          icon={Building2}
                          title="No organizations yet."
                        />
                      ) : visibleOrgSummaries.length === 0 ? (
                        <EmptyState
                          variant="inline"
                          className="py-10"
                          icon={Search}
                          title="No matching organizations."
                        />
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
                                  <Badge variant="secondary" className="shrink-0">
                                    {roleLabel(summary.org)}
                                  </Badge>
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

                    <section data-testid="projects-panel" className="rounded-2xl border bg-card">
                      <div className="space-y-3 border-b px-4 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h2 className="text-base font-semibold">Projects</h2>
                            <p className="text-xs text-muted-foreground">{currentProjectLens.description}</p>
                          </div>
                        </div>
                        <div className="flex w-full flex-nowrap items-center gap-2 overflow-x-auto overflow-y-hidden">
                          <InputGroup className="h-9 min-w-[12rem] flex-[1_1_13rem] max-w-52">
                            <InputGroupAddon>
                              <Search />
                            </InputGroupAddon>
                            <InputGroupInput
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
                            />
                            {projectQuery && (
                              <InputGroupAddon align="inline-end">
                                <InputGroupButton
                                  type="button"
                                  size="icon-xs"
                                  aria-label="Clear project filter"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => setProjectQuery("")}
                                >
                                  <X />
                                </InputGroupButton>
                              </InputGroupAddon>
                            )}
                          </InputGroup>
                          <div className={projectControlGroupClassName}>
                            <div className="flex items-center gap-2" aria-label="Project status filter">
                              <span className="text-xs font-medium text-muted-foreground">Status</span>
                              <div className="flex items-center gap-1">
                                {STATUS_FILTERS.map((f) => (
                                  <Button
                                    key={f.value}
                                    type="button"
                                    size="xs"
                                    variant={statusFilter === f.value ? "default" : "secondary"}
                                    onClick={() => setStatusFilter(f.value)}
                                    aria-pressed={statusFilter === f.value}
                                  >
                                    {f.label}
                                  </Button>
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
                        <EmptyState
                          variant="inline"
                          className="py-10"
                          icon={FolderPlus}
                          title="No projects yet."
                        />
                      ) : visible.length === 0 ? (
                        <EmptyState
                          variant="inline"
                          className="py-10"
                          icon={Search}
                          title={projectQuery ? "No matching projects." : currentProjectLens.empty}
                        />
                      ) : (
                        <ProjectTable projects={visible} now={now} showOrg roleByProjectId={roleByProjectId} />
                      )}
                    </section>
                  </div>

                  {/* AQU-475: projects reachable only via a project-level grant
                      (no org membership at all, or a grant in an org the caller
                      isn't a member of) are invisible to getPortfolios() — which
                      only knows about the caller's org memberships. Without this,
                      a zero-org guest sees a fully empty all-orgs dashboard. */}
                  <SharedWithYouSection
                    projects={sharedProjects}
                    orgLabel={(p) => p.orgName ?? (p.orgId != null ? `Org #${p.orgId}` : null)}
                  />
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

                  {/* Status filter + admin-style project table */}
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
                  ) : (
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-wrap items-center gap-1" aria-label="Project status filter">
                        {STATUS_FILTERS.map((f) => (
                          <Button
                            key={f.value}
                            type="button"
                            size="xs"
                            variant={statusFilter === f.value ? "default" : "secondary"}
                            onClick={() => setStatusFilter(f.value)}
                            aria-pressed={statusFilter === f.value}
                          >
                            {f.label}
                          </Button>
                        ))}
                      </div>

                      <OrgProjectsDataTable
                        projects={statusFilteredProjects}
                        now={now}
                        roleByProjectId={roleByProjectId}
                        initialLens={projectLens}
                        emptyTitle={
                          statusFilter === "stalled"
                            ? "No stalled projects."
                            : statusFilter === "overdue"
                              ? "No overdue projects."
                              : "No projects yet."
                        }
                      />
                    </div>
                  )}

                  {/* AQU-335: cross-org projects (invite-link / bulk-add grants).
                      Listed separately — they're not part of this org's portfolio,
                      but hiding them made them unreachable from every nav surface. */}
                  <SharedWithYouSection projects={sharedProjects} />
                </>
              )}

              {jwt && !isAllOrgs && activeOrgId != null && (
                <SectionVisibilityGate
                  minRole={orgSettings.memberProgressViewMinRole}
                  viewerRoleLevel={memberProgressViewerRole}
                  ready={memberProgressReady}
                >
                  <div
                    className={cn(
                      "relative rounded-2xl",
                      sectionTintClass(orgSettings.memberProgressViewMinRole),
                    )}
                    data-testid="section-team-workload"
                  >
                    <SectionVisibilityBadge
                      minRole={orgSettings.memberProgressViewMinRole}
                      canEdit={canEditVisibility}
                      onChangeMinRole={async (next) => { await orgSettings.patch({ memberProgressViewMinRole: next }) }}
                      description="Who can see each teammate's assignment progress on this org's overview."
                      className="absolute right-4 top-4 z-10"
                    />
                    <WorkloadRollup jwt={jwt} orgId={activeOrgId} />
                  </div>
                </SectionVisibilityGate>
              )}
              {jwt && !isAllOrgs && activeOrgId != null && (
                <SectionVisibilityGate
                  minRole={orgSettings.memberProgressViewMinRole}
                  viewerRoleLevel={memberProgressViewerRole}
                  ready={memberProgressReady}
                >
                  <div
                    className={cn(
                      "relative rounded-2xl",
                      sectionTintClass(orgSettings.memberProgressViewMinRole),
                    )}
                    data-testid="section-team-usage"
                  >
                    <SectionVisibilityBadge
                      minRole={orgSettings.memberProgressViewMinRole}
                      canEdit={canEditVisibility}
                      onChangeMinRole={async (next) => { await orgSettings.patch({ memberProgressViewMinRole: next }) }}
                      description="Who can see each teammate's usage on this org's overview."
                      className="absolute right-4 top-4 z-10"
                    />
                    <UsageRollup jwt={jwt} orgId={activeOrgId} />
                  </div>
                </SectionVisibilityGate>
              )}
              {jwt && !isAllOrgs && activeOrgId != null && (
                <SectionVisibilityGate minRole={ROLE.MAINTAINER} viewerRoleLevel={activeOrg?.role?.level ?? null}>
                  <div
                    className={cn("relative rounded-2xl", sectionTintClass(ROLE.MAINTAINER))}
                    data-testid="section-credits"
                  >
                    <SectionVisibilityBadge minRole={ROLE.MAINTAINER} className="absolute right-4 top-4 z-10" />
                    <CreditsPanel
                      jwt={jwt}
                      orgId={activeOrgId}
                      orgRoleLevel={activeOrg?.role.level ?? 0}
                    />
                  </div>
                </SectionVisibilityGate>
              )}
            </div>
          )}
        </Page>
      }
    />
  )
}
