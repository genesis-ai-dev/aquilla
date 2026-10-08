// AQU-581: the two database checks behind the lane-delegate carve-out in
// authorize.ts. The carve-out itself (org setting + the caller's own lane
// scopes) is pure; these are the parts that need to look at somebody else.
//
// Both FAIL CLOSED: a query error refuses the event. The carve-out admits a
// member who is below the org's assignment floor, so an unreadable row must
// never read as permission. Leads and above never reach these checks.

import { ROLE } from './role-policy'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import { laneScopeAdmitsTag } from '../../../src/lib/lanes/scope-ids'
import type { LaneIdentity } from '../../../src/lib/lanes/read-wall'

type Scope = { kind: 'lane' | 'file'; value: string }

/**
 * AQU-1607: `lanes` are the project's target lanes, so a scope holding a
 * lane id is read as that lane. An empty list falls back to comparing the
 * stored value to the tag, which is what a scope meant before lane ids.
 */
function coveredBy(
  scopes: ReadonlyArray<Scope>,
  lane: string,
  fileIds: ReadonlyArray<string>,
  lanes: readonly LaneIdentity[],
): boolean {
  const laneScopes = scopes.filter((s) => s.kind === 'lane').map((s) => s.value)
  if (laneScopes.length > 0 && !laneScopeAdmitsTag(laneScopes, lanes, lane)) return false
  const fileScopes = scopes.filter((s) => s.kind === 'file').map((s) => s.value)
  if (fileScopes.length > 0 && !fileIds.every((id) => fileScopes.includes(id))) return false
  return true
}

/**
 * Whether a lane delegate may hand this work to `assigneeUserId`: the
 * assignee must be able to do it. That means CONTRIBUTOR or above on the
 * project (a Viewer or Reviewer cannot translate), and — when the assignee is
 * scoped themselves — scoped to the assignment's lane and every file in it.
 * Without this a Spanish coordinator could give Spanish chapters to a member
 * who is only allowed to work in German, and the work would sit there
 * un-doable.
 */
export async function isEligibleLaneAssignee(
  db: AquillaDb,
  projectId: string,
  assigneeUserId: number,
  lane: string,
  fileIds: ReadonlyArray<string>,
  /** AQU-1607: the project's target lanes — see `coveredBy`. */
  lanes: readonly LaneIdentity[] = [],
): Promise<boolean> {
  try {
    const [role, scopes] = await Promise.all([
      resolveProjectRoleShared(db, { id: String(assigneeUserId) }, projectId),
      db
        .prepare('SELECT kind, value FROM project_member_scopes WHERE project_id = ? AND user_id = ?')
        .bind(projectId, assigneeUserId)
        .all<Scope>(),
    ])
    if (!role || role.level < ROLE.CONTRIBUTOR) return false
    return coveredBy(scopes.results ?? [], lane, fileIds, lanes)
  } catch (err) {
    console.warn(`[lane-delegate] assignee check failed for project=${projectId}; refusing:`, err)
    return false
  }
}

/**
 * Whether a lane delegate may REMOVE this assignment: only one they handed out
 * themselves, still open, in a lane (and, if they are file-scoped, files) they
 * still hold. Without this a coordinator's mistake could only be undone by a
 * lead, and assigning again made a duplicate.
 */
export async function isOwnLaneAssignment(
  db: AquillaDb,
  projectId: string,
  assignmentId: string,
  callerUserId: number,
  callerScopes: ReadonlyArray<Scope>,
  /** AQU-1607: the project's target lanes — see `coveredBy`. */
  lanes: readonly LaneIdentity[] = [],
): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        'SELECT a.created_by, COALESCE(l.legacy_tag, \'\') AS target_lang, a.unassigned_at FROM assignments a LEFT JOIN lanes l ON l.project_id = a.project_id AND l.id = a.lane_id WHERE a.assignment_id = ? AND a.project_id = ?',
      )
      .bind(assignmentId, projectId)
      .first<{ created_by: number | string; target_lang: string | null; unassigned_at: number | null }>()
    if (!row || row.unassigned_at != null) return false
    if (String(row.created_by) !== String(callerUserId)) return false
    // The caller must hold the lane — a coordinator moved off Spanish loses
    // the Spanish assignments they handed out along with the lane.
    const laneScopes = callerScopes.filter((s) => s.kind === 'lane').map((s) => s.value)
    if (!laneScopeAdmitsTag(laneScopes, lanes, row.target_lang ?? '')) return false
    if (!callerScopes.some((s) => s.kind === 'file')) return true
    const files = await db
      .prepare('SELECT DISTINCT file_id FROM assignment_cells WHERE assignment_id = ?')
      .bind(assignmentId)
      .all<{ file_id: string }>()
    return coveredBy(callerScopes, row.target_lang ?? '', (files.results ?? []).map((f) => f.file_id), lanes)
  } catch (err) {
    console.warn(`[lane-delegate] assignment lookup failed for ${assignmentId}; refusing:`, err)
    return false
  }
}
