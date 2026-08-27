import { Navigate } from "react-router-dom"
import { useActiveOrg } from "@/context/OrgContext"

/**
 * Index element for `/orgs/:orgId`.
 * - Guest org → redirect to `/projects` (same table as a member org)
 * - Member org → redirect to `/overview` (stats + rollups)
 */
export function OrgHomeRoute() {
  const { activeGuestOrg, activeOrg, accessibleProjectsLoading } = useActiveOrg()
  if (activeGuestOrg) return <Navigate to="projects" replace />
  if (activeOrg) return <Navigate to="overview" replace />
  // Not a membership. Wait for the project directory — this id may still
  // resolve as a guest org. OrgRouteGate usually holds the outlet until then;
  // keep the same wait here so a first paint cannot bounce guests to Overview.
  if (accessibleProjectsLoading) return null
  return <Navigate to="overview" replace />
}
