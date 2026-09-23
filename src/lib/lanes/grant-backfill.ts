/**
 * AQU-730 — which lane grants the backfill should write for one member.
 *
 * DB-free. The daemon (scripts/neon-backfill-lanes.ts) resolves the member's
 * role with resolveProjectRoleShared, loads their kind='lane' scopes and the
 * project's target lanes, then calls planLaneGrants.
 *
 * A row is one person + one lanes.id. The UI shows lanes.name. A language
 * string must not open two lanes: a scope that matches two lanes is skipped,
 * not fanned out. Someone who can already see two lanes gets two rows.
 *
 * Maintainer (600) and above see every lane through their role, so they get
 * no rows. Below Viewer (100) gets none. No lane scopes means today's
 * behavior (every current target lane) and is preserved with one row per
 * lane. A later lane does not pick those rows up.
 */

import { lanesForRequestedTag, type LaneIdentity } from './read-wall'

const MAINTAINER = 600
const VIEWER = 100

export interface PlannedLaneGrant {
  laneId: string
  level: number
}

export interface SkippedLaneScope {
  scope: string
  reason: 'unmatched' | 'ambiguous'
}

export interface LaneGrantPlan {
  grants: PlannedLaneGrant[]
  skipped: SkippedLaneScope[]
}

export function planLaneGrants(input: {
  roleLevel: number
  laneScopes: readonly string[]
  lanes: readonly LaneIdentity[]
}): LaneGrantPlan {
  if (input.roleLevel >= MAINTAINER || input.roleLevel < VIEWER) {
    return { grants: [], skipped: [] }
  }
  if (input.laneScopes.length === 0) {
    return {
      grants: input.lanes.map((lane) => ({ laneId: lane.id, level: input.roleLevel })),
      skipped: [],
    }
  }
  const grants: PlannedLaneGrant[] = []
  const seen = new Set<string>()
  const skipped: SkippedLaneScope[] = []
  for (const scope of input.laneScopes) {
    const matches = lanesForRequestedTag(input.lanes, scope)
    if (matches.length !== 1) {
      skipped.push({
        scope,
        reason: matches.length === 0 ? 'unmatched' : 'ambiguous',
      })
      continue
    }
    const laneId = matches[0]!.id
    if (seen.has(laneId)) continue
    seen.add(laneId)
    grants.push({ laneId, level: input.roleLevel })
  }
  return { grants, skipped }
}
