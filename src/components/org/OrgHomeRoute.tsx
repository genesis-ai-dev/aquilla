import { useActiveOrg } from "@/context/OrgContext"
import { OrgHome } from "./OrgHome"
import { GuestOrgHome } from "./GuestOrgHome"

/**
 * AQU-790: the index element for `/orgs/:orgId`. Owned orgs get the full member
 * dashboard (OrgHome); a guest org — one the caller reaches only via a project
 * grant — gets the reduced guest overview (GuestOrgHome). OrgRouteGate has
 * already resolved the org list (members *and* guest orgs) before this mounts,
 * so `activeGuestOrg` is decided by the time we branch.
 */
export function OrgHomeRoute() {
  const { activeGuestOrg } = useActiveOrg()
  return activeGuestOrg ? <GuestOrgHome /> : <OrgHome />
}
