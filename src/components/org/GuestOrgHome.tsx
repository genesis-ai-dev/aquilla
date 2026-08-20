import { Link } from "react-router-dom"
import { Share2 } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { EmptyState } from "@/components/ui/page"
import { Badge } from "@/components/ui/badge"
import { RoleLabel } from "@/components/RoleLabel"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { partitionSharedProjects } from "@/lib/frontier/shared-projects"
import { isProjectNew, readProjectOpenedAt } from "@/lib/frontier/opened-shared-store"

/**
 * AQU-790: the overview for an org the caller reaches only through a project
 * grant — a *guest* org. It shares the same URL convention as an owned org
 * (`/orgs/:orgId`, resolved by OrgHomeRoute), but shows only the projects in
 * that org shared with the caller. It renders none of the member-org chrome
 * (create dialog, team/usage/credit rollups, org rollup stats) and the sidebar
 * hides member-only nav, because the caller has no org membership here.
 *
 * Previously a guest org was reached via a divergent `/shared?org=<id>` query
 * param, which collided with the path-based owned-org chrome: org actions and
 * the breadcrumb described the caller's *owned* active org instead of the guest
 * org they were viewing.
 */
export function GuestOrgHome() {
  const { activeGuestOrg, orgs, activeOrgId, accessibleProjects, accessibleProjectsLoading } =
    useActiveOrg()
  const t = useT()
  const { session } = useFrontierSession()
  const username = session?.username ?? null

  const guestOrgId = activeGuestOrg?.id ?? null
  const orgName =
    activeGuestOrg?.name ??
    (guestOrgId != null
      ? t("org.guestOrgHome.orgFallbackWithId", { id: guestOrgId })
      : t("org.breadcrumb.organizationFallback"))

  // The app-wide accessible-project directory is already fetched by OrgProvider;
  // reuse it rather than issuing another request. "Shared with me" scoped to the
  // guest org gives exactly this org's grants (same rule as SharedProjectsPage).
  const sharedProjects = partitionSharedProjects(
    accessibleProjects,
    orgs,
    activeOrgId,
    "all-orgs",
  ).sharedWithMe.filter((p) => p.orgId === guestOrgId)

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={t("nav.projects")} isProjectsLanding />}
      statusBar={null}
      main={
        <div
          className="h-full overflow-y-auto overscroll-contain space-y-4 p-6"
          data-testid="guest-org-scroll"
        >
          <div>
            <h1 className="text-lg font-semibold">{orgName}</h1>
            <p className="text-sm text-muted-foreground">
              {t("org.guestOrgHome.description", { orgName })}
            </p>
          </div>
          {accessibleProjectsLoading ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : sharedProjects.length === 0 ? (
            <EmptyState
              icon={Share2}
              title={t("org.guestOrgHome.emptyTitle", { orgName })}
              description={t("org.guestOrgHome.emptyDescription")}
            />
          ) : (
            <section data-testid="guest-org-projects" className="rounded-2xl border divide-y">
              {sharedProjects.map((p) => {
                const isNew = username
                  ? isProjectNew(p.grantedAt, readProjectOpenedAt(username, p.id))
                  : false
                return (
                  <Link
                    key={p.id}
                    to={`/projects/${p.id}`}
                    className="flex items-center gap-4 p-4 hover:bg-muted/50 transition-colors"
                  >
                    <p className="flex-1 min-w-0 truncate font-medium">{p.name}</p>
                    {isNew && (
                      <Badge className="shrink-0" data-testid="new-shared-badge">
                        {t("org.guestOrgHome.newBadge")}
                      </Badge>
                    )}
                    <RoleLabel name={p.role.name} className="shrink-0 text-xs text-muted-foreground" />
                  </Link>
                )
              })}
            </section>
          )}
        </div>
      }
    />
  )
}
