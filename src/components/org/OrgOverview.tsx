import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { ShieldAlert } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { LoadingOverlay } from "@/components/ui/loading-overlay"
import { Skeleton } from "@/components/ui/skeleton"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { orgProjectsPath } from "@/lib/navigation/org-paths"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { validatedPct } from "@/lib/frontier/portfolio"
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
import { ROLE } from "@/lib/frontier/roles"
import { RoleLabel } from "@/components/RoleLabel"
import { OrgSetupChecklist } from "./OrgSetupChecklist"
import {
  useOrgPortfolio,
  type AttentionRow,
} from "@/hooks/useOrgPortfolio"
import { Page, PageHeader, Section, StatTile, STAT_TILE_GRID } from "@/components/ui/page"
import { EmptyState } from "@/components/ui/empty"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
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

const ATTENTION_PREVIEW = 6

function OverviewLoadingTemplate() {
  return (
    <div data-testid="org-overview-loading-template" className="h-full">
      <AppShell
        sidebar={
          <div className="flex h-full flex-col gap-4 p-2">
            <Skeleton className="h-9 w-full" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-3/4" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          </div>
        }
        header={
          <div className="flex items-center gap-4 px-4">
            <Skeleton className="h-5 w-40" />
          </div>
        }
        statusBar={null}
        main={
          <Page size="wide">
            <Skeleton className="mb-8 h-7 w-48" />
            <div className={STAT_TILE_GRID}>
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={index}
                  className="flex h-[88px] items-center justify-between rounded-lg border bg-card px-5 py-4 min-[480px]:flex-col min-[480px]:items-start min-[480px]:justify-start min-[480px]:gap-2"
                >
                  <Skeleton className="order-last h-6 w-12 min-[480px]:order-none" />
                  <Skeleton className="h-3 w-20" />
                </div>
              ))}
            </div>
          </Page>
        }
      />
    </div>
  )
}

/**
 * Single-org Overview: admin-style operator home — rollup tiles, projects that
 * need attention, plus team workload / usage / credits. Full project list lives
 * on `/orgs/:id/projects`.
 */
export function OrgOverview() {
  const { t } = useI18n()
  const { activeOrg, activeOrgId, accessibleProjects, isLoading: orgLoading } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()

  const portfolio = useOrgPortfolio(activeOrgId, activeOrg?.name)
  const orgSettings = useOrgSettings(activeOrgId, activeOrg?.role?.level)
  const canEditVisibility = canEditRosterProgressFloor(activeOrg?.role?.level)
  const memberProgressReady = orgSettings.hasFetched
  const memberProgressViewerRole = activeOrg?.role?.level ?? null

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
      .catch(() => {
        if (!cancelled) setPendingInvites([])
      })
    return () => {
      cancelled = true
    }
  }, [jwt])

  const atRiskPreview = portfolio.attentionProjects.slice(0, ATTENTION_PREVIEW)
  const atRiskTotal = portfolio.attentionProjects.length

  const atRiskColumns = useMemo<ColumnDef<AttentionRow>[]>(
    () => [
      {
        id: "project",
        accessorFn: (r) => r.project.name.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.project")} />,
        cell: ({ row }) => (
          <span className="font-medium text-foreground">{row.original.project.name}</span>
        ),
      },
      {
        id: "validated",
        accessorFn: (r) => validatedPct(r.project),
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("org.orgHome.table.validatedHeaderLabel")} />
        ),
        cell: ({ row }) => <ValidatedBar fraction={validatedPct(row.original.project)} />,
      },
      {
        id: "status",
        accessorFn: (r) => r.score,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("org.orgHome.projectsPanel.statusLabel")} />
        ),
        cell: ({ row }) => (
          <ProjectStatus
            archived={false}
            reasons={row.original.reasons}
            deadlineAt={row.original.project.deadlineAt}
          />
        ),
      },
    ],
    [t],
  )

  if (!sessionLoading && !jwt) {
    return (
      <AppShell
        sidebar={<OrgSidebar />}
        header={<OrgBreadcrumb section="Overview" isProjectsLanding />}
        statusBar={null}
        main={
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="text-lg font-medium">{t("org.orgHome.signedOut.heading")}</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              {t("org.orgHome.signedOut.description")}
            </p>
            <Link
              to={`/login?next=${encodeURIComponent("/")}`}
              className={cn(buttonVariants())}
            >
              {t("auth.login.submitDefault")}
            </Link>
          </div>
        }
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
  const openProjects = () => {
    if (activeOrgId != null) navigate(orgProjectsPath(activeOrgId))
  }

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
                  orgId={activeOrgId}
                  projectCount={portfolio.projects.length}
                  onProjectCreated={(project) => navigate(`/projects/${project.id}`)}
                  linkableProjects={accessibleProjects}
                />
              )}

              <div className={STAT_TILE_GRID}>
                <StatTile label={t("nav.projects")} value={portfolio.projects.length} />
                <StatTile
                  label={t("org.orgHome.avgTranslated")}
                  value={`${Math.round(portfolio.avgTranslatedPct * 100)}%`}
                />
                <StatTile
                  label={t("org.orgHome.avgValidated")}
                  value={`${Math.round(portfolio.avgValidatedPct * 100)}%`}
                />
                <StatTile
                  label={t("org.orgHome.avgAudio")}
                  value={`${Math.round(portfolio.avgAudioPct * 100)}%`}
                />
                <StatTile label={t("org.orgHome.stalled")} value={portfolio.stalledCount} />
                <StatTile
                  label={t("org.orgHome.overdue")}
                  value={
                    <span className={portfolio.overdueCount > 0 ? "text-destructive" : undefined}>
                      {portfolio.overdueCount}
                    </span>
                  }
                  className={atRiskTotal > 0 ? "border-amber-500/40" : undefined}
                />
              </div>

              <Section
                title={t("org.overview.needsAttentionHeading")}
                description={t("org.overview.needsAttentionDescription")}
                headerClassName={ADMIN_TABLE_SECTION_HEADER}
                contentClassName={ADMIN_TABLE_SECTION_CONTENT}
                action={
                  atRiskTotal > 0 ? (
                    <button
                      type="button"
                      onClick={openProjects}
                      className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                    >
                      {atRiskTotal > atRiskPreview.length
                        ? `View all ${atRiskTotal}`
                        : "View projects"}
                    </button>
                  ) : null
                }
              >
                <DataTable
                  columns={atRiskColumns}
                  data={atRiskPreview}
                  getRowId={(r) => r.project.id}
                  onRowClick={(r) => navigate(`/projects/${r.project.id}`)}
                  initialSorting={[{ id: "status", desc: true }]}
                  testId="org-overview-attention-table"
                  className={ADMIN_TABLE_CLASS}
                  dense
                  emptyState={
                    <EmptyState
                      variant="inline"
                      className="py-6"
                      icon={ShieldAlert}
                      title={t("org.overview.allClearTitle")}
                      description={t("org.overview.allClearDescription")}
                    />
                  }
                />
              </Section>

              {jwt && activeOrgId != null && (
                <SectionVisibilityGate
                  minRole={orgSettings.memberProgressViewMinRole}
                  viewerRoleLevel={memberProgressViewerRole}
                  ready={memberProgressReady}
                >
                  <div
                    className={cn(
                      "relative rounded-lg",
                      sectionTintClass(orgSettings.memberProgressViewMinRole),
                    )}
                    data-testid="section-team-workload"
                  >
                    <WorkloadRollup
                      jwt={jwt}
                      orgId={activeOrgId}
                      action={
                        <SectionVisibilityBadge
                          minRole={orgSettings.memberProgressViewMinRole}
                          canEdit={canEditVisibility}
                          onChangeMinRole={async (next) => {
                            await orgSettings.patch({ memberProgressViewMinRole: next })
                          }}
                          description={t("org.orgHome.workloadVisibilityDescription")}
                        />
                      }
                    />
                  </div>
                </SectionVisibilityGate>
              )}
              {jwt && activeOrgId != null && (
                <SectionVisibilityGate
                  minRole={orgSettings.memberProgressViewMinRole}
                  viewerRoleLevel={memberProgressViewerRole}
                  ready={memberProgressReady}
                >
                  <div
                    className={cn(
                      "relative rounded-lg",
                      sectionTintClass(orgSettings.memberProgressViewMinRole),
                    )}
                    data-testid="section-team-usage"
                  >
                    <UsageRollup
                      jwt={jwt}
                      orgId={activeOrgId}
                      action={
                        <SectionVisibilityBadge
                          minRole={orgSettings.memberProgressViewMinRole}
                          canEdit={canEditVisibility}
                          onChangeMinRole={async (next) => {
                            await orgSettings.patch({ memberProgressViewMinRole: next })
                          }}
                          description={t("org.orgHome.usageVisibilityDescription")}
                        />
                      }
                    />
                  </div>
                </SectionVisibilityGate>
              )}
              {jwt && activeOrgId != null && (
                <SectionVisibilityGate
                  minRole={ROLE.MAINTAINER}
                  viewerRoleLevel={activeOrg?.role?.level ?? null}
                >
                  <div
                    className={cn("relative rounded-lg", sectionTintClass(ROLE.MAINTAINER))}
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
