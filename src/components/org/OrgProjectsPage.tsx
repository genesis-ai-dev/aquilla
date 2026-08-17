import { useState } from "react"
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
import { Button, buttonVariants } from "@/components/ui/button"
import { Page, PageHeader } from "@/components/ui/page"
import { cn } from "@/lib/utils"
import { readProjectLens } from "./OrgHome"
import { useI18n } from "@/lib/i18n/I18nProvider"

/**
 * Teams-style projects list for a single org: search, status filter, New project,
 * and the dense portfolio table. Org-level stats and rollups live on Overview.
 */
export function OrgProjectsPage() {
  const { t } = useI18n()
  const {
    activeOrg,
    activeOrgId,
    accessibleProjects,
    isLoading: orgLoading,
  } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()
  const portfolio = useOrgPortfolio(activeOrgId, activeOrg?.name)
  const orgSettings = useOrgSettings(activeOrgId, activeOrg?.role?.level)

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const projectLens = readProjectLens()

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
  const statusFilteredProjects = isPageLoading ? [] : portfolio.filterByStatus(statusFilter)
  const noProjects = !isPageLoading && portfolio.projects.length === 0

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
              description={t("org.orgProjectsPage.pageDescription")}
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
                activeOrgId != null ? (
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
                  ? t("org.orgHome.readyTitle")
                  : statusFilter === "stalled"
                    ? t("org.orgHome.emptyTitle.stalled")
                    : statusFilter === "attention"
                      ? t("org.orgHome.emptyTitle.attention")
                      : statusFilter === "overdue"
                        ? t("org.orgHome.emptyTitle.overdue")
                        : t("org.orgHome.projectsPanel.emptyTitle")
              }
              emptyDescription={noProjects ? t("org.orgHome.readyDescription") : undefined}
              emptyAction={
                noProjects && activeOrgId != null ? (
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
