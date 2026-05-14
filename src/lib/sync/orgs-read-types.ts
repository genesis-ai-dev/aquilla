// Types for the frontier-server orgs read API (Phase 2b).
// Mirror of `apps/frontier-server/src/routes/orgs.ts`.

export interface OrgRole {
  level: number
  name: string
}

export interface MyOrg {
  id: number
  name: string | null
  role: OrgRole
}

export interface OrgMember {
  userId: number
  username: string
  role: OrgRole
  /** ISO; null when no recent activity. */
  lastActiveAt?: string | null
}

export interface OrgMembersResponse {
  members: OrgMember[]
}
