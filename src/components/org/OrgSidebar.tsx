import { NavLink } from "react-router-dom"
import type { LucideIcon } from "lucide-react"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin"
import { partitionSharedProjects } from "@/lib/frontier/shared-projects"
import { isProjectNew, readProjectOpenedAt } from "@/lib/frontier/opened-shared-store"
import { Badge } from "@/components/ui/badge"
import { orgHomePath, orgPath, ALL_ORGS_PARAM } from "@/lib/navigation/org-paths"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { OrgSwitcher } from "./OrgSwitcher"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { HelpMenu } from "@/components/HelpMenu"

const link = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${isActive ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`

function NavIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-4 shrink-0" aria-hidden />
}

export function OrgSidebar() {
  const { orgs, activeOrg, activeOrgId, isAllOrgs, accessibleProjects } = useActiveOrg()
  const { session } = useFrontierSession()
  const username = session?.username ?? null
  const isAdmin = !isAllOrgs && (activeOrg?.role.level ?? 0) >= 600
  // Platform-operator (site-wide admin) — separate axis from the org role.
  const { isAdmin: isPlatformAdmin } = usePlatformAdmin()

  // FRO-474: project-only invitees (direct project_members grant, no org
  // membership for that project) have no org-scoped nav surface to reach
  // their project. AQU-417: rather than scatter those projects under every
  // org's nav, expose ONE dedicated entry — a single "Shared with you" link to
  // the /shared page that collects them all in one place — shown whenever the
  // caller has at least one cross-org grant. Reachability is preserved for
  // zero-org invitees (the link and the /shared route work regardless of org
  // membership, unlike the all-orgs overview which requires 2+ member orgs).
  const sharedWithMe =
    partitionSharedProjects(accessibleProjects, orgs, activeOrgId).sharedWithMe
  const hasSharedProjects = sharedWithMe.length > 0
  // AQU-696: light the nav entry while ANY shared project is still unopened —
  // it clears only once every "New" project has been opened. Read
  // synchronously: the sidebar remounts on navigation (each page renders its
  // own AppShell/OrgSidebar), so returning here after opening a project
  // re-reads a fresh "opened" record.
  const hasNewSharedProjects =
    username != null &&
    sharedWithMe.some((p) =>
      isProjectNew(p.grantedAt, readProjectOpenedAt(username, p.id)),
    )

  const homeTo = isAllOrgs
    ? orgHomePath(ALL_ORGS_PARAM)
    : activeOrgId != null
      ? orgHomePath(activeOrgId)
      : orgHomePath(ALL_ORGS_PARAM)

  return (
    <div className="flex h-full min-w-0 flex-col gap-1 overflow-hidden p-2">
      <div data-tour="org-switcher">
        <OrgSwitcher />
      </div>
      <nav className="mt-2 flex flex-1 flex-col gap-0.5">
        {/* FRO-243: data-tour anchors for product tour steps */}
        <NavLink
          to={homeTo}
          end
          className={link}
          data-tour="nav-overview"
        >
          <NavIcon icon={NAV_PAGE_ICONS.projects} />
          Projects
        </NavLink>
        {!isAllOrgs && activeOrgId != null && <>
          <NavLink to={orgPath(activeOrgId, "/teams")} className={link}>
            <NavIcon icon={NAV_PAGE_ICONS.teams} />
            Teams
          </NavLink>
          <NavLink to={orgPath(activeOrgId, "/assigned")} className={link} data-tour="nav-assigned">
            <NavIcon icon={NAV_PAGE_ICONS.assigned} />
            Assigned to me
          </NavLink>
        </>}
        {isAdmin && activeOrgId != null && <>
          <div className="my-1 border-t" />
          <NavLink to={orgPath(activeOrgId, "/members")} className={link}>
            <NavIcon icon={NAV_PAGE_ICONS.members} />
            Members
          </NavLink>
          <NavLink to={orgPath(activeOrgId, "/archived")} className={link}>
            <NavIcon icon={NAV_PAGE_ICONS.archived} />
            Archived
          </NavLink>
          <NavLink to={orgPath(activeOrgId, "/settings")} className={link} data-tour="nav-settings">
            <NavIcon icon={NAV_PAGE_ICONS.settings} />
            Settings
          </NavLink>
        </>}
        {isPlatformAdmin && <>
          <div className="my-1 border-t" />
          <NavLink to="/admin" className={link}>
            <NavIcon icon={NAV_PAGE_ICONS.admin} />
            Admin
          </NavLink>
        </>}
        {hasSharedProjects && (
          <>
            <div className="my-1 border-t" />
            <NavLink to="/shared" className={link}>
              <NavIcon icon={NAV_PAGE_ICONS.shared} />
              <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                Shared with you
                {hasNewSharedProjects && (
                  <Badge className="shrink-0" data-testid="new-shared-nav-badge">
                    New
                  </Badge>
                )}
              </span>
            </NavLink>
          </>
        )}
      </nav>
      <div className="mt-auto pt-2 flex flex-col gap-1">
        <HelpMenu />
        <div data-tour="account-switcher">
          <AccountSwitcher variant="sidebar" />
        </div>
      </div>
    </div>
  )
}
