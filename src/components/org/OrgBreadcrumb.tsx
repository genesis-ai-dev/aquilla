import { useLocation, useNavigate } from "react-router-dom"
import { useActiveOrg } from "@/context/OrgContext"
import { isOrgScopedRoute } from "./org-route-scope"

interface OrgBreadcrumbParent {
  label: string
  to: string
}

export function OrgBreadcrumb({ parent, section }: { parent?: OrgBreadcrumbParent; section: string }) {
  const { activeOrg, activeOrgId, isAllOrgs, orgs, setAllOrgs } = useActiveOrg()
  const location = useLocation()
  const navigate = useNavigate()
  const label = isAllOrgs ? "All organizations" : activeOrg?.name ?? "Workspace"
  const canNavigateToOrg = !isAllOrgs && activeOrgId != null && section !== "Projects"
  const showSection = section !== "Projects" || parent != null

  function handleAllOrgs() {
    setAllOrgs()
    if (isOrgScopedRoute(location.pathname) || location.pathname === "/") {
      navigate({ pathname: "/", search: "?org=all" })
    }
  }

  function handleOrg() {
    if (!canNavigateToOrg) return
    navigate({ pathname: "/", search: `?org=${activeOrgId}` })
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
      {orgs.length > 1 && !isAllOrgs && (
        <>
          <button
            type="button"
            onClick={handleAllOrgs}
            className="-mx-1 rounded px-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            All organizations
          </button>
          <span>›</span>
        </>
      )}
      {canNavigateToOrg ? (
        <button
          type="button"
          onClick={handleOrg}
          className="-mx-1 rounded px-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {label}
        </button>
      ) : (
        <span className="font-medium text-foreground">{label}</span>
      )}
      {showSection && <span>›</span>}
      {parent && (
        <>
          <button
            type="button"
            onClick={() => navigate(parent.to)}
            className="-mx-1 rounded px-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {parent.label}
          </button>
          <span>›</span>
        </>
      )}
      {showSection && <span className="font-medium text-foreground">{section}</span>}
    </div>
  )
}
