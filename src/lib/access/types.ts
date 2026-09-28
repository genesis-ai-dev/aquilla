/**
 * AQU-1352 (spec §3.7–3.9): wire shape for the member-access read,
 * `GET /api/v2/users/:id/access?from=<scopeType>:<scopeId>`. The inspector,
 * the People & access person view and the audit export all render this one
 * payload, so they cannot disagree. Origins are server-derived; the client
 * never recomputes inheritance (spec §3.7 rule 1).
 */

/** The four scopes of the hierarchy, outermost first. */
export type ScopeType = "org" | "team" | "project" | "lane"

/** One crumb of a scope path. `name` is the display name the server resolved. */
export interface ScopeRef {
  type: ScopeType
  id: string
  name: string
  /**
   * Spec §3.9 rule 4: an ancestor the viewer may not see. The server sends a
   * placeholder `name` (never the real one); formatScopePath renders "…".
   */
  hidden?: true
}

/** Outermost → innermost, e.g. org › team › project › lane. */
export type ScopePath = ScopeRef[]

/**
 * Why a grant applies here. `from` is the scope the grant actually lives at —
 * required in practice for `inherited`, so the UI can say "Set at <path>".
 */
export interface GrantOrigin {
  kind: "direct" | "inherited" | "creator" | "platform"
  from?: ScopePath
}

/** One grant contributing to (or held outside) the scope being inspected. */
export interface AccessChainEntry {
  scopePath: ScopePath
  /** Ladder level (src/lib/frontier/roles.ts). `null` = member with no access
   *  at this scope (e.g. an org Member below the org-wide access floor). */
  roleLevel: number | null
  origin: GrantOrigin
  /** Display name of whoever made the grant. */
  grantedBy?: string
  /** ISO-8601 timestamp. */
  grantedAt?: string
  /** Org/team containers only: how many projects under this scope hold a grant
   *  the viewer can see (spec §3.8 rule 1, "▸ 3 projects"). */
  descendantCount?: number
}

export interface MemberAccess {
  userId: string
  displayName: string
  isGuest: boolean
  effectiveHere: {
    roleLevel: number | null
    /** Contributing grants, highest role first (server-ordered). */
    chain: AccessChainEntry[]
  }
  /** Every other grant the viewer may see (spec §3.8 rule 4). */
  elsewhere: AccessChainEntry[]
}
