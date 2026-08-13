import { Navigate } from "react-router-dom"
import { useActiveOrg } from "@/context/OrgContext"
import { GuestOrgHome } from "./GuestOrgHome"

/**
 * Index element for `/orgs/:orgId`.
 * - Guest org → reduced project list (GuestOrgHome)
 * - Member org → redirect to `/overview` (stats + rollups)
 */
export function OrgHomeRoute() {
  const { activeGuestOrg } = useActiveOrg()
  if (activeGuestOrg) return <GuestOrgHome />
  return <Navigate to="overview" replace />
}
