import { NavLink } from "react-router-dom"
import { useActiveOrg } from "@/context/OrgContext"
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin"
import { useProjectsForNavigation } from "@/hooks/useAccessibleProjects"
import { partitionSharedProjects } from "@/lib/frontier/shared-projects"
import { orgHomePath, orgPath, ALL_ORGS_PARAM } from "@/lib/navigation/org-paths"
import { OrgSwitcher } from "./OrgSwitcher"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { HelpMenu } from "@/components/HelpMenu"

const link = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-2 py-1.5 text-sm ${isActive ? "bg-accent font-medium" : "hover:bg-accent/60"}`

export function OrgSidebar() {
  const { orgs, activeOrg, activeOrgId, isAllOrgs } = useActiveOrg()
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
  const { projects: accessibleProjects } = useProjectsForNavigation()
  const hasSharedProjects =
    partitionSharedProjects(accessibleProjects, orgs, activeOrgId).sharedWithMe.length > 0

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
          Projects
        </NavLink>
        {!isAllOrgs && activeOrgId != null && <>
          <NavLink to={orgPath(activeOrgId, "/teams")} className={link}>Teams</NavLink>
          <NavLink to={orgPath(activeOrgId, "/assigned")} className={link} data-tour="nav-assigned">Assigned to me</NavLink>
        </>}
        {isAdmin && activeOrgId != null && <>
          <div className="my-1 border-t" />
          <NavLink to={orgPath(activeOrgId, "/members")} className={link}>Members</NavLink>
          <NavLink to={orgPath(activeOrgId, "/archived")} className={link}>Archived</NavLink>
          <NavLink to={orgPath(activeOrgId, "/settings")} className={link} data-tour="nav-settings">Settings</NavLink>
        </>}
        {isPlatformAdmin && <>
          <div className="my-1 border-t" />
          <NavLink to="/admin" className={link}>Admin</NavLink>
        </>}
        {hasSharedProjects && (
          <>
            <div className="my-1 border-t" />
            <NavLink to="/shared" className={link}>Shared with you</NavLink>
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
