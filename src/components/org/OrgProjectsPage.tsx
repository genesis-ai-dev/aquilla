import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { FolderPlus } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { LoadingOverlay } from "@/components/ui/loading-overlay"
import { Skeleton } from "@/components/ui/skeleton"
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
import { Page, PageHeader, EmptyState } from "@/components/ui/page"
import { cn } from "@/lib/utils"
import { readProjectLens } from "./OrgHome"

function ProjectsLoadingTemplate() {
  return (
    <div data-testid="org-projects-loading-template" className="h-full">
      <AppShell
        sidebar={
          <div className="flex h-full flex-col gap-4 p-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        }
        header={
          <div className="flex items-center gap-4 px-4">
            <Skeleton className="h-5 w-40" />
          </div>
        }
        statusBar={null}
        main={
          <Page size="full" className="px-6">
            <Skeleton className="mb-8 h-7 w-32" />
            <Skeleton className="h-64 w-full rounded-lg" />
          </Page>
        }
      />
    </div>
  )
}

/**
 * Teams-style projects list for a single org: search, status filter, New project,
 * and the dense portfolio table. Org-level stats and rollups live on Overview.
 */
export function OrgProjectsPage() {
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
            <p className="text-lg font-medium">Sign in to see your projects</p>
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

  const isPageLoading = sessionLoading || orgLoading || portfolio.isLoading

  if (isPageLoading) {
    return (
      <LoadingOverlay label="Loading projects" data-testid="org-projects-loading">
        <ProjectsLoadingTemplate />
      </LoadingOverlay>
    )
  }

  const statusFilteredProjects = portfolio.filterByStatus(statusFilter)

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Projects" />}
      statusBar={null}
      main={
        <Page size="full" className="px-6">
          <PageHeader
            title="Projects"
            description="Open a project to edit, or start a new translation workspace."
            inset={false}
          />
          {portfolio.error ? (
            <p className="text-sm text-destructive">{portfolio.error}</p>
          ) : portfolio.projects.length === 0 ? (
            <EmptyState
              icon={FolderPlus}
              title="Your organization is ready"
              description="Start a translation project, or bring your team in first — Aquilla is built for people working together."
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
                    Invite your team
                  </Button>
                </div>
              }
            />
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
                statusFilter === "stalled"
                  ? "No stalled projects."
                  : statusFilter === "attention"
                    ? "No projects need attention."
                    : statusFilter === "overdue"
                      ? "No overdue projects."
                      : "No projects yet."
              }
            />
          )}
        </Page>
      }
    />
  )
}
