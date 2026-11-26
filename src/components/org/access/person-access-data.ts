/**
 * AQU-2323: wire shape + read for the person inspector,
 * GET /api/v2/orgs/:orgId/access/people/:userId
 * (auth-worker/src/routes/org-access-person.ts). The server already cut the
 * answer down to the places this viewer's lenses show; the client never
 * recomputes a role.
 */
import { FRONTIER_API_URL } from "@/lib/sync/sync-token"
import { UserError } from "@/lib/errors/user-error"
import type { GrantRef } from "@/lib/access/edit-access"
import type { ScopeRef, ScopeType } from "@/lib/access/types"

export interface PersonPlaceRole {
  roleLevel: number
  kind: "direct" | "inherited" | "creator"
  /** Inherited only. `hidden` when the viewer cannot see that place. */
  via: ScopeRef | null
  /** Other paths that give the same rung here. */
  alsoVia: ScopeRef[]
  /** The direct grant here adds nothing over the other paths. */
  redundantDirect: boolean
}

export interface PersonPlaceNode {
  scope: ScopeRef
  role: PersonPlaceRole
  children: PersonPlaceNode[]
}

export type PlaceCounts = Record<ScopeType, number>

export interface PersonGrantCard {
  grant: GrantRef
  path: ScopeRef[]
  roleLevel: number
  source: "direct" | "creator"
  grantedBy: string | null
  grantedByUserId: string | null
  grantedAt: string | null
  /** The places whose role would change without this grant. */
  gives: PlaceCounts
  redundant: boolean
}

export interface PersonHistoryEntry {
  kind: "granted" | "changed" | "removed"
  at: string
  by: string | null
  path: ScopeRef[]
  roleBefore: number | null
  roleAfter: number | null
}

export interface PersonAccessPayload {
  person: {
    userId: string
    displayName: string
    username: string | null
    email: string | null
    isGuest: boolean
    lastActiveAt: string | null
  }
  counts: { grants: number; projects: number }
  tree: PersonPlaceNode[]
  noAccess: { places: { scope: ScopeRef; path: ScopeRef[] }[]; counts: PlaceCounts }
  grants: PersonGrantCard[]
  history: PersonHistoryEntry[]
}

export async function fetchPersonAccess(jwt: string, orgId: number, userId: string, apiUrl: string = FRONTIER_API_URL): Promise<PersonAccessPayload> {
  const res = await fetch(`${apiUrl}/api/v2/orgs/${orgId}/access/people/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) throw new UserError(res.status, await res.text().catch(() => ""), "project")
  return (await res.json()) as PersonAccessPayload
}
