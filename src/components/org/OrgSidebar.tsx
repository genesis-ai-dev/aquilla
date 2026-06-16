import { useCallback } from "react"
import { NavLink } from "react-router-dom"
import { Map } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { useActiveOrg } from "@/context/OrgContext"
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin"
import { OrgSwitcher } from "./OrgSwitcher"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { useProductTourContext } from "@/context/ProductTourContext"

const link = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-2 py-1.5 text-sm ${isActive ? "bg-accent font-medium" : "hover:bg-accent/60"}`

export function OrgSidebar() {
  const { activeOrg, isAllOrgs } = useActiveOrg()
  const isAdmin = !isAllOrgs && (activeOrg?.role.level ?? 0) >= 600
  // Platform-operator (site-wide admin) — separate axis from the org role.
  const { isAdmin: isPlatformAdmin } = usePlatformAdmin()
  const { openTour } = useProductTourContext()

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
        <NavLink to="/" end className={link} data-tour="nav-overview">Overview</NavLink>
        <NavLink to="/projects" className={link} data-tour="nav-projects">Projects</NavLink>
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
      </nav>
      <div className="mt-auto pt-2 border-t flex flex-col gap-1">
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
        <div data-tour="account-switcher">
          <AccountSwitcher variant="sidebar" />
        </div>
      </div>
    </div>
  )
}
