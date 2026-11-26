import { useEffect } from "react"
import { useActiveOrg } from "@/context/OrgContext"
import type { OrgSummary } from "@/lib/frontier/orgs"

interface OrgLookupResult {
  org: OrgSummary | null
  /** The answer is not in yet: hold the org's place rather than skip it. */
  pending: boolean
}

const NOT_LOOKED_UP: OrgLookupResult = { org: null, pending: false }

/**
 * Name an org the caller can open without belonging to it — one a platform
 * admin reaches through the switcher catalog. Such an org is in neither
 * `orgs` (memberships) nor `guestOrgs` (project grants), which is all the org
 * context loads at boot, so chrome that names an org by id asks for it here.
 *
 * Answers nothing for a membership or a guest org: the context already has
 * those, and a guest org must not be presented as a membership. It does not
 * ask until both directories have loaded, because until then a guest org looks
 * exactly like an org that is in neither.
 */
export function useOrgLookup(orgId: number | null | undefined): OrgLookupResult {
  const { orgs, guestOrgs, isLoading, accessibleProjectsLoading, lookedUpOrg, requestOrgLookup } = useActiveOrg()
  const listed =
    orgId == null || orgs.some((org) => org.id === orgId) || guestOrgs.some((org) => org.id === orgId)
  const lookupId = listed ? null : orgId
  const canAsk = !isLoading && !accessibleProjectsLoading

  useEffect(() => {
    if (lookupId != null && canAsk) requestOrgLookup(lookupId)
  }, [lookupId, canAsk, requestOrgLookup])

  if (lookupId == null) return NOT_LOOKED_UP
  const answer = lookedUpOrg(lookupId)
  return { org: answer ?? null, pending: answer === undefined }
}
