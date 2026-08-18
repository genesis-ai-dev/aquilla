import { useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { membersPath } from "@/lib/navigation/org-paths"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { ProjectCreateDialog } from "@/components/ProjectCreateDialog"
import { OrgProjectsDataTable } from "./OrgProjectsDataTable"
import { ProjectStatusFilter } from "./ProjectStatusFilter"
import {
  useOrgPortfolio,
  type StatusFilter,
} from "@/hooks/useOrgPortfolio"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { partitionSharedProjects, toSharedPortfolioRow } from "@/lib/frontier/shared-projects"
import { isProjectNew, readProjectOpenedAt } from "@/lib/frontier/opened-shared-store"
import { Button, buttonVariants } from "@/components/ui/button"
import { Page, PageHeader } from "@/components/ui/page"
import { cn } from "@/lib/utils"
import { readProjectLens } from "./OrgHome"
import { useI18n } from "@/lib/i18n/I18nProvider"

/**
 * Teams-style projects list for a single org: search, status filter, New project,
 * and the dense portfolio table. Org-level stats and rollups live on Overview.
 *
 * Guest orgs reuse this page (no Overview, no create). The member-org portfolio
 * endpoint 403s for non-members, so guest rows come from the accessible-project
 * directory instead.
 */
export function OrgProjectsPage() {
  const { t } = useI18n()
  const {
    activeOrg,
    activeOrgId,
    activeGuestOrg,
    orgs,
    accessibleProjects,
    isLoading: orgLoading,
  } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const username = session?.username ?? null
  const navigate = useNavigate()
  const isGuestOrg = activeGuestOrg != null
  // Member-org portfolio 403s for guests. Only fetch it when this org is a
  // membership — not merely "not yet classified as a guest" on first paint.
  const portfolio = useOrgPortfolio(activeOrg ? activeOrgId : null, activeOrg?.name)
  const orgSettings = useOrgSettings(activeOrg ? activeOrgId : null, activeOrg?.role?.level)

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const projectLens = readProjectLens()

  const guestOrgId = activeGuestOrg?.id ?? null
  const guestOrgName =
    activeGuestOrg?.name ??
    (guestOrgId != null
      ? t("org.guestOrgHome.orgFallbackWithId", { id: guestOrgId })
      : t("org.breadcrumb.organizationFallback"))

  const guestProjects = useMemo(() => {
    if (!isGuestOrg || guestOrgId == null) return []
    return partitionSharedProjects(
      accessibleProjects,
      orgs,
      activeOrgId,
      "all-orgs",
    ).sharedWithMe
      .filter((p) => p.orgId === guestOrgId)
      .map((p) => {
        // Drop the Shared origin badge — every row here is shared, and the
        // org switcher already tags the org Guest.
        const { origin: _sharedOrigin, ...row } = toSharedPortfolioRow(p)
        return {
          ...row,
          isNew: username
            ? isProjectNew(p.grantedAt, readProjectOpenedAt(username, p.id))
            : false,
        }
      })
  }, [isGuestOrg, guestOrgId, accessibleProjects, orgs, activeOrgId, username])

  function handleCreated(project: ProjectRecord) {
    void portfolio.refreshAccessibleProjects()
    navigate(`/projects/${project.id}`)
  }

  if (!sessionLoading && !jwt) {
    return (
      <AppShell
        sidebar={<OrgSidebar />}
        header={<OrgBreadcrumb section="Projects" />}
        statusBar={null}
        main={
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="text-lg font-medium">{t("org.projectsList.signedOutTitle")}</p>
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
  const sourceProjects = isGuestOrg ? guestProjects : portfolio.projects
  const statusFilteredProjects = isPageLoading
    ? []
    : isGuestOrg
      ? portfolio.filterByStatus(statusFilter, guestProjects)
      : portfolio.filterByStatus(statusFilter)
  const noProjects = !isPageLoading && sourceProjects.length === 0

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Projects" />}
      statusBar={null}
      main={
        <Page size="full">
          {/* Title matches Teams/Members max width; table uses the full content well. */}
          <div className="max-w-6xl">
            <PageHeader
              title={t("nav.projects")}
              description={
                isGuestOrg
                  ? t("org.guestOrgHome.description", { orgName: guestOrgName })
                  : t("org.orgProjectsPage.pageDescription")
              }
              inset={false}
            />
          </div>
          {portfolio.error ? (
            <p className="max-w-6xl text-sm text-destructive">{portfolio.error}</p>
          ) : (
            <OrgProjectsDataTable
              projects={statusFilteredProjects}
              now={portfolio.now}
              roleByProjectId={portfolio.roleByProjectId}
              defaultLaneLabelByProjectId={portfolio.defaultLaneLabelByProjectId}
              filesByProjectId={portfolio.filesByProjectId}
              orgId={activeOrgId}
              jwt={jwt}
              author={session?.username}
              allowSelfAssignment={orgSettings.allowSelfAssignment}
              onLanesChanged={portfolio.bumpRefresh}
              initialLens={statusFilter === "attention" ? "attention" : projectLens}
              loading={isPageLoading}
              loadingLabel={t("org.projectsList.loadingLabel")}
              toolbarLeading={
                <ProjectStatusFilter
                  value={statusFilter}
                  onValueChange={setStatusFilter}
                  className="bg-card"
                />
              }
              toolbarTrailing={
                !isGuestOrg && activeOrgId != null ? (
                  <div className="ml-auto shrink-0">
                    <ProjectCreateDialog
                      orgId={activeOrgId}
                      onCreated={handleCreated}
                      linkableProjects={accessibleProjects}
                    />
                  </div>
                ) : null
              }
              emptyTitle={
                noProjects
                  ? isGuestOrg
                    ? t("org.guestOrgHome.emptyTitle", { orgName: guestOrgName })
                    : t("org.orgHome.readyTitle")
                  : statusFilter === "stalled"
                    ? t("org.orgHome.emptyTitle.stalled")
                    : statusFilter === "attention"
                      ? t("org.orgHome.emptyTitle.attention")
                      : statusFilter === "overdue"
                        ? t("org.orgHome.emptyTitle.overdue")
                        : t("org.orgHome.projectsPanel.emptyTitle")
              }
              emptyDescription={
                noProjects
                  ? isGuestOrg
                    ? t("org.guestOrgHome.emptyDescription")
                    : t("org.orgHome.readyDescription")
                  : undefined
              }
              emptyAction={
                noProjects && !isGuestOrg && activeOrgId != null ? (
                  <Button
                    variant="outline"
                    onClick={() => navigate(membersPath(activeOrgId))}
                  >
                    {t("org.orgHome.inviteYourTeam")}
                  </Button>
                ) : undefined
              }
            />
          )}
        </Page>
      }
    />
  )
}
