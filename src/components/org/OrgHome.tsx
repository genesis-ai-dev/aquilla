import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { AppShell } from "@/components/AppShell"
import { LoadingOverlay } from "@/components/ui/loading-overlay"
import { Skeleton } from "@/components/ui/skeleton"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { orgHomePath } from "@/lib/navigation/org-paths"
import type { OrgSummary } from "@/lib/frontier/orgs"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getPortfolios, translatedPct, validatedPct, attentionRank, audioPct, deadlineStatus, languagePairLabel, type PortfolioProject } from "@/lib/frontier/portfolio"
import { portfolioActivityStatus, portfolioAttentionReasons } from "@/lib/project-status"
import { ProjectDeadlineStatuses, deadlineStatusTooltip } from "@/components/ProjectStatus"
import { listMyPendingInvites, type MyPendingInvite } from "@/lib/sync/invites"
import { roleDisplayText } from "@/lib/frontier/roles"
import { RoleLabel } from "@/components/RoleLabel"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"
import { LaneChips } from "./LaneChips"
import { ProjectMetricHeader } from "./ProjectMetricHeader"
import { displayLanes } from "./project-lanes"
import { ProjectStatusFilter } from "./ProjectStatusFilter"
import { OrgProjectsDataTable } from "./OrgProjectsDataTable"
import type { StatusFilter } from "@/hooks/useOrgPortfolio"
import { buttonVariants } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Page, PageHeader, Section, StatTile, EmptyState } from "@/components/ui/page"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { OrgWithAvatar } from "@/components/OrgWithAvatar"
import {
  ADMIN_TABLE_CLASS,
  ADMIN_TABLE_SECTION_CONTENT,
  ADMIN_TABLE_SECTION_HEADER,
} from "@/components/admin/shared"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { FolderPlus, Search, Building2, Sparkles, CircleCheck, Mic } from "lucide-react"

const PANEL_MAX_H =
  "max-h-[clamp(14rem,calc(100dvh-22rem),28rem)]"

function DashboardRowTemplate() {
  return (
    <div className="flex items-center gap-4 px-2 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
      <Skeleton className="h-4 w-16 shrink-0" />
    </div>
  )
}

function DashboardPanelTemplate({ rows }: { rows: number }) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-0">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-3 w-40" />
        </div>
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="space-y-1 px-5 pt-2 pb-3">
        {Array.from({ length: rows }).map((_, index) => (
          <DashboardRowTemplate key={index} />
        ))}
      </div>
    </section>
  )
}

/**
 * A stable, value-free preview of the dashboard's eventual geometry. This
 * never reads partially hydrated org/project state, so startup has exactly one
 * visual transition: template → resolved dashboard.
 */
function OrgHomeLoadingTemplate() {
  return (
    <div data-testid="org-home-loading-template" className="h-full">
      <AppShell
        sidebar={
          <div className="flex h-full flex-col gap-4 p-2">
            <Skeleton className="h-9 w-full" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-3/4" />
              <Skeleton className="h-8 w-2/3" />
            </div>
            <div className="mt-auto flex flex-col gap-2">
              <Skeleton className="h-8 w-4/5" />
              <Skeleton className="h-10 w-full" />
            </div>
          </div>
        }
        header={
          <div className="flex items-center justify-between gap-4 px-4">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-7 w-56 rounded-lg" />
          </div>
        }
        statusBar={null}
        main={
          <Page size="wide">
            <Skeleton className="mb-8 h-7 w-48" />
            <div className="flex flex-col gap-6">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div
                    key={index}
                    className="flex h-[88px] flex-col gap-2 rounded-lg border bg-card px-5 py-4"
                  >
                    <Skeleton className="h-6 w-12" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-6">
                <DashboardPanelTemplate rows={4} />
                <DashboardPanelTemplate rows={3} />
              </div>
            </div>
          </Page>
        }
      />
    </div>
  )
}


type ActivityStatus = "not-started" | "stalled" | "active"

/** @deprecated Import portfolioActivityStatus from @/lib/project-status */
export function activityStatus(p: PortfolioProject, now: number): ActivityStatus {
  return portfolioActivityStatus(p, now)
}

type ProjectLens = "recent" | "attention" | "least-translated" | "most-progress" | "name" | "pm"

const PROJECT_LENS_STORAGE_KEY = "org:all-projects:view"

function ProjectTableName({ name }: { name: string }) {
  const nameRef = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)

  useLayoutEffect(() => {
    const element = nameRef.current
    if (!element) return

    const measure = () => {
      setTruncated(element.scrollWidth > element.clientWidth + 1)
    }

    measure()
    if (typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [name])

  return (
    <span
      className={cn(
        "relative min-w-0 flex-1",
        truncated && "group/name z-30 hover:z-50",
      )}
      data-project-name-truncated={truncated ? "true" : "false"}
    >
      <span
        ref={nameRef}
        data-testid="project-table-name"
        className="block min-w-0 overflow-hidden whitespace-nowrap text-clip font-medium"
      >
        {name}
      </span>
      {truncated && (
        <span
          aria-hidden="true"
          data-testid="project-table-name-expanded"
          className="pointer-events-none absolute top-1/2 -left-2 z-50 -translate-y-1/2 whitespace-nowrap rounded-md bg-popover px-2 py-1 font-medium text-popover-foreground opacity-0 shadow-md ring-1 ring-border/60 transition-opacity duration-100 group-hover/name:opacity-100"
        >
          {name}
        </span>
      )}
    </span>
  )
}
const PROJECT_LENS_VALUES: ProjectLens[] = ["recent", "attention", "least-translated", "most-progress", "name", "pm"]

export type PortfolioProjectRow = PortfolioProject & {
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

export function readProjectLens(): ProjectLens {
  try {
    const stored = localStorage.getItem(PROJECT_LENS_STORAGE_KEY)
    return PROJECT_LENS_VALUES.includes(stored as ProjectLens) ? stored as ProjectLens : "recent"
  } catch {
    return "recent"
  }
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

const ORG_SUMMARY_COLUMNS: ColumnDef<OrgPortfolioSummary>[] = [
  {
    id: "organization",
    accessorFn: (s) => orgDisplayName(s.org).toLowerCase(),
    header: ({ column }) => <DataTableColumnHeader column={column} title="Organization" />,
    meta: { className: "min-w-0" },
    cell: ({ row }) => (
      <OrgWithAvatar name={orgDisplayName(row.original.org)} size="xs" className="max-w-full" />
    ),
  },
  {
    id: "role",
    accessorFn: (s) => roleLabel(s.org).toLowerCase(),
    header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
    meta: { className: "w-[8.5rem] whitespace-nowrap" },
    cell: ({ row }) => (
      <span className="text-sm text-foreground">{roleLabel(row.original.org)}</span>
    ),
  },
  {
    id: "projects",
    accessorFn: (s) => s.projectCount,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Projects" className="justify-end" />
    ),
    meta: { align: "right", className: "w-[5.5rem]" },
    cell: ({ row }) => (
      <div className="text-right tabular-nums">{row.original.projectCount}</div>
    ),
  },
]

function deadlineTooltip(project: PortfolioProjectRow, status: "overdue" | "soon") {
  return deadlineStatusTooltip(status, project.deadlineAt)
}

export function sortProjectsByLens(projects: PortfolioProjectRow[], lens: ProjectLens, now: number): PortfolioProjectRow[] {
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
      case "pm": {
        // AQU-507: group by PM username; unassigned projects sort *last* (they
        // are noise for someone scanning by who's responsible), then by name.
        const an = a.pm?.username ?? null
        const bn = b.pm?.username ?? null
        if (an && bn) return an.localeCompare(bn) || a.name.localeCompare(b.name)
        if (an) return -1
        if (bn) return 1
        return a.name.localeCompare(b.name)
      }
      case "attention":
        return attentionRank(b, now) - attentionRank(a, now) || a.name.localeCompare(b.name)
    }
  })
}

// Keep the decision-making columns stable at normal project-panel widths.
// Organization remains secondary information inside the identity cell, while
// activity remains available through filtering/sorting instead of consuming a
// column or adding a third line to every row.
// Compact panels retain identity + the two core text metrics; Languages and
// Has Audio appear together once the container can support the full table.
const PROJECT_TABLE_COLS = [
  "grid-cols-[minmax(10rem,2fr)_repeat(2,minmax(3.5rem,0.65fr))]",
  "@md/project-table:grid-cols-[minmax(0,1fr)_minmax(6rem,7.5rem)_repeat(3,2.25rem)]",
].join(" ")

const PROJECT_IDENTITY_COLS =
  "@md/project-table:grid-cols-[minmax(6.5rem,1fr)_minmax(4rem,6rem)]"

/**
 * The org/portfolio project list as a compact table — one row per project with
 * aligned Languages / Translated / Validated / Has Audio columns — instead of a
 * stack of full-width progress-bar cards. Rows stay `<Link>`s so cmd-click
 * still opens a project in a new tab. Deadline context stays with identity;
 * activity remains available through the status filter and sort menu.
 *
 * The compact metric headings use familiar icons, accessible labels, and
 * immediate hover/focus tooltips. Their grid cells and values share the same
 * left edge, keeping percentages easy to scan without spending table width on
 * repeated heading text.
 */
export function ProjectTable({
  projects,
  now,
  showOrg,
  defaultLaneLabelByProjectId,
}: {
  projects: PortfolioProjectRow[]
  now: number
  showOrg: boolean
  defaultLaneLabelByProjectId?: Map<string, string>
}) {
  return (
    <div data-testid="project-table" className="@container/project-table -mx-2 overflow-hidden">
      <div className="w-full">
        <div
          className={`sticky top-0 z-20 grid ${PROJECT_TABLE_COLS} items-center gap-x-2 border-b bg-muted/95 py-2 pr-2 pl-2 text-xs font-medium text-muted-foreground backdrop-blur-sm`}
        >
          <span
            className={cn(
              "min-w-0",
              showOrg && `@md/project-table:grid ${PROJECT_IDENTITY_COLS} @md/project-table:gap-x-2`,
            )}
          >
            <span>Project</span>
            {showOrg && <span className="hidden text-left @md/project-table:block">Org</span>}
          </span>
          {/* AQU-538: lane chips column (see the LaneChips cell in each row). */}
          <span className="hidden @md/project-table:block">Language</span>
          <ProjectMetricHeader
            label="Translated"
            description="Translated: percentage of cells with target-language content filled in."
            icon={Sparkles}
            testId="project-table-translated-header"
          />
          <ProjectMetricHeader
            label="Validated"
            description="Validated: percentage of cells marked validated by a reviewer."
            icon={CircleCheck}
            testId="project-table-validated-header"
          />
          <ProjectMetricHeader
            label="Has audio"
            description="Audio: percentage of cells with at least one recording attached."
            icon={Mic}
            testId="project-table-audio-header"
            className="hidden @md/project-table:inline-flex"
          />
        </div>
        <div className="divide-y">
          {projects.map((p) => {
            const tpct = Math.round(translatedPct(p) * 100)
            const pct = Math.round(validatedPct(p) * 100)
            const apct = Math.round(audioPct(p) * 100)
            const dstatus = deadlineStatus(p, now)
            return (
              <Link
                key={p.id}
                to={`/projects/${p.id}`}
                data-project-id={p.id}
                className={`grid ${PROJECT_TABLE_COLS} items-center gap-x-2 overflow-hidden rounded-lg py-2 pr-2 pl-2 text-sm transition-colors hover:bg-muted/50`}
              >
                <span
                  data-testid="project-table-identity"
                  className={cn(
                    "min-w-0",
                    showOrg && p.orgName
                      ? `@md/project-table:grid ${PROJECT_IDENTITY_COLS} @md/project-table:items-start @md/project-table:gap-x-2`
                      : "flex items-start",
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ProjectTableName name={p.name} />
                      {(dstatus === "overdue" || dstatus === "soon") && (
                        <AppTooltip
                          content={deadlineTooltip(p, dstatus)}
                          side="bottom"
                        >
                          <span
                            tabIndex={0}
                            data-testid="project-table-deadline-trigger"
                            className="shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          >
                            <ProjectDeadlineStatuses
                              deadline={dstatus}
                              className="[&>span:last-child]:sr-only"
                              testId="project-table-deadline-status"
                            />
                          </span>
                        </AppTooltip>
                      )}
                    </span>
                    {/* AQU-523: source → target language pair beneath the name, so
                        the org / all-orgs list shows it at a glance (matching the
                        single-project overview). Rendered only when known. */}
                    {languagePairLabel(p) && (
                      <span
                        data-testid="project-table-metadata"
                        className="flex min-w-0 items-center text-xs leading-4 text-muted-foreground"
                      >
                        <span className="truncate" aria-label="Source and target language">
                          {languagePairLabel(p)}
                        </span>
                      </span>
                    )}
                  </span>
                  {showOrg && p.orgName && (
                    <span className="hidden min-w-0 items-center justify-start @md/project-table:flex">
                      <span
                        data-testid="project-table-organization"
                        data-org-name={p.orgName}
                        className="group/org relative inline-flex h-5 w-full min-w-0 justify-self-start"
                      >
                        <Badge
                          variant="secondary"
                          className="absolute top-0 left-0 z-10 min-w-0 max-w-full justify-start overflow-hidden transition-[max-width,box-shadow] duration-150 group-hover/org:max-w-80 group-hover/org:shadow-sm"
                        >
                          <span className="min-w-0 flex-1 truncate group-hover/org:overflow-visible group-hover/org:whitespace-nowrap">
                            {p.orgName}
                          </span>
                        </Badge>
                      </span>
                    </span>
                  )}
                </span>

                <span
                  data-testid="project-table-languages"
                  className="hidden min-w-0 items-center overflow-hidden @md/project-table:flex"
                >
                  <LaneChips
                    projectId={p.id}
                    lanes={displayLanes(p)}
                    defaultLaneLabel={defaultLaneLabelByProjectId?.get(p.id) ?? ""}
                    maxVisible={2}
                    className="w-full"
                  />
                </span>

                <span
                  data-testid="project-table-translated-value"
                  className="justify-self-start text-left font-medium tabular-nums text-foreground"
                  aria-label={`${tpct}% translated`}
                >
                  {tpct}%
                </span>
                <span
                  data-testid="project-table-validated-value"
                  className="justify-self-start text-left tabular-nums text-muted-foreground"
                  aria-label={`${pct}% validated`}
                >
                  {pct}%
                </span>
                <span
                  data-testid="project-table-audio-value"
                  className="hidden justify-self-start text-left tabular-nums text-muted-foreground @md/project-table:block"
                  aria-label={`${apct}% audio`}
                >
                  {apct}%
                </span>
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function OrgHome() {
  const {
    orgs,
    accessibleProjectsLoading,
    isLoading: orgLoading,
    setActiveOrg,
  } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const navigate = useNavigate()
  const jwt = session?.jwt ?? null
  const portfolioScopeKey = !jwt || orgLoading
    ? null
    : `all:${orgs.map((org) => org.id).sort((a, b) => a - b).join(",")}`

  const [projects, setProjects] = useState<PortfolioProjectRow[]>([])
  // AQU-326: unredeemed invites addressed to the caller's email — without
  // this card, an invite whose link never arrived is undiscoverable in-app.
  const [pendingInvites, setPendingInvites] = useState<MyPendingInvite[]>([])
  // The key records which dashboard scope has actually resolved. Deriving the
  // first-load state from it prevents a post-render effect from painting an
  // empty portfolio as real data before its request has even started.
  const [resolvedPortfolioScopeKey, setResolvedPortfolioScopeKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const projectLens = readProjectLens()

  useEffect(() => {
    if (!jwt) {
      setProjects([])
      setResolvedPortfolioScopeKey(null)
      return
    }
    if (orgLoading) return
    if (orgs.length === 0) {
      setError(null)
      setProjects([])
      setResolvedPortfolioScopeKey(portfolioScopeKey)
      return
    }
    let cancelled = false
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
        if (!cancelled) setResolvedPortfolioScopeKey(portfolioScopeKey)
      })
    return () => { cancelled = true }
  }, [jwt, orgLoading, orgs, portfolioScopeKey])

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
        header={<OrgBreadcrumb section="Overview" />}
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

  const isPageLoading = sessionLoading
    || orgLoading
    || accessibleProjectsLoading
    || (portfolioScopeKey != null && resolvedPortfolioScopeKey !== portfolioScopeKey)
  const workspaceLabel = "All organizations"

  // Keep cold-start data atomic while preserving the destination's geometry.
  // The template is intentionally disconnected from partial org/project state:
  // unknown values remain skeletons and startup has one visual transition.
  if (isPageLoading) {
    return (
      <LoadingOverlay label="Loading dashboard" data-testid="org-home-loading">
        <OrgHomeLoadingTemplate />
      </LoadingOverlay>
    )
  }

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
  const attentionCount = projects.filter((p) => portfolioAttentionReasons(p, now).length > 0).length

  // AQU-507: the portfolio feed (which backs these rows) has no PM dimension;
  // merge it in from the accessible-projects feed when available — here we rely
  // only on portfolio rows (all-orgs table).
  const projectsWithPm: PortfolioProjectRow[] = projects
  // AQU-538 §3.2: the '' (default) lane chip is labeled with the project's
  // target language — portfolio alone doesn't join file languages; empty map
  // falls back to generic "Default" labels.
  const defaultLaneLabelByProjectId = new Map<string, string>()

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

  function openOrg(orgId: number) {
    setActiveOrg(orgId)
    navigate(orgHomePath(orgId))
  }

  // Filter bar — narrows the listed projects only; the rollup strip above
  // continues to reflect the full portfolio. Search/sort live in the DataTable.
  const filteredProjects = projectsWithPm.filter((p) => {
    switch (statusFilter) {
      case "stalled":
        return activityStatus(p, now) === "stalled"
      case "attention":
        return portfolioAttentionReasons(p, now).length > 0
      case "overdue":
        return deadlineStatus(p, now) === "overdue"
      default:
        return true
    }
  })

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Overview" />}
      statusBar={null}
      main={
        <Page size="wide">
          <PageHeader title={workspaceLabel} inset={false} />
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <div className="space-y-6">
              {/* AQU-326: received invites — the user has been invited but
                  hasn't accepted yet. Without this, an invite whose email/link
                  never arrived is undiscoverable in-app. */}
              {pendingInvites.length > 0 && (
                <Section
                  data-testid="pending-invitations"
                  title="Pending invitations"
                  description="Invites sent to your email that you have not accepted yet."
                  headerClassName={ADMIN_TABLE_SECTION_HEADER}
                  contentClassName={ADMIN_TABLE_SECTION_CONTENT}
                >
                  <div className="divide-y">
                    {pendingInvites.map((inv) => (
                      <div key={inv.token} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                        <div className="min-w-0 flex-1">
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
                          className={cn(buttonVariants(), "shrink-0")}
                        >
                          Review &amp; accept
                        </Link>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

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
                  className={attentionCount > 0 ? "border-amber-500/40" : undefined}
                />
              </div>

              <div className="flex flex-col gap-6">
                <Section
                  data-testid="projects-panel"
                  title="Projects"
                  description="Projects across every organization you belong to."
                  headerClassName={cn(ADMIN_TABLE_SECTION_HEADER, "shrink-0")}
                  contentClassName={cn(
                    ADMIN_TABLE_SECTION_CONTENT,
                    "@container/projects-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
                  )}
                  className={cn("flex min-w-0 flex-col overflow-hidden", PANEL_MAX_H)}
                >
                  {projects.length === 0 ? (
                    <EmptyState
                      variant="inline"
                      className="py-6"
                      icon={FolderPlus}
                      title="No projects yet"
                    />
                  ) : (
                    <div
                      data-testid="projects-scroll"
                      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                    >
                      <OrgProjectsDataTable
                        projects={filteredProjects}
                        now={now}
                        showOrg
                        layout="embedded"
                        testId="project-table"
                        defaultLaneLabelByProjectId={defaultLaneLabelByProjectId}
                        initialLens={statusFilter === "attention" ? "attention" : projectLens}
                        toolbarLeading={
                          <ProjectStatusFilter
                            value={statusFilter}
                            onValueChange={setStatusFilter}
                            className="bg-background"
                          />
                        }
                        emptyTitle={
                          statusFilter === "stalled"
                            ? "No stalled projects."
                            : statusFilter === "attention"
                              ? "No projects need attention."
                              : statusFilter === "overdue"
                                ? "No overdue projects."
                                : "No projects yet."
                        }
                      />
                    </div>
                  )}
                </Section>

                <Section
                  data-testid="organizations-panel"
                  title="Organizations"
                  description="Workspaces you belong to across Aquilla."
                  headerClassName={cn(ADMIN_TABLE_SECTION_HEADER, "shrink-0")}
                  contentClassName={cn(
                    ADMIN_TABLE_SECTION_CONTENT,
                    "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
                  )}
                  className={cn("flex min-w-0 flex-col overflow-hidden", PANEL_MAX_H)}
                >
                  <div
                    data-testid="organizations-scroll"
                    className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain"
                  >
                    {orgSummaries.length === 0 ? (
                      <EmptyState
                        variant="inline"
                        className="py-6"
                        icon={Building2}
                        title="No organizations yet"
                      />
                    ) : (
                      <DataTable
                        columns={ORG_SUMMARY_COLUMNS}
                        data={orgSummaries}
                        getRowId={(s) => String(s.org.id)}
                        onRowClick={(s) => openOrg(s.org.id)}
                        initialSorting={[{ id: "organization", desc: false }]}
                        searchPlaceholder="Filter organizations…"
                        globalFilterFn={(row, _columnId, filterValue) => {
                          const q = String(filterValue).trim().toLowerCase()
                          if (!q) return true
                          return orgDisplayName(row.original.org).toLowerCase().includes(q)
                        }}
                        testId="all-orgs-organizations-table"
                        className={cn(
                          ADMIN_TABLE_CLASS,
                          // No -mx-2 bleed here: it widens past the card and
                          // creates a horizontal scrollbar on the scrollport.
                          "mx-0 overflow-x-hidden [&_[data-slot=table-container]]:overflow-x-hidden",
                        )}
                        dense
                        emptyState={
                          <EmptyState
                            variant="inline"
                            className="py-6"
                            icon={Search}
                            title="No matching organizations"
                          />
                        }
                      />
                    )}
                  </div>
                </Section>
              </div>
            </div>
          )}
        </Page>
      }
    />
  )
}
