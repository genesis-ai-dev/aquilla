// AQU-2352 (AQU-2351 D-j): an organization role is Member, Maintainer or Owner.
//
//   * Member (100): in the directory. Can be added to teams, projects and
//     lanes, and sees nothing by membership alone.
//   * Maintainer (600): Maintainer of every project and lane in the org.
//   * Owner (700): Maintainer plus the org's governance.
//
// Viewer through Project Lead (200–500) are not stored at org level any more.
// Every writer of `org_members` goes through one of the two helpers below:
// the API routes refuse anything else (`isOrgRoleLevel`), and the importers,
// which carry older role ladders (Codex/GitLab), store the nearest org role
// that gives no more than the source did (`orgRoleForStorage`).
//
// Shared by auth-worker and sync-worker; the SPA mirrors the list in
// src/lib/frontier/roles.ts (ORG_ROLE_LEVELS).

export const ORG_MEMBER = 100
export const ORG_MAINTAINER = 600
export const ORG_OWNER = 700

/** The only levels an org_members row may hold. */
export const ORG_ROLE_LEVELS = [ORG_MEMBER, ORG_MAINTAINER, ORG_OWNER] as const
export type OrgRoleLevel = (typeof ORG_ROLE_LEVELS)[number]

export function isOrgRoleLevel(level: unknown): level is OrgRoleLevel {
  return typeof level === "number" && (ORG_ROLE_LEVELS as readonly number[]).includes(level)
}

/** The refusal text every API surface uses, naming the allowed roles. */
export const ORG_ROLE_REFUSAL =
  "an organization role is Member (100), Maintainer (600) or Owner (700); Viewer through Project Lead are given on lanes"

/**
 * The org role an importer stores for a level from an older ladder: Owner and
 * Maintainer keep their meaning, and anything below Maintainer becomes Member,
 * which is what it already opened (nothing, AQU-435). Never rounds up.
 */
export function orgRoleForStorage(level: number): OrgRoleLevel {
  if (level >= ORG_OWNER) return ORG_OWNER
  if (level >= ORG_MAINTAINER) return ORG_MAINTAINER
  return ORG_MEMBER
}
