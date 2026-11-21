import { Link } from "react-router-dom"
import { CloudOff, FolderOpen } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { Page, PageHeader, EmptyState } from "@/components/ui/page"
import { LoadingOverlay } from "@/components/ui/loading-overlay"
import { useActiveOrg } from "@/context/OrgContext"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useOfflineProjectList } from "@/lib/offline/offline-project-list"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"

/**
 * Desktop, offline: an org's projects page (or, with `orgId` null, the
 * all-orgs dashboard) lists the projects downloaded to this device instead of
 * the server directory, each opening straight into the editor. The org pages
 * get here from cached org lists (OrgContext `offline`).
 */
export function OfflineProjectsPage({ orgId }: { orgId: number | null }) {
  const { t } = useI18n()
  const format = useFormat()
  const { orgs, guestOrgs } = useActiveOrg()
  const { session } = useFrontierSession()
  const { store, loading } = useOfflineStore()
  const all = useOfflineProjectList(store, session?.username ?? null)
  const projects = orgId == null ? all : all.filter((project) => project.orgId === orgId)
  const orgName = (id: number | null) =>
    id == null ? null : (orgs.find((o) => o.id === id)?.name ?? guestOrgs.find((o) => o.id === id)?.name ?? null)

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Projects" isProjectsLanding />}
      statusBar={null}
      main={
        <Page size="full" fill>
          <div className="max-w-6xl shrink-0">
            <PageHeader
              title={t("nav.projects")}
              description={t("org.offlineProjects.description")}
              inset={false}
            />
          </div>
          <div
            className="flex max-w-6xl items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
            data-testid="offline-projects-banner"
          >
            <CloudOff className="size-4 shrink-0" aria-hidden />
            {t("org.offlineProjects.banner")}
          </div>
          {loading ? (
            <LoadingOverlay label={t("org.projectsList.loadingLabel")} />
          ) : projects.length === 0 ? (
            <EmptyState
              className="max-w-6xl"
              icon={FolderOpen}
              title={t("org.offlineProjects.emptyTitle")}
              description={t("org.offlineProjects.emptyDescription")}
              data-testid="offline-projects-empty"
            />
          ) : (
            <ul className="max-w-6xl divide-y rounded-md border bg-card" data-testid="offline-projects-list">
              {projects.map((project) => {
                const org = orgId == null ? orgName(project.orgId) : null
                return (
                  <li key={project.id}>
                    <Link
                      to={`/project/${project.id}/editor`}
                      className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                      data-testid="offline-project-link"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{project.name}</span>
                        {org ? <span className="block truncate text-xs text-muted-foreground">{org}</span> : null}
                      </span>
                      {project.syncedAt ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {t("org.offlineProjects.syncedAt", { when: format.relativeTime(project.syncedAt) })}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </Page>
      }
    />
  )
}
