import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { FolderKanban } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { LoadingOverlay } from "@/components/ui/loading-overlay"
import { LoadingCursor } from "@/components/ui/loading-cursor"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { startedPct, validatedPct } from "@/lib/frontier/portfolio"
import { listMyPendingInvites, type MyPendingInvite } from "@/lib/sync/invites"
import { WorkloadRollup } from "./WorkloadRollup"
import { UsageRollup } from "./UsageRollup"
import { OrgAiMeter } from "@/components/billing/AiMeter"
import { orgSettingsPath } from "@/lib/navigation/org-paths"
import {
  SectionVisibilityBadge,
  SectionVisibilityGate,
  sectionTintClass,
  visibilityRolePickerLabelKey,
} from "./SectionVisibilityBadge"
import { useOrgSettings, canEditRosterProgressFloor } from "@/hooks/useOrgSettings"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"
import { ROLE } from "@/lib/frontier/roles"
import { RoleLabel } from "@/components/RoleLabel"
import { OrgSetupChecklist } from "./OrgSetupChecklist"
import {
  useOrgPortfolio,
  type PortfolioProjectRow,
} from "@/hooks/useOrgPortfolio"
import { Page, PageHeader, Section } from "@/components/ui/page"
import { EmptyState } from "@/components/ui/empty"
import { DataTable } from "@/components/ui/data-table"
import { buttonVariants } from "@/components/ui/button"
import { ProjectStatus } from "@/components/ProjectStatus"
import { ValidatedBar } from "@/components/admin/ValidatedBar"
import {
  ADMIN_TABLE_CLASS,
  ADMIN_TABLE_SECTION_CONTENT,
  ADMIN_TABLE_SECTION_HEADER,
} from "@/components/admin/shared"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { portfolioAttentionReasons, type ProjectAttentionReason } from "@/lib/project-status"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { SignedOutWorkspace } from "./SignedOutWorkspace"
import { progressPercentOfFraction } from "@/lib/progress/progress-percent"

/** Bounded pane height so LegendList can virtualize instead of growing with content. */
const PROJECTS_PANEL_MAX_H =
  "h-[clamp(14rem,calc(100dvh-22rem),28rem)]"

type OverviewProjectRow = {
  project: PortfolioProjectRow
  reasons: ProjectAttentionReason[]
}

function OverviewMetric({ label, value, percent = false, overdue = false }: {
  label: string
  value: number
  percent?: boolean
  overdue?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col px-3 py-3">
      <dt className="mt-1 text-sm leading-tight text-muted-foreground [overflow-wrap:anywhere]">{label}</dt>
      <dd className={cn("order-first text-2xl font-semibold leading-none tabular-nums", overdue && value > 0 && "text-destructive")}>
        {value}{percent && "%"}
      </dd>
      {percent && (
        <div aria-hidden="true" className="mt-auto pt-2">
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${value}%` }} />
          </div>
        </div>
      )}
    </div>
  )
}

const METRIC_GROUP = "grid min-w-0 rounded-lg border bg-card text-card-foreground"

function OverviewLoadingTemplate() {
  return (
    <div data-testid="org-overview-loading-template" className="h-full">
      <AppShell
        sidebar={<OrgSidebar />}
        header={<OrgBreadcrumb section="Overview" isProjectsLanding />}
        statusBar={null}
        main={
          <Page size="wide">
            <LoadingCursor className="text-xl" />
          </Page>
        }
      />
    </div>
  )
}

/**
 * Single-org Overview: admin-style operator home — rollup tiles, a
 * continuous recently-updated project list, plus team workload / usage /
 * credits. The full searchable directory also lives on `/orgs/:id/projects`.
 */
export function OrgOverview() {
  const { t } = useI18n()
  const { activeOrg, activeOrgId, accessibleProjects, isLoading: orgLoading } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()

  const orgSettings = useOrgSettings(activeOrgId, activeOrg?.role?.level)
  // AQU-1913: the org settings version, so an org default changed elsewhere
  // re-reads the numbers.
  const portfolio = useOrgPortfolio(activeOrgId, activeOrg?.name, {
    orgSettingsVersion: orgSettings.version,
  })
  const canEditVisibility = canEditRosterProgressFloor(activeOrg?.role?.level)
  const memberProgressReady = orgSettings.hasFetched
  const memberProgressViewerRole = activeOrg?.role?.level ?? null
  // AQU-1771: Team workload and Team usage list people by name, so they need
  // the member-list setting as well as the member-progress one — the higher
  // of the two decides, exactly as the server reads both and as the project
  // overview's Team card does.
  const teamNamesFloor = Math.max(
    orgSettings.memberProgressViewMinRole,
    orgSettings.rosterViewMinRole,
  )
  // A card whose read the server refused stays hidden, rather than showing an
  // empty state that claims there is nothing to see. Keyed by org, so moving
  // to another org asks again.
  const [workloadRefusedOrg, setWorkloadRefusedOrg] = useState<number | null>(null)
  const [usageRefusedOrg, setUsageRefusedOrg] = useState<number | null>(null)
  const teamNamesBadge = (description: string) => (
    <SectionVisibilityBadge
      minRole={teamNamesFloor}
      canEdit={canEditVisibility}
      onChangeMinRole={async (next) => {
        await orgSettings.patch({ memberProgressViewMinRole: next })
      }}
      description={description}
      // The badge writes only the progress setting, so it offers nothing below
      // the member-list setting: such a value would save and then not show.
      minSelectableRole={orgSettings.rosterViewMinRole}
      storedMinRole={orgSettings.memberProgressViewMinRole}
      belowMinSelectableHint={t("org.orgHome.teamVisibilityRosterFloorHint", {
        floor: t(visibilityRolePickerLabelKey(orgSettings.rosterViewMinRole)),
      })}
    />
  )
  const assignmentRoleByProjectId = useMemo(
    () => new Map(accessibleProjects.map((project) => [project.id, project.role.level])),
    [accessibleProjects],
  )

  const [pendingInvites, setPendingInvites] = useState<MyPendingInvite[]>([])

  useEffect(() => {
    if (!jwt) {
      setPendingInvites([])
      return
    }
    let cancelled = false
    listMyPendingInvites(jwt)
      .then((list) => {
        if (!cancelled) setPendingInvites(list)
      })
      .catch((err) => {
        if (!cancelled) {
          setPendingInvites([])
          if (err instanceof UserError && err.category === "session-expired") {
            void notifySessionExpiredIfCurrent(jwt)
          }
        }
      })
    return () => {
      cancelled = true
    }
  }, [jwt])

  const projectRows = useMemo<OverviewProjectRow[]>(
    () =>
      portfolio.projects
        .map((project) => ({
          project,
          reasons: portfolioAttentionReasons(project, portfolio.now),
        }))
        .sort(
          (a, b) =>
            (b.project.lastEditAt ?? 0) - (a.project.lastEditAt ?? 0) ||
            a.project.name.localeCompare(b.project.name),
        ),
    [portfolio.projects, portfolio.now],
  )
  const projectColumns = useMemo<ColumnDef<OverviewProjectRow>[]>(
    () => [
      {
        id: "project",
        enableSorting: false,
        header: t("common.project"),
        cell: ({ row }) => (
          <Link
            to={`/projects/${encodeURIComponent(row.original.project.id)}`}
            onClick={(event) => event.stopPropagation()}
            className="truncate font-medium text-foreground hover:underline focus-visible:underline"
          >
            {row.original.project.name}
          </Link>
        ),
      },
      {
        id: "validated",
        enableSorting: false,
        header: t("org.orgHome.table.validatedHeaderLabel"),
        // AQU-1764: validated, then translated but not validated, as one
        // two-part bar in the shared progress palette.
        cell: ({ row }) => (
          <ValidatedBar
            fraction={validatedPct(row.original.project)}
            // Media redesign slice 1: the lines with any work in them, by
            // what each language delivers (the translated share for Text).
            translatedFraction={startedPct(row.original.project)}
          />
        ),
      },
      {
        id: "status",
        enableSorting: false,
        header: t("org.orgHome.projectsPanel.statusLabel"),
        cell: ({ row }) => (
          <ProjectStatus
            archived={false}
            reasons={row.original.reasons}
            deadlineAt={row.original.project.deadlineAt}
          />
        ),
      },
      {
        id: "updated",
        enableSorting: false,
        header: t("org.orgProjectsDataTable.updatedColumn"),
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.project.lastEditAt}
            label={t("org.orgProjectsDataTable.updatedColumn")}
            className="text-sm text-muted-foreground"
          />
        ),
      },
    ],
    [t],
  )

  if (!sessionLoading && !jwt) {
    return (
      <SignedOutWorkspace
        header={<OrgBreadcrumb section="Overview" isProjectsLanding />}
      />
    )
  }

  const isPageLoading = sessionLoading || orgLoading || portfolio.isLoading

  if (isPageLoading) {
    return (
      <LoadingOverlay label={t("org.overview.loadingLabel")} data-testid="org-overview-loading">
        <OverviewLoadingTemplate />
      </LoadingOverlay>
    )
  }

  const workspaceLabel = activeOrg?.name ?? "Workspace"
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Overview" isProjectsLanding />}
      statusBar={null}
      main={
        <Page size="wide">
          <PageHeader title={workspaceLabel} inset={false} />
          {portfolio.error ? (
            <p className="text-sm text-destructive">{portfolio.error}</p>
          ) : (
            <div className="space-y-6">
              {pendingInvites.length > 0 && (
                <section data-testid="pending-invitations" className="space-y-2">
                  <h2 className="text-sm font-medium text-muted-foreground">
                    {t("org.orgHome.pendingInvitations.heading")}
                  </h2>
                  <div className="divide-y rounded-lg border">
                    {pendingInvites.map((inv) => (
                      <div key={inv.token} className="flex flex-wrap items-center gap-3 p-4">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {inv.projects.map((p) => p.projectName).join(", ")}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t("org.orgHome.pendingInvitations.invitedByAs", { username: inv.createdBy })}{" "}
                            <RoleLabel name={inv.role.name} />
                            {inv.expiresAt
                              ? ` · expires ${new Date(inv.expiresAt).toLocaleDateString()}`
                              : ""}
                          </p>
                        </div>
                        <Link
                          to={`/join/${inv.token}`}
                          className={cn(buttonVariants(), "shrink-0")}
                        >
                          {t("org.orgHome.pendingInvitations.reviewAccept")}
                        </Link>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {activeOrgId != null && (
                <OrgSetupChecklist
                  key={activeOrgId}
                  orgId={activeOrgId}
                  projectCount={portfolio.projects.length}
                  onProjectCreated={(project) => navigate(`/projects/${project.id}`)}
                  linkableProjects={accessibleProjects}
                />
              )}

              <div className="@container" data-testid="org-overview-metrics">
                <div className="grid gap-2 @min-[60rem]:grid-cols-[2fr_3fr_2fr]">
                  <dl className={cn(METRIC_GROUP, "grid-cols-2")}>
                    <OverviewMetric label={t("nav.projects")} value={portfolio.projects.length} />
                    <OverviewMetric label={t("org.orgHome.activeLanguages")} value={portfolio.activeLanguageCount} />
                  </dl>
                  <dl className={cn(METRIC_GROUP, "grid-cols-3")}>
                    <OverviewMetric percent label={t("org.orgHome.avgTranslated")} value={progressPercentOfFraction(portfolio.avgTranslatedPct)} />
                    <OverviewMetric percent label={t("org.orgHome.avgValidated")} value={progressPercentOfFraction(portfolio.avgValidatedPct)} />
                    <OverviewMetric percent label={t("org.orgHome.avgAudio")} value={progressPercentOfFraction(portfolio.avgAudioPct)} />
                  </dl>
                  <dl className={cn(METRIC_GROUP, "grid-cols-2")}>
                    <OverviewMetric label={t("org.orgHome.stalled")} value={portfolio.stalledCount} />
                    <OverviewMetric overdue label={t("org.orgHome.overdue")} value={portfolio.overdueCount} />
                  </dl>
                </div>
              </div>

              <Section
                title={t("nav.projects")}
                description={t("org.overview.projectsDescription")}
                className={cn("flex min-w-0 flex-col overflow-hidden", PROJECTS_PANEL_MAX_H)}
                headerClassName={cn(ADMIN_TABLE_SECTION_HEADER, "shrink-0")}
                contentClassName={cn(
                  ADMIN_TABLE_SECTION_CONTENT,
                  "flex min-h-0 min-w-0 flex-1 flex-col",
                )}
              >
                <div
                  id="org-overview-projects-table"
                  className="flex min-h-0 min-w-0 flex-1 flex-col"
                >
                  <DataTable
                    columns={projectColumns}
                    data={projectRows}
                    getRowId={(r) => r.project.id}
                    onRowClick={(r) => navigate(`/projects/${r.project.id}`)}
                    testId="org-overview-projects-table"
                    className={cn(
                      ADMIN_TABLE_CLASS,
                      // Keep the -mx-2 bleed inside the card so the
                      // fillHeight scrollbar is not clipped at the edge.
                      "mx-0",
                    )}
                    dense
                    fillHeight
                    emptyState={
                      <EmptyState
                        variant="inline"
                        className="py-6"
                        icon={FolderKanban}
                        title={t("org.orgHome.projectsPanel.emptyTitle")}
                        description={t("org.overview.emptyDescription")}
                      />
                    }
                  />
                </div>
              </Section>

              {jwt && activeOrgId != null && workloadRefusedOrg !== activeOrgId && (
                <SectionVisibilityGate
                  minRole={teamNamesFloor}
                  viewerRoleLevel={memberProgressViewerRole}
                  ready={memberProgressReady}
                >
                  <div
                    className={cn(
                      "relative rounded-lg",
                      sectionTintClass(teamNamesFloor),
                    )}
                    data-testid="section-team-workload"
                  >
                    <WorkloadRollup
                      jwt={jwt}
                      orgId={activeOrgId}
                      canUnassignProject={(projectId) =>
                        (assignmentRoleByProjectId.get(projectId) ?? 0) >=
                        orgSettings.assignmentMinRole
                      }
                      onRefused={() => setWorkloadRefusedOrg(activeOrgId)}
                      action={teamNamesBadge(t("org.orgHome.workloadVisibilityDescription"))}
                    />
                  </div>
                </SectionVisibilityGate>
              )}
              {jwt && activeOrgId != null && usageRefusedOrg !== activeOrgId && (
                <SectionVisibilityGate
                  minRole={teamNamesFloor}
                  viewerRoleLevel={memberProgressViewerRole}
                  ready={memberProgressReady}
                >
                  <div
                    className={cn(
                      "relative rounded-lg",
                      sectionTintClass(teamNamesFloor),
                    )}
                    data-testid="section-team-usage"
                  >
                    <UsageRollup
                      jwt={jwt}
                      orgId={activeOrgId}
                      onRefused={() => setUsageRefusedOrg(activeOrgId)}
                      action={teamNamesBadge(t("org.orgHome.usageVisibilityDescription"))}
                    />
                  </div>
                </SectionVisibilityGate>
              )}
              {jwt && activeOrgId != null && (
                // AQU-2068: every member sees the same % meter; it shows no
                // amounts, so it needs no maintainer gate (the credit panels did).
                <Section
                  title={t("billing.meter.sectionTitle")}
                  action={(activeOrg?.role?.level ?? 0) >= ROLE.MAINTAINER ? (
                    <Link to={orgSettingsPath(activeOrgId, "billing")} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                      {t("billing.usage.open")}
                    </Link>
                  ) : undefined}
                  data-testid="section-billing"
                >
                  <OrgAiMeter
                    jwt={jwt}
                    orgId={activeOrgId}
                    canManage={(activeOrg?.role?.level ?? 0) >= ROLE.MAINTAINER}
                  />
                </Section>
              )}
            </div>
          )}
        </Page>
      }
    />
  )
}
