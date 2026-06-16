import { useLocation, useNavigate } from "react-router-dom"
import { useActiveOrg } from "@/context/OrgContext"
import { isOrgScopedRoute } from "./org-route-scope"

export function OrgBreadcrumb({ section }: { section: string }) {
  const { activeOrg, isAllOrgs, orgs, setAllOrgs } = useActiveOrg()
  const location = useLocation()
  const navigate = useNavigate()
  const label = isAllOrgs ? "All organizations" : activeOrg?.name ?? "Workspace"

  function handleAllOrgs() {
    setAllOrgs()
    if (isOrgScopedRoute(location.pathname)) navigate("/")
  }

  return (
    <div className="flex items-center gap-1 px-3 py-2 text-sm text-muted-foreground">
      {orgs.length > 1 && !isAllOrgs && (
        <>
          <button
            type="button"
            onClick={handleAllOrgs}
            className="font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            All organizations
          </button>
          <span>›</span>
        </>
      )}
      <span className="font-medium text-foreground">{label}</span>
      <span>›</span>
      <span>{section}</span>
    </div>
  )
}
