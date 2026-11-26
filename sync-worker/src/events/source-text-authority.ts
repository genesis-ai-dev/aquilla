// AQU-2647: the source-text floor at the events perimeter.
//
// source.cell.commit and source.cell.visibility.set share it. The static role
// table sits at Contributor, the lowest rung the setting can admit, so a
// person the project has allowed is not refused before this check runs. The
// check then applies the tier actually in force (default Maintainer).
//
// A lane grant counts on any language lane: source text is shared. The
// retiring project role counts too, because authority is the higher of the
// two. Fail closed: an unreadable setting, or no database, is Maintainer.

import { loadLaneGrants } from '../../../db/shared/lane-visibility'
import {
  DEFAULT_SOURCE_TEXT_FLOOR,
  effectiveSourceTextFloor,
  meetsSourceTextFloor,
  sourceTextAuthorityLevel,
} from '../../../db/shared/source-text-floor'
import { makeRequestCache, type RequestCache } from './request-cache'

const MAINTAINER = 600

export function isSourceTextEditKind(kind: string): boolean {
  return kind === 'source.cell.commit' || kind === 'source.cell.visibility.set'
}

export async function effectiveSourceTextFloorLevel(
  db: AquillaDb | null,
  projectId: string,
  cache?: RequestCache,
): Promise<number> {
  if (!db) return DEFAULT_SOURCE_TEXT_FLOOR
  try {
    const lookup = cache ?? makeRequestCache(db)
    const project = await lookup.writePathSettings(projectId)
    const orgId = await lookup.projectOrgId(projectId)
    const org = orgId != null ? await lookup.orgSettings(orgId) : null
    return effectiveSourceTextFloor(project?.sourceTextFloor, org?.sourceTextFloor)
  } catch {
    return DEFAULT_SOURCE_TEXT_FLOOR
  }
}

/**
 * Clearance for this caller. An explicit `laneGrants` claim is the answer
 * (an empty list is "none"). A token that omits the claim — the external API
 * does — is filled from project_member_lane_roles when the project role is
 * below Maintainer, the only case a grant could still meet the floor.
 */
export async function sourceTextAuthorityForClaims(
  db: AquillaDb | null,
  projectId: string,
  claims: { role: number; userId: number; laneGrants?: Array<{ level: number }> | null },
): Promise<number> {
  let laneLevels = (claims.laneGrants ?? []).map((grant) => grant.level)
  if (db && claims.laneGrants == null && claims.role < MAINTAINER) {
    try {
      const grants = await loadLaneGrants(db, projectId, claims.userId)
      laneLevels = grants.map((grant) => grant.level)
    } catch {
      laneLevels = []
    }
  }
  return sourceTextAuthorityLevel({ projectRole: claims.role, laneLevels })
}

export function sourceTextEditRefusal(authority: number, floor: number, kind: string): string | null {
  if (meetsSourceTextFloor(authority, floor)) return null
  return `role too low to edit source text (${kind})`
}

/**
 * Prepare-time answer for a plan that would commit one of these kinds. The
 * external token omits lane grants, so a grant stored on the project counts.
 * Null when the plan does not edit source text.
 */
export async function sourceTextPrepareRefusal(
  db: AquillaDb,
  projectId: string,
  caller: { role: number; userId: number },
  kinds: readonly string[],
): Promise<string | null> {
  const kind = kinds.find((candidate) => isSourceTextEditKind(candidate))
  if (!kind) return null
  const authority = await sourceTextAuthorityForClaims(db, projectId, {
    role: caller.role,
    userId: caller.userId,
    laneGrants: null,
  })
  const floor = await effectiveSourceTextFloorLevel(db, projectId)
  return sourceTextEditRefusal(authority, floor, kind)
}
