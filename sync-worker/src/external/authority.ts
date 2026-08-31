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
// where the floor is `max(requiredRoleForCommand)` over the STORED commands,
// with the current org assignment floor supplied for assignment EmitEvents.
// The creator normally passes because prepare enforced the same floor; a
// creator whose role or org policy has since changed is re-checked live.
//
// This widens WHO may approve, never WHETHER approval is required: commit still
// consumes an unconsumed ask-mode confirmation, and no agent surface can mint
// one.

import {
  commandsContainAssignmentEvents,
  requiredRoleForCommand,
  type Command,
} from './commands'
import { errorResponse } from './errors'
import type { StoredChangeset } from './types'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import {
  DEFAULT_ASSIGNMENT_MIN_ROLE,
  resolveAssignmentAuthority,
} from '../events/assignment-authority'

/** The floor a caller must hold to act on this plan — max over its commands. */
export function requiredFloorForChangeset(
  commands: readonly Command[],
  assignmentMinRole: number = DEFAULT_ASSIGNMENT_MIN_ROLE,
): number {
  if (commands.length === 0) return 0
  return Math.max(
    ...commands.map((command) => requiredRoleForCommand(command, assignmentMinRole)),
  )
}

/** True when a CreateProject plan keeps the creator rule: its authority is
 *  org-level (re-checked in the commit handler) and its target project may not
 *  exist yet, so no project role can be resolved against it. */
function isProjectCreation(commands: readonly Command[]): boolean {
  return commands.some((c) => c.kind === 'CreateProject')
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
  if (isProjectCreation(cs.commands)) {
    if (String(cs.createdByUserId) === String(cred.userId)) return null
    return errorResponse('permission_denied', 'only the changeset creator may access it')
  }
  const assignmentMinRole = commandsContainAssignmentEvents(cs.commands)
    ? (await resolveAssignmentAuthority(db, cs.projectId)).minRole
    : DEFAULT_ASSIGNMENT_MIN_ROLE
  const floor = requiredFloorForChangeset(cs.commands, assignmentMinRole)
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
export function visibleAtRole(
  cs: StoredChangeset,
  roleLevel: number,
  userId: string,
  assignmentMinRole: number = DEFAULT_ASSIGNMENT_MIN_ROLE,
): boolean {
  if (isProjectCreation(cs.commands)) return String(cs.createdByUserId) === String(userId)
  return roleLevel >= requiredFloorForChangeset(cs.commands, assignmentMinRole)
}
