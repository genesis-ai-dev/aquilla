// Changeset authority for the session surface (command registry P1 §2.3).
//
// P0 gated list/get/commit/discard on `created_by_user_id === token user`. That
// made every plan a private object: the one person who ran the agent was the
// only person who could act on it, and a lead could not clear a teammate's
// inbox. P1 replaces the identity rule with a CAPABILITY rule —
//
//   a caller may act on a changeset when their LIVE project role is at or above
//   the changeset's required floor,
//
// where the floor is `max(requiredRoleForCommand)` over the STORED commands.
// The floor function is the single source of truth (commands.ts); nothing here
// re-derives it. The creator normally passes, because prepare enforced the same
// floor at staging time; a creator whose role has since dropped does not, which
// is the point of resolving the role live rather than trusting the stored one.
//
// This widens WHO may approve, never WHETHER approval is required: commit still
// consumes an unconsumed ask-mode confirmation, and no agent surface can mint
// one.

import { requiredRoleForCommand, type Command } from './commands'
import { isOrgMemberCommand } from './commands-org-members'
import { errorResponse } from './errors'
import type { StoredChangeset } from './types'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'

/** The floor a caller must hold to act on this plan — max over its commands. */
export function requiredFloorForChangeset(commands: readonly Command[]): number {
  if (commands.length === 0) return 0
  return Math.max(...commands.map(requiredRoleForCommand))
}

/** True when a plan keeps the creator rule instead of the project-role floor.
 *  Both cases are ORG-level authority re-checked in the commit handler, with no
 *  project role to resolve against: CreateProject's target project may not
 *  exist yet, and an org-membership plan (AQU-1235) does not concern the
 *  project it is merely filed under. A floor would deny everyone, the person
 *  who staged the plan included. */
function isCreatorScoped(commands: readonly Command[]): boolean {
  return commands.some((c) => c.kind === 'CreateProject' || isOrgMemberCommand(c))
}

/**
 * Authority check for one changeset. Returns the denial Response, or null when
 * the caller may act. Non-members are always denied — no role resolves, so no
 * floor is met.
 */
export async function changesetAuthorityDenied(
  db: AquillaDb,
  cs: StoredChangeset,
  cred: ApiCredentialContext,
): Promise<Response | null> {
  if (isCreatorScoped(cs.commands)) {
    if (String(cs.createdByUserId) === String(cred.userId)) return null
    return errorResponse('permission_denied', 'only the changeset creator may access it')
  }
  const floor = requiredFloorForChangeset(cs.commands)
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, cs.projectId)
  if (!role || role.level < floor) {
    return errorResponse('permission_denied', 'insufficient project role for this changeset', {
      requiredRole: floor,
    })
  }
  return null
}

/** Visibility filter for a list of changesets — the same rule, applied in
 *  memory against one already-resolved role level (the caller's). */
export function visibleAtRole(cs: StoredChangeset, roleLevel: number, userId: string): boolean {
  if (isCreatorScoped(cs.commands)) return String(cs.createdByUserId) === String(userId)
  return roleLevel >= requiredFloorForChangeset(cs.commands)
}
