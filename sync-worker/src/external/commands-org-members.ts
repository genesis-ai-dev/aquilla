// Org-level membership commands (AQU-1235): AddOrgMember, SetOrgRole,
// RemoveOrgMember.
//
// AQU-1185 gives agents PROJECT membership; the create-org-then-staff-it flow
// (CreateProject → this → projects) dead-ends without ORG membership, so these
// three commands stage the same row writes the org roster UI performs
// (auth-worker routes/orgs.ts POST|DELETE /:orgId/members).
//
// Shape of the surface, and why:
//
//   • Receipt-only, like CreateProject/UpdateProjectSettings — a plain row write
//     on org_members, not an event. There is no project projection to move.
//   • ORG-level authority, so like CreateProject these skip the project-scope /
//     project-role gates: the changeset's URL project id is only where the plan
//     is filed. The real gate is the caller's LIVE org role, re-resolved at
//     prepare AND at commit (the D8 live-role pattern).
//   • Ask-mode by construction. Staffing an org is exactly the class of change
//     that must pass a human, so the staged changeset is FORCED to ask
//     regardless of the credential's or the request's mode — same as
//     CreateProject.
//   • Targets are named by USERNAME, never by user id, mirroring the roster UI
//     (AQU-780) and keeping identity out of agent-supplied input (AQU-1180).
//
// Gates mirror the UI exactly, plus the two AQU-285 privilege-hole lessons the
// roster endpoint predates:
//
//   1. OWNER-only        — the AQU-780 rule; add/change/remove all require 700.
//   2. No self-target    — an owner cannot grant/demote/remove themselves
//                          (the UI's self_grant + "owner cannot remove self").
//   3. Target-role cap   — never grant ABOVE the caller's own live org level.
//   4. Last-OWNER guard  — never demote or remove the organizations.owner_user_id
//                          holder, nor the final owner-level member.
//
// Gates 3 and 4's second half are defence in depth rather than live constraints:
// with the caller pinned at OWNER (the ceiling) and self-targeting refused,
// neither can fire today. They are written anyway so the invariants survive the
// owner floor ever being lowered — see org-members-engine.ts for which layer
// actually does the work in each case.
//
// This module owns the STATIC layer only — the command shapes, the kind list,
// and payload validation — and so stays dependency-free apart from role-policy.
// That purity is load-bearing: auth-worker imports the kind list (and, through
// commands.ts, requiredRoleForCommand) for its approval-authority gate, and
// nothing in that graph may reach a sync-worker binding, R2, or a Durable
// Object. The gate/prepare/commit engine lives in org-members-engine.ts, the
// same split commands-emit-events.ts / emit-events-engine.ts uses.

import { ROLE } from '../events/role-policy'

/** Structurally identical to commands.ts's CommandValidationIssue; declared
 *  locally so this module never imports back from commands.ts (the same
 *  no-cycle rule commands-patch-settings.ts follows). */
export interface OrgMemberValidationIssue {
  index: number
  message: string
}

/** Add a user to an org at a given role. Fails if they are already a member —
 *  use SetOrgRole to change an existing member's role. */
export interface AddOrgMemberCommand {
  kind: 'AddOrgMember'
  /** Target org id (numeric, or its string form). */
  orgId: string | number
  /** Target user's username (trimmed; resolved case-insensitively). */
  username: string
  /** Canonical org role level (100…700), capped at the caller's own level. */
  role: number
}

/** Change an existing org member's role. */
export interface SetOrgRoleCommand {
  kind: 'SetOrgRole'
  orgId: string | number
  username: string
  role: number
}

/** Remove a user from an org (and from the org's groups, as the UI does). */
export interface RemoveOrgMemberCommand {
  kind: 'RemoveOrgMember'
  orgId: string | number
  username: string
}

export type OrgMemberCommand =
  | AddOrgMemberCommand
  | SetOrgRoleCommand
  | RemoveOrgMemberCommand

export const ORG_MEMBER_COMMAND_KINDS = ['AddOrgMember', 'SetOrgRole', 'RemoveOrgMember'] as const

export function isOrgMemberCommand(c: { kind: string }): c is OrgMemberCommand {
  return (ORG_MEMBER_COMMAND_KINDS as readonly string[]).includes(c.kind)
}

/** The canonical org role levels, mirroring auth-worker's ALL_ROLE_LEVELS. */
const CANONICAL_ROLE_LEVELS: readonly number[] = [
  ROLE.VIEWER,
  ROLE.COMMENTER,
  ROLE.REVIEWER,
  ROLE.CONTRIBUTOR,
  ROLE.PROJECT_LEAD,
  ROLE.MAINTAINER,
  ROLE.OWNER,
]

/** Level → name, mirroring auth-worker's ROLE_NAMES, for the approval page. */
const ROLE_NAME: Record<number, string> = {
  [ROLE.VIEWER]: 'viewer',
  [ROLE.COMMENTER]: 'commenter',
  [ROLE.REVIEWER]: 'reviewer',
  [ROLE.CONTRIBUTOR]: 'contributor',
  [ROLE.PROJECT_LEAD]: 'project_lead',
  [ROLE.MAINTAINER]: 'maintainer',
  [ROLE.OWNER]: 'owner',
}

/** Human-readable org role for the approval page. */
export function orgRoleName(level: number): string {
  return ROLE_NAME[level] ?? `level ${level}`
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Validate one raw org-membership command. Pushes issues and returns null on
 *  failure, mirroring validatePatchSettingsCommand's contract. */
export function validateOrgMemberCommand(
  c: Record<string, unknown>,
  index: number,
  issues: OrgMemberValidationIssue[],
): OrgMemberCommand | null {
  const kind = c.kind as OrgMemberCommand['kind']
  if (!isNonEmptyString(c.orgId) && typeof c.orgId !== 'number') {
    issues.push({ index, message: `${kind}.orgId must be a string or number` })
    return null
  }
  if (!isNonEmptyString(c.username) || c.username.trim().length === 0) {
    issues.push({ index, message: `${kind}.username must be a non-empty string` })
    return null
  }
  const username = c.username.trim()
  if (kind === 'RemoveOrgMember') {
    return { kind, orgId: c.orgId as string | number, username }
  }
  if (typeof c.role !== 'number' || !CANONICAL_ROLE_LEVELS.includes(c.role)) {
    issues.push({
      index,
      message: `${kind}.role must be one of ${CANONICAL_ROLE_LEVELS.join(', ')}`,
    })
    return null
  }
  return { kind, orgId: c.orgId as string | number, username, role: c.role }
}
