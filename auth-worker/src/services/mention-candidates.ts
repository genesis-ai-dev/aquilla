// AQU-1815: who a comment author may @-mention.
//
// The comment composer's @mention picker used to be fed by the project
// roster, which the org's rosterViewMinRole (AQU-485) hides from everyone
// below the effective floor — Project Lead under the shipped defaults, since
// AQU-1308 lowered it to the assignment floor. A Contributor therefore saw
// "No one on this project to mention" while sharing a lane with half the
// team, and a mention is only stored when a suggestion is picked, so there
// was no typed workaround either.
//
// The rule is the one AQU-1308 applied to the assignee picker: you cannot
// address someone you cannot name. A caller the org lets read the roster
// gets the roster. Everyone else gets the people they already work beside —
// members holding a lane grant on any lane the caller holds one on — plus
// Maintainer and above, the "view admins" set the roster endpoint's
// ?minRole= bypass already discloses. Nothing below Maintainer outside the
// caller's lanes is named, so AQU-485's safe-by-default promise holds.
//
// Usernames and ids only. A mention is addressed by username, and the roster
// floor exists precisely so below-floor callers do not learn emails.

import { ROLE, type Env } from "../types"

export interface MentionCandidate {
  userId: number
  username: string
}

export interface MentionCandidatesResponse {
  candidates: MentionCandidate[]
  /** True when the list is the lane-scoped subset rather than the roster. */
  restricted: boolean
}

interface RosterRow {
  userId: number
  username: string
  roleLevel: number
}

/**
 * Users who hold a lane grant on at least one lane the caller holds one on
 * (`project_member_lane_roles`, AQU-1389). Includes the caller when they
 * have any grant; empty when they have none — a member the lane-grant
 * backfill skipped (AQU-1799) still gets Maintainer and above from
 * `selectMentionCandidates`, never a 403.
 */
export async function loadLaneMateIds(env: Env, projectId: string, userId: number): Promise<Set<number>> {
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT DISTINCT other.user_id AS user_id
       FROM project_member_lane_roles mine
       JOIN project_member_lane_roles other
         ON other.project_id = mine.project_id AND other.lane = mine.lane
      WHERE mine.project_id = ? AND mine.user_id = ?`,
  )
    .bind(projectId, userId)
    .all<{ user_id: number | string }>()
  return new Set((results ?? []).map((r) => Number(r.user_id)))
}

/**
 * Pure selection over the effective roster. `callerCanViewRoster` is the
 * AQU-1308 effective-floor answer (or true for a project with no org).
 */
export function selectMentionCandidates(opts: {
  members: readonly RosterRow[]
  callerCanViewRoster: boolean
  laneMateIds: ReadonlySet<number>
}): MentionCandidatesResponse {
  const pick = (m: RosterRow): MentionCandidate => ({ userId: Number(m.userId), username: m.username })
  if (opts.callerCanViewRoster) {
    return { candidates: opts.members.map(pick), restricted: false }
  }
  const candidates = opts.members
    .filter((m) => m.roleLevel >= ROLE.MAINTAINER || opts.laneMateIds.has(Number(m.userId)))
    .map(pick)
  return { candidates, restricted: true }
}
