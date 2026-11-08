// The project membership roster for the Agent API (AQU-2403).
//
// AQU-1185 shipped InviteMember / SetRole / RemoveMember but no way to READ
// who is on a project, so an agent had to guess a username and learn the
// answer from a `conflict`: `already_member` meant "there is a direct row",
// `not_a_direct_member` meant "there isn't". Probing a governance surface for
// its own state is how you end up staging a change nobody asked for, so the
// roster is a first-class read.
//
// Two properties this read exists to carry, both of which the membership
// commands' error codes were standing in for:
//
//   1. `role` is the EFFECTIVE (max-wins) level — the same number the target
//      cap in commands-membership.ts compares against, so a maintainer can see
//      in advance whom they may not touch.
//   2. `direct` says whether there is a `project_members` row. That is what
//      picks the command: a direct member is re-roled with SetRole, somebody
//      who holds the project through the org, a team, or being its creator is
//      granted a row with InviteMember (SetRole would be rejected), and
//      RemoveMember only ever drops the direct row (AD-12: the other paths are
//      additive and keep conferring access).
//
// Floor: MAINTAINER, the same floor as managing membership. A roster is the
// read half of governance, not general project data — a contributor has no
// business enumerating their colleagues through a machine credential.
//
// Identity: usernames pass through at face value, deliberately NOT subject to
// the pii.ts authorship policy. That policy protects translators whose names
// appear as the *author* of content (docs/OPSEC.md); the membership commands at
// this same floor already take and echo real usernames, and a pseudonymised
// roster could not be fed back into SetRole, which is the only reason to read
// it. The floor, not scrubbing, is the control here.

import { loadProjectGrantsForAllUsers, resolveFromGrants } from '../../../db/shared/access-grants'
import { ROLE, roleLabel } from '../events/role-policy'
import type { ResolvedSource } from '../../../db/shared/access-grants'

/** The role floor for reading the roster. Mirrors MEMBERSHIP_FLOOR in
 *  commands-membership.ts — read and write halves of the same governance
 *  surface, pinned equal by a test. */
export const MEMBERS_READ_FLOOR = ROLE.MAINTAINER

/** Most roster rows one response carries. The read has no cursor — a project
 *  roster is a governance list, not a content feed — so instead of paging it
 *  reports `total` and `truncated` and the caller narrows at the org level. An
 *  org with thousands of members owns every one of its projects through the org
 *  path, so without a cap one project read would serialize the whole workspace
 *  into an MCP text payload. */
export const MEMBERS_MAX_ROWS = 500

export interface ProjectMemberRow {
  userId: string
  username: string
  /** Effective (max-wins) level, exactly as the membership gates resolve it. */
  role: number
  roleName: string
  /** Winning grant path: override (a direct row) | group | org | creator. */
  roleSource: ResolvedSource
  /** True iff a `project_members` row exists — SetRole / RemoveMember need one. */
  direct: boolean
}

/**
 * Resolve the project's whole roster in two statements plus one username read.
 *
 * Every candidate's level comes from `resolveFromGrants`, the same pure
 * max-wins resolver (and the same `orgPathContribution` rule) that
 * `resolveProjectRoleShared` applies per caller, so the roster cannot disagree
 * with the gate that will judge the command built from it.
 *
 * Platform admins are NOT synthesised into the list: the allowlist is an
 * operator backstop, not a membership, and nothing on this surface can grant
 * or remove it.
 *
 * Null when the project does not exist.
 */
export async function listProjectMembers(
  db: AquillaDb,
  projectId: string,
): Promise<{ members: ProjectMemberRow[]; total: number; truncated: boolean } | null> {
  const loaded = await loadProjectGrantsForAllUsers(db, projectId)
  if (!loaded) return null

  const resolved: { userId: string; role: number; roleSource: ResolvedSource; direct: boolean }[] = []
  for (const [userId, grants] of loaded.byUser) {
    const role = resolveFromGrants(grants, {
      projectId,
      orgId: loaded.orgId,
      archivedAt: loaded.archivedAt,
      // Archival never blanks the list. The route in front of this cannot
      // currently be reached on an archived project at all — the caller's own
      // role resolves to null there, so the scope gate refuses first — but if
      // it ever can, an archived project must report the members it still has
      // rather than [], because membership is not cleared by archiving and an
      // empty roster reads as "nobody is on this project".
      includeArchived: true,
      attachedTeamIds: loaded.attachedTeamIds,
      isPlatformAdmin: false,
    })
    // null = every path contributed nothing (e.g. a sub-maintainer org member
    // with no other way in, per AQU-435). They are not a member of this project.
    if (!role) continue
    resolved.push({
      userId,
      role: role.level,
      roleSource: role.source,
      direct: role.chain.some((link) => link.source === 'override'),
    })
  }
  const total = resolved.length
  if (total === 0) return { members: [], total, truncated: false }

  // Sort BEFORE the cap so a truncated roster is the top of the ladder — the
  // people a membership command can actually be aimed at — not an arbitrary
  // slice. Usernames are not loaded yet, so the tie-break on equal roles is
  // applied again after they are.
  resolved.sort((a, b) => b.role - a.role)
  const truncated = total > MEMBERS_MAX_ROWS
  if (truncated) resolved.length = MEMBERS_MAX_ROWS

  const marks = resolved.map(() => '?').join(', ')
  const names = await db
    .prepare(`SELECT id::text AS id, username FROM users WHERE id IN (${marks})`)
    .bind(...resolved.map((r) => r.userId))
    .all<{ id: string; username: string }>()
  const byId = new Map((names.results ?? []).map((r) => [String(r.id), r.username]))

  const members = resolved
    // A grant row whose user has since been deleted is a dangling row, not a
    // member — dropping it keeps the roster to people SetRole could name.
    .flatMap((r) => {
      const username = byId.get(r.userId)
      if (username === undefined) return []
      return [{ ...r, username, roleName: roleLabel(r.role) }]
    })
    .sort((a, b) => (a.role !== b.role ? b.role - a.role : a.username.localeCompare(b.username)))
  return { members, total, truncated }
}
