import { NavLink } from "react-router-dom"
import { useActiveOrg } from "@/context/OrgContext"
import { OrgSwitcher } from "./OrgSwitcher"
import { AccountSwitcher } from "@/components/AccountSwitcher"

const link = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-2 py-1.5 text-sm ${isActive ? "bg-accent font-medium" : "hover:bg-accent/60"}`

export function OrgSidebar() {
  const { activeOrg } = useActiveOrg()
  const isAdmin = (activeOrg?.role.level ?? 0) >= 600
  return (
    <div className="flex h-full flex-col gap-1 p-2">
      <OrgSwitcher />
      <nav className="mt-2 flex flex-1 flex-col gap-0.5">
        <NavLink to="/" end className={link}>Overview</NavLink>
        <NavLink to="/projects" className={link}>Projects</NavLink>
        <NavLink to="/teams" className={link}>Teams</NavLink>
        {isAdmin && <>
          <div className="my-1 border-t" />
          <NavLink to="/members" className={link}>Members</NavLink>
          <NavLink to="/settings" className={link}>Settings</NavLink>
        </>}
      </nav>
      <div className="mt-auto pt-2 border-t">
        <AccountSwitcher variant="sidebar" />
      </div>
    </div>
  )
}
