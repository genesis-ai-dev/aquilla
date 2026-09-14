import { useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { ProjectCreateDialog } from "@/components/ProjectCreateDialog"
import { OrgProjectsDataTable } from "./OrgProjectsDataTable"
import { ProjectSortMenu } from "./ProjectSortMenu"
import {
  PM_FILTER_ALL,
  PM_FILTER_MINE,
  filterByPm,
  hasUnassignedPm,
  isManagedBy,
  pmFilterUsernames,
  resolvePmFilter,
  type PmFilter,
} from "./project-pm-filter"
import {
  ROLE_FILTER_ALL,
  filterByRole,
  resolveRoleFilter,
  roleFilterNames,
  type RoleFilter,
} from "./project-role-filter"
import {
  UPDATED_FILTER_ANY,
  filterByUpdated,
  resolveUpdatedFilter,
  type UpdatedFilter,
} from "./project-updated-filter"
import {
  useOrgPortfolio,
  type StatusFilter,
} from "@/hooks/useOrgPortfolio"
import { useProjectDirectory } from "@/hooks/useProjectDirectory"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { partitionSharedProjects, toSharedPortfolioRow } from "@/lib/frontier/shared-projects"
import { isProjectNew, readProjectOpenedAt } from "@/lib/frontier/opened-shared-store"
import { buttonVariants } from "@/components/ui/button"
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
    accessibleProjectsLoading,
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
  // AQU-1040: designated-PM narrowing, composed with the status filter below.
  const [pmFilter, setPmFilter] = useState<PmFilter>(PM_FILTER_ALL)
  // AQU-1042: viewer-role narrowing, composed with both filters below.
  const [roleFilter, setRoleFilter] = useState<RoleFilter>(ROLE_FILTER_ALL)
  // AQU-1043: last-edit recency narrowing, composed with all three below.
  const [updatedFilter, setUpdatedFilter] = useState<UpdatedFilter>(UPDATED_FILTER_ANY)
  const [projectQuery, setProjectQuery] = useState("")
  const [directoryTick, setDirectoryTick] = useState(0)
  const projectLens = readProjectLens()

  const directory = useProjectDirectory({
    jwt,
    enabled: Boolean(jwt) && activeOrgId != null && !isGuestOrg,
    query: projectQuery,
    orgIds: activeOrgId != null ? [activeOrgId] : [],
    refreshKey: directoryTick,
  })

  const guestOrgId = activeGuestOrg?.id ?? null
  const guestOrgName =
    activeGuestOrg?.name ??
    (guestOrgId != null
      ? t("org.guestOrgHome.orgFallbackWithId", { id: guestOrgId })
      : t("org.breadcrumb.organizationFallback"))

  const guestProjects = useMemo(() => {
    if (!isGuestOrg || guestOrgId == null) return []
    const queryNorm = projectQuery.trim().toLowerCase()
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
      .filter((row) =>
        queryNorm === ""
          ? true
          : `${row.name} ${row.orgName ?? ""} ${row.pm?.username ?? ""}`.toLowerCase().includes(queryNorm),
      )
  }, [isGuestOrg, guestOrgId, accessibleProjects, orgs, activeOrgId, username, projectQuery])

  const pmByProjectId = useMemo(
    () => new Map(accessibleProjects.map((project) => [project.id, project.pm ?? null])),
    [accessibleProjects],
  )

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

  const isPageLoading =
    sessionLoading ||
    orgLoading ||
    accessibleProjectsLoading ||
    (isGuestOrg
      ? false
      : directory.loading && directory.projects.length === 0)
  const memberProjects = directory.projects.map((project) => ({
    ...project,
    orgId: project.orgId ?? activeOrgId ?? undefined,
    orgName: activeOrg?.name ?? "Workspace",
    pm: pmByProjectId.has(project.id) ? pmByProjectId.get(project.id) ?? null : project.pm,
  }))
  const sourceProjects = isGuestOrg ? guestProjects : memberProjects
  const statusFilteredProjects = isPageLoading
    ? []
    : portfolio.filterByStatus(statusFilter, sourceProjects)
  const noProjects = !isPageLoading && sourceProjects.length === 0
  // AQU-1040: options come from every loaded row, not the status-filtered
  // slice, so toggling status never silently drops the PM you picked. A PM that
  // leaves the portfolio entirely falls back to "all" instead of stranding the
  // table on an option the control no longer offers.
  const pmUsernames = pmFilterUsernames(sourceProjects, username)
  const showUnassignedPm = hasUnassignedPm(sourceProjects)
  const activePmFilter = resolvePmFilter(pmFilter, pmUsernames, showUnassignedPm, username)
  // AQU-1027: read off every loaded row, not the filtered slice — "Managed by
  // me" plus a status filter that matches nothing is still a filter miss, not
  // proof that the viewer manages nothing.
  const managesNone =
    !isPageLoading && !sourceProjects.some((project) => isManagedBy(project, username))
  // AQU-1042: same derivation rule for the viewer-role options — every loaded
  // row, not the filtered slice. Roleless rows ("—" in the Role column) pass
  // only under the "all" default.
  const roleNames = roleFilterNames(sourceProjects, portfolio.roleByProjectId)
  const activeRoleFilter = resolveRoleFilter(roleFilter, roleNames)
  // AQU-1043: fixed recency windows, so nothing to derive from the rows — only
  // a guard against a value outside the offered buckets. Filtered last, against
  // the portfolio's frozen `now`, so the window and the Updated column's
  // relative times are read off the same clock.
  const activeUpdatedFilter = resolveUpdatedFilter(updatedFilter)
  const visibleProjects = filterByUpdated(
    filterByRole(
      filterByPm(statusFilteredProjects, activePmFilter, username),
      portfolio.roleByProjectId,
      activeRoleFilter,
    ),
    activeUpdatedFilter,
    portfolio.now,
  )

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Projects" />}
      statusBar={null}
      main={
        <Page size="full" fill>
          {/* Title matches Teams/Members max width; table uses the full content well. */}
          <div className="max-w-6xl shrink-0">
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
          {portfolio.error || directory.error ? (
            <p className="max-w-6xl shrink-0 text-sm text-destructive">{directory.error ?? portfolio.error}</p>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <OrgProjectsDataTable
                projects={visibleProjects}
                now={portfolio.now}
                roleByProjectId={portfolio.roleByProjectId}
                defaultLaneLabelByProjectId={portfolio.defaultLaneLabelByProjectId}
                filesByProjectId={portfolio.filesByProjectId}
                orgId={activeOrgId}
                jwt={jwt}
                author={session?.username}
                allowSelfAssignment={orgSettings.allowSelfAssignment}
                viewerUsername={username}
                onLanesChanged={() => {
                  portfolio.bumpRefresh()
                  setDirectoryTick((tick) => tick + 1)
                }}
                initialLens={statusFilter === "attention" ? "attention" : projectLens}
                loading={isPageLoading}
                loadingLabel={t("org.projectsList.loadingLabel")}
                searchValue={projectQuery}
                onSearchChange={setProjectQuery}
                searching={!isGuestOrg && directory.searching}
                hasMore={!isGuestOrg && directory.hasMore}
                onLoadMore={directory.loadMore}
                loadingMore={directory.loadingMore}
                toolbarLeading={
                  // AQU-1044: the four narrowing dimensions (Status, PM, Role,
                  // Updated) live in one Sort by menu — one submenu each. The
                  // toolbar row is still a flex/wrap track: further sibling
                  // controls slot in next to it, no wrapper needed.
                  <ProjectSortMenu
                    status={statusFilter}
                    onStatusChange={setStatusFilter}
                    pm={activePmFilter}
                    pmUsernames={pmUsernames}
                    showUnassignedPm={showUnassignedPm}
                    viewerUsername={username}
                    onPmChange={setPmFilter}
                    role={activeRoleFilter}
                    roleNames={roleNames}
                    onRoleChange={setRoleFilter}
                    updated={activeUpdatedFilter}
                    onUpdatedChange={setUpdatedFilter}
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
                      : t("org.orgHome.projectsPanel.emptyTitle")
                    : activePmFilter !== PM_FILTER_ALL ||
                        activeRoleFilter !== ROLE_FILTER_ALL ||
                        activeUpdatedFilter !== UPDATED_FILTER_ANY
                      ? // AQU-1040/AQU-1042/AQU-1043: a filter combination that matches
                        // nothing is a filtered-empty table, not an empty org.
                        // AQU-1027: name the reason when the viewer manages nothing at
                        // all here, rather than blaming the filter combination.
                        activePmFilter === PM_FILTER_MINE && managesNone
                        ? t("org.orgProjectsPage.pmFilter.mineEmptyTitle")
                        : t("org.orgHome.projectsPanel.noMatchingProjects")
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
                      : t("org.overview.emptyDescription")
                    : undefined
                }
              />
            </div>
          )}
        </Page>
      }
    />
  )
}
