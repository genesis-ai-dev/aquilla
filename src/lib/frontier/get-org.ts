import { FRONTIER_BASE } from "./auth"
import { fetchWithTimeout, type OrgSummary } from "./orgs"
import { UserError } from "@/lib/errors/user-error"

/**
 * GET /api/v2/orgs/:orgId — membership or platform-admin catalog row.
 * Returns null on 404/403 so OrgContext can leave chrome on the guest/unknown
 * path instead of failing the whole org load.
 */
export async function getOrg(jwt: string, orgId: number): Promise<OrgSummary | null> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (res.status === 404 || res.status === 403) return null
  if (!res.ok) throw new UserError(res.status, "", "org")
  return (await res.json()) as OrgSummary
}
