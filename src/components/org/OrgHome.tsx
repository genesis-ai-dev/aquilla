import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { LoadingOverlay } from "@/components/ui/loading-overlay"
import { Skeleton } from "@/components/ui/skeleton"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { membersPath, orgHomePath } from "@/lib/navigation/org-paths"
import type { OrgSummary } from "@/lib/frontier/orgs"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getPortfolio, getPortfolios, translatedPct, validatedPct, attentionRank, audioPct, deadlineStatus, languagePairLabel, type PortfolioProject } from "@/lib/frontier/portfolio"
import { portfolioActivityStatus, portfolioAttentionReasons } from "@/lib/project-status"
import { ProjectDeadlineStatuses } from "@/components/ProjectStatus"
import { listMyPendingInvites, type MyPendingInvite } from "@/lib/sync/invites"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatDate, formatList } from "@/lib/i18n/format"
import { WorkloadRollup } from "./WorkloadRollup"
import { UsageRollup } from "./UsageRollup"
import { CreditsPanel } from "./CreditsPanel"
import {
  SectionVisibilityBadge,
  SectionVisibilityGate,
  sectionTintClass,
} from "./SectionVisibilityBadge"
import { useOrgSettings, canEditRosterProgressFloor } from "@/hooks/useOrgSettings"
import { ROLE, resolveRoleName } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { RoleLabel } from "@/components/RoleLabel"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"
import { ProjectCreateDialog } from "@/components/ProjectCreateDialog"
import { OrgSetupChecklist } from "./OrgSetupChecklist"
import { OrgProjectsDataTable } from "./OrgProjectsDataTable"
import { LaneChips } from "./LaneChips"
import { ProjectMetricHeader } from "./ProjectMetricHeader"
import { displayLanes, withOptimisticLane } from "./project-lanes"
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
import { SegmentTabs } from "@/components/ui/tabs"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { FolderPlus, Search, X, Building2, Sparkles, CircleCheck, Mic } from "lucide-react"

function DashboardRowTemplate() {
  return (
    <div className="flex items-center gap-4 p-4">
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
    <section className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-3 w-16" />
        </div>
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="divide-y">
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
                    className="flex h-[88px] flex-col gap-2 rounded-2xl border bg-card px-5 py-4"
                  >
                    <Skeleton className="h-6 w-12" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                ))}
              </div>
              <div className="grid items-start gap-6 lg:grid-cols-[minmax(14rem,1fr)_minmax(30rem,2fr)]">
                <DashboardPanelTemplate rows={3} />
                <DashboardPanelTemplate rows={4} />
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

type StatusFilter = "all" | "stalled" | "attention" | "overdue"

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
          className="pointer-events-none absolute top-1/2 -start-2 z-50 -translate-y-1/2 whitespace-nowrap rounded-md bg-popover px-2 py-1 font-medium text-popover-foreground opacity-0 shadow-md ring-1 ring-border/60 transition-opacity duration-100 group-hover/name:opacity-100"
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

const STATUS_FILTERS: { value: StatusFilter; labelKey: MessageKey }[] = [
  { value: "all", labelKey: "org.orgHome.statusFilter.all" },
  { value: "stalled", labelKey: "org.orgHome.stalled" },
  { value: "overdue", labelKey: "org.orgHome.overdue" },
  { value: "attention", labelKey: "autopilot.status.needsAttention" },
]

const PROJECT_LENSES: { value: ProjectLens; labelKey: MessageKey; descriptionKey: MessageKey; emptyKey: MessageKey }[] = [
  {
    value: "recent",
    labelKey: "org.orgHome.lens.recentLabel",
    descriptionKey: "org.orgHome.lens.recentDescription",
    emptyKey: "org.orgHome.lens.recentEmpty",
  },
  {
    value: "attention",
    labelKey: "autopilot.status.needsAttention",
    descriptionKey: "org.orgHome.lens.attentionDescription",
    emptyKey: "org.orgHome.lens.attentionEmpty",
  },
  {
    value: "least-translated",
    labelKey: "org.orgHome.lens.leastTranslatedLabel",
    descriptionKey: "org.orgHome.lens.leastTranslatedDescription",
    emptyKey: "org.orgHome.noProjectsYet",
  },
  {
    value: "most-progress",
    labelKey: "org.orgHome.lens.mostProgressLabel",
    descriptionKey: "org.orgHome.lens.mostProgressDescription",
    emptyKey: "org.orgHome.noProjectsYet",
  },
  {
    value: "name",
    labelKey: "common.name",
    descriptionKey: "org.orgHome.lens.nameDescription",
    emptyKey: "org.orgHome.noProjectsYet",
  },
  {
    // AQU-507: group projects by their designated Project Manager.
    value: "pm",
    labelKey: "org.orgHome.lens.pmLabel",
    descriptionKey: "org.orgHome.lens.pmDescription",
    emptyKey: "org.orgHome.noProjectsYet",
  },
]

export function readProjectLens(): ProjectLens {
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

function orgDisplayName(t: ReturnType<typeof useT>, org: OrgSummary): string {
  return org.name ?? t("org.switcher.workspaceFallback")
}

function roleLabel(t: ReturnType<typeof useT>, org: OrgSummary): string {
  return resolveRoleName(t, org.role.name)
}

function formatDeadlineDate(value: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(parsed))
}

function deadlineTooltip(t: ReturnType<typeof useT>, project: PortfolioProjectRow, status: "overdue" | "soon") {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium">{status === "overdue" ? t("org.orgHome.overdue") : t("org.orgHome.dueSoon")}</span>
      {project.deadlineAt && (
        <span className="text-muted-foreground">
          {t("org.orgHome.dueDate", { date: formatDeadlineDate(project.deadlineAt) })}
        </span>
      )}
    </span>
  )
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
  const t = useT()
  return (
    <div data-testid="project-table" className="@container/project-table overflow-hidden">
      <div className="w-full">
        <div
          className={`sticky top-0 z-20 grid ${PROJECT_TABLE_COLS} items-center gap-x-2 border-b bg-muted/95 py-2 pe-2 ps-4 text-xs font-medium text-muted-foreground backdrop-blur-sm`}
        >
          <span
            className={cn(
              "min-w-0",
              showOrg && `@md/project-table:grid ${PROJECT_IDENTITY_COLS} @md/project-table:gap-x-2`,
            )}
          >
            <span>{t("common.project")}</span>
            {showOrg && (
              <span className="hidden text-start @md/project-table:block">{t("org.orgHome.table.orgHeader")}</span>
            )}
          </span>
          {/* AQU-538: lane chips column (see the LaneChips cell in each row). */}
          <span className="hidden @md/project-table:block">{t("org.orgHome.table.languageHeader")}</span>
          <ProjectMetricHeader
            label={t("org.orgHome.table.translatedHeaderLabel")}
            description={t("org.orgHome.table.translatedHeaderDescription")}
            icon={Sparkles}
            testId="project-table-translated-header"
          />
          <ProjectMetricHeader
            label={t("org.orgHome.table.validatedHeaderLabel")}
            description={t("org.orgHome.table.validatedHeaderDescription")}
            icon={CircleCheck}
            testId="project-table-validated-header"
          />
          <ProjectMetricHeader
            label={t("org.orgHome.table.audioHeaderLabel")}
            description={t("org.orgHome.table.audioHeaderDescription")}
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
                className={`grid ${PROJECT_TABLE_COLS} items-center gap-x-2 overflow-hidden py-2 pe-2 ps-4 text-sm transition-colors hover:bg-muted/50`}
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
                          content={deadlineTooltip(t, p, dstatus)}
                          side="top"
                          delay={0}
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
                        <span className="truncate" aria-label={t("org.orgHome.table.sourceTargetLanguageAria")}>
                          {/* AQU-i18n: the lib-generated label uses a literal " → "
                              separator; wrap that glyph so it mirrors under RTL
                              instead of pointing away from the target language. */}
                          {(() => {
                            const label = languagePairLabel(p)
                            const parts = label?.split(" → ")
                            return parts?.length === 2 ? (
                              <>
                                {parts[0]} <span className="inline-block rtl:-scale-x-100">→</span> {parts[1]}
                              </>
                            ) : (
                              label
                            )
                          })()}
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
                          className="absolute top-0 start-0 z-10 min-w-0 max-w-full justify-start overflow-hidden transition-[max-width,box-shadow] duration-150 group-hover/org:max-w-80 group-hover/org:shadow-sm"
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
                  className="justify-self-start text-start font-medium tabular-nums text-foreground"
                  aria-label={t("org.orgHome.pctTranslated", { pct: tpct })}
                >
                  {tpct}%
                </span>
                <span
                  data-testid="project-table-validated-value"
                  className="justify-self-start text-start tabular-nums text-muted-foreground"
                  aria-label={t("org.orgHome.pctValidated", { pct: pct })}
                >
                  {pct}%
                </span>
                <span
                  data-testid="project-table-audio-value"
                  className="hidden justify-self-start text-start tabular-nums text-muted-foreground @md/project-table:block"
                  aria-label={t("org.orgHome.table.audioPctAria", { pct: apct })}
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
  const { locale } = useI18n()
  const t = useT()
  const {
    activeOrg,
    activeOrgId,
    isAllOrgs,
    orgs,
    accessibleProjects,
    accessibleProjectsLoading,
    isLoading: orgLoading,
    setActiveOrg,
    refreshAccessibleProjects,
  } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const navigate = useNavigate()
  const jwt = session?.jwt ?? null
  const portfolioScopeKey = !jwt || orgLoading
    ? null
    : isAllOrgs
      ? `all:${orgs.map((org) => org.id).sort((a, b) => a - b).join(",")}`
      : activeOrgId == null
        ? null
        : `org:${activeOrgId}`

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
  // AQU-326: unredeemed invites addressed to the caller's email — without
  // this card, an invite whose link never arrived is undiscoverable in-app.
  const [pendingInvites, setPendingInvites] = useState<MyPendingInvite[]>([])
  // The key records which dashboard scope has actually resolved. Deriving the
  // first-load state from it prevents a post-render effect from painting an
  // empty portfolio as real data before its request has even started.
  const [resolvedPortfolioScopeKey, setResolvedPortfolioScopeKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [projectQuery, setProjectQuery] = useState("")
  const [orgQuery, setOrgQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [projectLens, setProjectLens] = useState<ProjectLens>(readProjectLens)
  // AQU-538 §3.2: bumped after a lane action (add language / assign / staff) to
  // refetch the portfolio so per-lane rollups reflect the change.
  const [refreshTick, setRefreshTick] = useState(0)

  // AQU-605: adding a language lane updates just that project's row in place
  // (optimistic chip insert) rather than bumping refreshTick, which refetched
  // the whole portfolio and blanked the table behind a loading state. Assign /
  // staff actions still refetch (their per-lane rollups genuinely change).
  const handleLaneAdded = useCallback((projectId: string, lane: string) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? withOptimisticLane(p, lane) : p)),
    )
  }, [])

  useEffect(() => {
    if (!jwt) {
      setProjects([])
      setResolvedPortfolioScopeKey(null)
      return
    }
    if (isAllOrgs) {
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
              orgName: org.name ?? t("org.switcher.workspaceFallback"),
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
    }
    if (activeOrgId == null) {
      setError(null)
      setProjects([])
      setResolvedPortfolioScopeKey(null)
      return
    }
    let cancelled = false
    setError(null)
    getPortfolio(jwt, activeOrgId)
      .then((list) => {
        if (!cancelled) {
          setProjects(list.map((project) => ({
            ...project,
            orgId: activeOrgId,
            orgName: activeOrg?.name ?? t("org.switcher.workspaceFallback"),
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
        if (!cancelled) setResolvedPortfolioScopeKey(portfolioScopeKey)
      })
    return () => { cancelled = true }
  }, [jwt, activeOrgId, activeOrg?.name, isAllOrgs, orgLoading, orgs, portfolioScopeKey, refreshTick])

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
        header={<OrgBreadcrumb section={t("nav.projects")} isProjectsLanding />}
        statusBar={null}
        main={
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="text-lg font-medium">{t("org.orgHome.signedOut.heading")}</p>
            <p className="text-sm text-muted-foreground max-w-xs">
              {t("org.orgHome.signedOut.description")}
            </p>
            <Link
              to={`/login?next=${encodeURIComponent("/")}`}
              className={cn(buttonVariants())}
            >
              {t("auth.login.title")}
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
  const workspaceLabel = isAllOrgs ? t("org.breadcrumb.allOrganizations") : activeOrg?.name ?? t("org.switcher.workspaceFallback")

  // Keep cold-start data atomic while preserving the destination's geometry.
  // The template is intentionally disconnected from partial org/project state:
  // unknown values remain skeletons and startup has one visual transition.
  if (isPageLoading) {
    return (
      <LoadingOverlay label={t("org.orgHome.loadingDashboard")} data-testid="org-home-loading">
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
  const avgAudioPct =
    projects.length > 0 ? projects.reduce((sum, p) => sum + audioPct(p), 0) / projects.length : 0
  const roleByProjectId = new Map(accessibleProjects.map((project) => [project.id, project.role]))
  // AQU-507: the portfolio feed (which backs these rows) has no PM dimension;
  // merge it in from the accessible-projects feed (the list endpoint), keyed by
  // project id — the same join the Role column already relies on. A project not
  // in the feed keeps whatever the row already had (typically absent ⇒
  // unassigned), never crashing.
  const pmByProjectId = new Map(
    accessibleProjects.map((project) => [project.id, project.pm ?? null]),
  )
  const projectsWithPm: PortfolioProjectRow[] = projects.map((project) =>
    pmByProjectId.has(project.id)
      ? { ...project, pm: pmByProjectId.get(project.id) ?? null }
      : project,
  )
  // AQU-538 §3.2: the '' (default) lane chip is labeled with the project's
  // target language. The accessible-projects feed joins per-file language hints;
  // take the first non-empty target language as the project's default. Absent →
  // the chip falls back to a generic "Default" label (see laneChipLabel).
  const defaultLaneLabelByProjectId = new Map(
    accessibleProjects.map((project) => [
      project.id,
      project.files?.find((f) => f.targetLanguage)?.targetLanguage ?? "",
    ]),
  )
  // AQU-538 §3.2: files per project, for the lane sub-row "Assign…" (books scope).
  const filesByProjectId = new Map(
    accessibleProjects.map((project) => [
      project.id,
      (project.files ?? []).map((f) => ({ id: f.id, name: f.name })),
    ]),
  )

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
    .sort((a, b) => orgDisplayName(t, a.org).localeCompare(orgDisplayName(t, b.org)))

  const visibleOrgSummaries = orgSummaries.filter((summary) => {
    if (!orgQuery) return true
    return orgDisplayName(t, summary.org).toLowerCase().includes(orgQuery.toLowerCase())
  })

  function openOrg(orgId: number) {
    setActiveOrg(orgId)
    navigate(orgHomePath(orgId))
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
    void refreshAccessibleProjects()
    navigate(`/projects/${project.id}`)
  }

  // Project lists
  const statusFilters = STATUS_FILTERS.map((f) => ({ value: f.value, label: t(f.labelKey) }))
  const projectLenses = PROJECT_LENSES.map((lens) => ({
    value: lens.value,
    label: t(lens.labelKey),
    description: t(lens.descriptionKey),
    empty: t(lens.emptyKey),
  }))
  const currentProjectLens = projectLenses.find((lens) => lens.value === projectLens) ?? projectLenses[0]

  // Filter bar — narrows the listed projects only; the rollup strip above
  // continues to reflect the full portfolio.
  const filteredProjects = projectsWithPm.filter((p) => {
    if (projectQuery) {
      // AQU-507: the search box also matches PM username, satisfying the
      // "filter by PM" half of the AC for the all-orgs list.
      const q = projectQuery.toLowerCase()
      const haystack = `${p.name} ${p.pm?.username ?? ""}`.toLowerCase()
      if (!haystack.includes(q)) return false
    }
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
  const visible = sortProjectsByLens(
    filteredProjects,
    statusFilter === "attention" ? "attention" : projectLens,
    now,
  )

  const statusFilteredProjects = projectsWithPm.filter((p) => {
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
      header={
        <div className="flex items-center justify-between pe-4">
          <OrgBreadcrumb section={t("nav.projects")} isProjectsLanding />
          {activeOrgId != null ? (
            <ProjectCreateDialog
              orgId={activeOrgId}
              onCreated={handleCreated}
              linkableProjects={accessibleProjects}
            />
          ) : (
            <Badge variant="outline">{t("org.orgHome.selectOrgToCreateProject")}</Badge>
          )}
        </div>
      }
      statusBar={null}
      main={
        <Page size="wide">
          <PageHeader title={workspaceLabel} />
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <div className="space-y-6">
              {/* AQU-326: received invites — the user has been invited but
                  hasn't accepted yet. Without this, an invite whose email/link
                  never arrived is undiscoverable in-app. */}
              {pendingInvites.length > 0 && (
                <section data-testid="pending-invitations" className="space-y-2">
                  <h2 className="text-sm font-medium text-muted-foreground">{t("org.orgHome.pendingInvitations.heading")}</h2>
                  <div className="rounded-2xl border divide-y">
                    {pendingInvites.map((inv) => (
                      <div key={inv.token} className="flex flex-wrap items-center gap-3 p-4">
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-sm font-medium">
                            {formatList(inv.projects.map((p) => p.projectName), locale)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t("org.orgHome.pendingInvitations.invitedByAs", { username: inv.createdBy })}{" "}
                            <RoleLabel name={inv.role.name} />
                            {inv.expiresAt
                              ? ` · ${t("org.orgHome.pendingInvitations.expiresOn", { date: formatDate(inv.expiresAt, locale, {}) })}`
                              : ""}
                          </p>
                        </div>
                        <Link
                          to={`/join/${inv.token}`}
                          className={cn(buttonVariants({ size: "sm" }), "shrink-0")}
                        >
                          {t("org.orgHome.pendingInvitations.reviewAccept")}
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
                  linkableProjects={accessibleProjects}
                />
              )}

              {isAllOrgs ? (
                <>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
                    <StatTile label={t("org.orgHome.organizations")} value={orgs.length} />
                    <StatTile label={t("nav.projects")} value={projects.length} />
                    <StatTile label={t("org.orgHome.avgTranslated")} value={`${Math.round(avgTranslatedPct * 100)}%`} />
                    <StatTile label={t("org.orgHome.avgValidated")} value={`${Math.round(avgValidatedPct * 100)}%`} />
                    <StatTile label={t("org.orgHome.stalled")} value={stalledCount} />
                    <StatTile
                      label={t("org.orgHome.overdue")}
                      value={
                        <span className={overdueCount > 0 ? "text-destructive" : undefined}>
                          {overdueCount}
                        </span>
                      }
                    />
                  </div>

                  <div className="grid items-start gap-6 lg:grid-cols-[minmax(14rem,1fr)_minmax(30rem,2fr)]">
                    <section
                      data-testid="organizations-panel"
                      className="self-start overflow-hidden rounded-2xl border bg-card lg:flex lg:max-h-[clamp(16rem,calc(100dvh-24rem),42rem)] lg:flex-col xl:max-h-[clamp(20rem,calc(100dvh-18rem),42rem)]"
                    >
                      <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                        <div>
                          <h2 className="text-base font-semibold">{t("org.orgHome.organizations")}</h2>
                          <p className="text-xs text-muted-foreground">
                            {t("org.orgHome.organizationsPanel.countFraction", {
                              shown: visibleOrgSummaries.length,
                              total: orgSummaries.length,
                            })}
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
                              placeholder={t("org.orgHome.organizationsPanel.filterPlaceholder")}
                              aria-label={t("org.orgHome.organizationsPanel.filterAria")}
                            />
                          </InputGroup>
                        )}
                      </div>

                      <div
                        data-testid="organizations-scroll"
                        className="min-h-0 overscroll-contain lg:overflow-y-auto"
                      >
                        {orgSummaries.length === 0 ? (
                          <EmptyState
                            variant="inline"
                            className="py-10"
                            icon={Building2}
                            title={t("org.orgHome.organizationsPanel.noOrganizationsYet")}
                          />
                        ) : visibleOrgSummaries.length === 0 ? (
                          <EmptyState
                            variant="inline"
                            className="py-10"
                            icon={Search}
                            title={t("org.orgHome.organizationsPanel.noMatchingOrganizations")}
                          />
                        ) : (
                          <div className="divide-y">
                            {visibleOrgSummaries.map((summary) => (
                              <button
                                key={summary.org.id}
                                type="button"
                                onClick={() => openOrg(summary.org.id)}
                                className="flex w-full items-center gap-4 p-4 text-start transition-colors hover:bg-muted/50"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="truncate font-medium">{orgDisplayName(t, summary.org)}</p>
                                    <Badge variant="secondary" className="shrink-0">
                                      {roleLabel(t, summary.org)}
                                    </Badge>
                                  </div>
                                  <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                                    <span>{t("org.orgHome.organizationsPanel.projectCount", { count: summary.projectCount })}</span>
                                    <span>{t("org.orgHome.pctTranslated", { pct: Math.round(summary.avgTranslatedPct * 100) })}</span>
                                    <span>{t("org.orgHome.pctValidated", { pct: Math.round(summary.avgValidatedPct * 100) })}</span>
                                  </div>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </section>

                    <section
                      data-testid="projects-panel"
                      className="@container/projects-panel min-w-0 overflow-hidden rounded-2xl border bg-card lg:flex lg:max-h-[clamp(16rem,calc(100dvh-24rem),42rem)] lg:flex-col xl:max-h-[clamp(20rem,calc(100dvh-18rem),42rem)]"
                    >
                      <div className="shrink-0 flex flex-col gap-2 border-b px-4 py-2.5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h2 className="text-base font-semibold">{t("nav.projects")}</h2>
                            <p className="text-xs text-muted-foreground">{currentProjectLens.description}</p>
                          </div>
                        </div>
                        <div className="flex w-full flex-wrap items-center gap-2">
                          <InputGroup className="h-8 w-40 max-w-full shrink-0 transition-[width] duration-150 focus-within:w-52">
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
                              placeholder={t("org.orgHome.projectsPanel.filterPlaceholder")}
                              aria-label={t("org.orgHome.projectsPanel.filterAria")}
                              autoCorrect="off"
                              autoCapitalize="none"
                              spellCheck={false}
                            />
                            {projectQuery && (
                              <InputGroupAddon align="inline-end">
                                <InputGroupButton
                                  type="button"
                                  size="icon-xs"
                                  aria-label={t("org.orgHome.projectsPanel.clearFilterAria")}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => setProjectQuery("")}
                                >
                                  <X />
                                </InputGroupButton>
                              </InputGroupAddon>
                            )}
                          </InputGroup>
                          <div className="flex shrink-0 items-center gap-2" aria-label={t("org.orgHome.projectsPanel.statusFilterAria")}>
                            <span className="text-xs font-medium text-muted-foreground">{t("org.orgHome.projectsPanel.statusLabel")}</span>
                            <SegmentTabs
                              aria-label={t("org.orgHome.projectsPanel.statusFilterAria")}
                              value={statusFilter}
                              onValueChange={setStatusFilter}
                              options={statusFilters}
                            />
                          </div>
                          <div className="ms-auto flex shrink-0 items-center gap-2" aria-label={t("org.orgHome.projectsPanel.sortAria")}>
                            <span className="text-xs font-medium text-muted-foreground">{t("org.orgHome.projectsPanel.sortByLabel")}</span>
                            <Select
                              items={projectLenses.map((lens) => ({ value: lens.value, label: lens.label }))}
                              value={projectLens}
                              onValueChange={handleProjectLensChange}
                            >
                              <SelectTrigger aria-label={t("org.orgHome.projectsPanel.sortProjectsAria")} size="sm" className="w-40 max-w-full bg-background">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {projectLenses.map((lens) => (
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

                      <div
                        data-testid="projects-scroll"
                        className="min-h-0 overscroll-contain lg:overflow-y-auto"
                      >
                        {projects.length === 0 ? (
                          <EmptyState
                            variant="inline"
                            className="py-10"
                            icon={FolderPlus}
                            title={t("org.orgHome.noProjectsYet")}
                          />
                        ) : visible.length === 0 ? (
                          <EmptyState
                            variant="inline"
                            className="py-10"
                            icon={Search}
                            title={projectQuery ? t("org.orgHome.projectsPanel.noMatchingProjects") : currentProjectLens.empty}
                          />
                        ) : (
                          <ProjectTable
                            projects={visible}
                            now={now}
                            showOrg
                            defaultLaneLabelByProjectId={defaultLaneLabelByProjectId}
                          />
                        )}
                      </div>
                    </section>
                  </div>
                </>
              ) : (
                <>
                  {/* Rollup strip */}
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
                    <StatTile label={t("nav.projects")} value={projects.length} />
                    <StatTile label={t("org.orgHome.avgTranslated")} value={`${Math.round(avgTranslatedPct * 100)}%`} />
                    <StatTile label={t("org.orgHome.avgValidated")} value={`${Math.round(avgValidatedPct * 100)}%`} />
                    <StatTile label={t("org.orgHome.avgAudio")} value={`${Math.round(avgAudioPct * 100)}%`} />
                    <StatTile label={t("org.orgHome.stalled")} value={stalledCount} />
                    <StatTile
                      label={t("org.orgHome.overdue")}
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
                      title={t("org.orgHome.readyTitle")}
                      description={t("org.orgHome.readyDescription")}
                      action={
                        <div className="flex flex-wrap items-center justify-center gap-2">
                          {activeOrgId != null && (
                            <ProjectCreateDialog
                              orgId={activeOrgId}
                              onCreated={handleCreated}
                              linkableProjects={accessibleProjects}
                            />
                          )}
                          <Button
                            variant="outline"
                            onClick={() => activeOrgId != null && navigate(membersPath(activeOrgId))}
                          >
                            {t("org.orgHome.inviteYourTeam")}
                          </Button>
                        </div>
                      }
                    />
                  ) : (
                      <div className="flex flex-col gap-3">
                      <SegmentTabs
                        aria-label={t("org.orgHome.projectsPanel.statusFilterAria")}
                        value={statusFilter}
                        onValueChange={setStatusFilter}
                        options={statusFilters}
                      />

                      <OrgProjectsDataTable
                        projects={statusFilteredProjects}
                        now={now}
                        roleByProjectId={roleByProjectId}
                        defaultLaneLabelByProjectId={defaultLaneLabelByProjectId}
                        filesByProjectId={filesByProjectId}
                        orgId={activeOrgId}
                        jwt={jwt}
                        author={session?.username}
                        allowSelfAssignment={orgSettings.allowSelfAssignment}
                        onLanesChanged={() => setRefreshTick((t) => t + 1)}
                        onLaneAdded={handleLaneAdded}
                        initialLens={statusFilter === "attention" ? "attention" : projectLens}
                        emptyTitle={
                          statusFilter === "stalled"
                            ? t("org.orgHome.emptyTitle.stalled")
                            : statusFilter === "attention"
                              ? t("org.orgHome.emptyTitle.attention")
                              : statusFilter === "overdue"
                                ? t("org.orgHome.emptyTitle.overdue")
                                : t("org.orgHome.noProjectsYet")
                        }
                      />
                    </div>
                  )}
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
                    <WorkloadRollup
                      jwt={jwt}
                      orgId={activeOrgId}
                      action={(
                        <SectionVisibilityBadge
                          minRole={orgSettings.memberProgressViewMinRole}
                          canEdit={canEditVisibility}
                          onChangeMinRole={async (next) => { await orgSettings.patch({ memberProgressViewMinRole: next }) }}
                          description={t("org.orgHome.workloadVisibilityDescription")}
                        />
                      )}
                    />
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
                    <UsageRollup
                      jwt={jwt}
                      orgId={activeOrgId}
                      action={(
                        <SectionVisibilityBadge
                          minRole={orgSettings.memberProgressViewMinRole}
                          canEdit={canEditVisibility}
                          onChangeMinRole={async (next) => { await orgSettings.patch({ memberProgressViewMinRole: next }) }}
                          description={t("org.orgHome.usageVisibilityDescription")}
                        />
                      )}
                    />
                  </div>
                </SectionVisibilityGate>
              )}
              {jwt && !isAllOrgs && activeOrgId != null && (
                <SectionVisibilityGate minRole={ROLE.MAINTAINER} viewerRoleLevel={activeOrg?.role?.level ?? null}>
                  <div
                    className={cn("relative rounded-2xl", sectionTintClass(ROLE.MAINTAINER))}
                    data-testid="section-credits"
                  >
                    <CreditsPanel
                      jwt={jwt}
                      orgId={activeOrgId}
                      orgRoleLevel={activeOrg?.role.level ?? 0}
                      action={<SectionVisibilityBadge minRole={ROLE.MAINTAINER} />}
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
