import { Link } from "react-router-dom"
import { Share2 } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { EmptyState } from "@/components/ui/page"
import { Badge } from "@/components/ui/badge"
import { RoleLabel } from "@/components/RoleLabel"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
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
  const { session } = useFrontierSession()
  const username = session?.username ?? null

  const guestOrgId = activeGuestOrg?.id ?? null
  const orgName = activeGuestOrg?.name ?? (guestOrgId != null ? `Org #${guestOrgId}` : "Organization")

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
      header={<OrgBreadcrumb section="Projects" />}
      statusBar={null}
      main={
        <div
          className="h-full overflow-y-auto overscroll-contain space-y-4 p-6"
          data-testid="guest-org-scroll"
        >
          <div>
            <h1 className="text-lg font-semibold">{orgName}</h1>
            <p className="text-sm text-muted-foreground">
              Projects in {orgName} shared with you. You’re a guest here — you have
              access to these projects, but not to the organization itself.
            </p>
          </div>
          {accessibleProjectsLoading ? (
            <p className="text-sm text-muted-foreground">Loading&hellip;</p>
          ) : sharedProjects.length === 0 ? (
            <EmptyState
              icon={Share2}
              title={`Nothing shared with you from ${orgName} yet.`}
              description="When someone invites you to a project in this organization, it shows up here."
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
                        New
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
