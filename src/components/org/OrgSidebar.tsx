import { useCallback } from "react"
import { NavLink } from "react-router-dom"
import { Map } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { useActiveOrg } from "@/context/OrgContext"
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin"
import { useProjectsForNavigation } from "@/hooks/useAccessibleProjects"
import { partitionSharedProjects } from "@/lib/frontier/shared-projects"
import { OrgSwitcher } from "./OrgSwitcher"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { HelpMenu } from "@/components/HelpMenu"
import { useProductTourContext } from "@/context/ProductTourContext"

const link = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-2 py-1.5 text-sm ${isActive ? "bg-accent font-medium" : "hover:bg-accent/60"}`

export function OrgSidebar() {
  const { orgs, activeOrg, activeOrgId, isAllOrgs } = useActiveOrg()
  const isAdmin = !isAllOrgs && (activeOrg?.role.level ?? 0) >= 600
  // Platform-operator (site-wide admin) — separate axis from the org role.
  const { isAdmin: isPlatformAdmin } = usePlatformAdmin()
  const { openTour } = useProductTourContext()

  // FRO-474: project-only invitees (direct project_members grant, no org
  // membership for that project) have no org-scoped nav surface to reach
  // their project. List those projects here — same "Shared with you" partition
  // used on the dashboard (FRO-335/FRO-428) — so they always have a way in.
  const { projects: accessibleProjects } = useProjectsForNavigation()
  const sharedProjects = partitionSharedProjects(accessibleProjects, orgs, activeOrgId).sharedWithMe

  const handleTour = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    openTour()
  }, [openTour])

  return (
    <div className="flex h-full min-w-0 flex-col gap-1 overflow-hidden p-2">
      <div data-tour="org-switcher">
        <OrgSwitcher />
      </div>
      <nav className="mt-2 flex flex-1 flex-col gap-0.5">
        {/* FRO-243: data-tour anchors for product tour steps */}
        <NavLink
          to={{ pathname: "/", search: isAllOrgs ? "?org=all" : activeOrgId != null ? `?org=${activeOrgId}` : "" }}
          end
          className={link}
          data-tour="nav-overview"
        >
          Projects
        </NavLink>
        {!isAllOrgs && <>
          <NavLink to="/teams" className={link}>Teams</NavLink>
          <NavLink to="/assigned" className={link} data-tour="nav-assigned">Assigned to me</NavLink>
        </>}
        {isAdmin && <>
          <div className="my-1 border-t" />
          <NavLink to="/members" className={link}>Members</NavLink>
          <NavLink to="/projects/archived" className={link}>Archived</NavLink>
          <NavLink to="/settings" className={link} data-tour="nav-settings">Settings</NavLink>
        </>}
        {isPlatformAdmin && <>
          <div className="my-1 border-t" />
          <NavLink to="/admin" className={link}>Admin</NavLink>
        </>}
        {sharedProjects.length > 0 && (
          <>
            <div className="my-1 border-t" />
            <p className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
              Shared with you
            </p>
            {sharedProjects.map((p) => (
              <NavLink
                key={p.id}
                to={`/projects/${p.id}`}
                className={link}
                title={p.name}
              >
                <span className="block truncate">{p.name}</span>
              </NavLink>
            ))}
          </>
        )}
      </nav>
      <div className="mt-auto pt-2 flex flex-col gap-1">
        {/* FRO-243: Re-launch product tour */}
        <AppTooltip content="Take the product tour">
          <button
            type="button"
            onClick={handleTour}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
          >
            <Map className="h-3.5 w-3.5" aria-hidden />
            Take the tour
          </button>
        </AppTooltip>
        <HelpMenu />
        <div data-tour="account-switcher">
          <AccountSwitcher variant="sidebar" />
        </div>
      </div>
    </div>
  )
}
