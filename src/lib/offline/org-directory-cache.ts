// Desktop: the org lists a user last loaded online, so starting the app with no
// connection still gets them from the org switcher to a downloaded project.
//
// The org routes gate on `listMyOrgs` and the project directory, both
// server-only; offline they failed and every org page was a dead end. This
// keeps the last good answer per user and per device (localStorage) — a
// convenience, not data: losing it just means the offline org pages are
// unavailable, as before. Only read when the server can't be reached.
import type { OrgSummary } from "@/lib/frontier/orgs"

export interface CachedGuestOrg {
  id: number
  name: string | null
}

export interface OrgDirectoryCache {
  orgs: OrgSummary[]
  guestOrgs: CachedGuestOrg[]
}

const storageKey = (username: string) => `aquilla.offline.orgDirectory.${username}`

export function rememberOrgDirectory(username: string, directory: OrgDirectoryCache): void {
  try {
    localStorage.setItem(storageKey(username), JSON.stringify(directory))
  } catch {
    /* storage unavailable — the org pages just won't open offline */
  }
}

export function readOrgDirectory(username: string): OrgDirectoryCache | null {
  try {
    const raw = localStorage.getItem(storageKey(username))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<OrgDirectoryCache> | null
    if (!Array.isArray(parsed?.orgs) || !Array.isArray(parsed.guestOrgs)) return null
    const orgs = parsed.orgs.filter(
      (org): org is OrgSummary => typeof org?.id === "number" && typeof org.role?.level === "number",
    )
    const guestOrgs = parsed.guestOrgs
      .filter((org): org is CachedGuestOrg => typeof org?.id === "number")
      .map((org) => ({ id: org.id, name: typeof org.name === "string" ? org.name : null }))
    return { orgs, guestOrgs }
  } catch {
    return null
  }
}
