// AQU-730 slice 3: pure lane-visibility authority + branded read type.
//
// Grant-driven metadata/read isolation: below Maintainer (600), a member sees
// only lanes explicitly granted on the sync token. The set members are
// lane ids (`lanes.id`), not language names. No grant ⇒ empty set (not
// null — the inversion from the old scopes model where absence meant all).
// Platform operators and 600+ cascade to null (all lanes).
//
// UNWIRED: no route calls resolveVisibleLanes yet. The LaneScopedRead brand
// and ESLint perimeter exist so future read paths cannot skip the resolver.

import type { SyncTokenClaims } from '../auth'
import type { VerifiedProjectId } from './scoped-search'
import { ROLE } from './role-policy'

/** null = all lanes (no restriction). A Set is the exact visible set (may be empty). */
export type VisibleLanes = ReadonlySet<string> | null

/**
 * Which lanes may this caller SEE/access. Pure; no DB. projectTargetLanes is
 * the full registry, used only for the null short-circuit documentation.
 */
export function resolveVisibleLanes(
  claims: Pick<SyncTokenClaims, 'role' | 'src' | 'laneGrants'>,
  projectTargetLanes: readonly string[],
): VisibleLanes {
  void projectTargetLanes

  if (claims.src === 'platform') {
    return null
  }

  if (claims.role >= ROLE.MAINTAINER) {
    return null
  }

  if (claims.laneGrants != null && claims.laneGrants.length > 0) {
    return new Set(claims.laneGrants.map((grant) => grant.lane))
  }

  return new Set()
}

/** Source rows (side='source') are ALWAYS visible; callers pass side. `laneId` is `lanes.id`. */
export function isLaneVisible(
  visible: VisibleLanes,
  laneId: string,
  side: 'source' | 'target',
): boolean {
  if (side === 'source') {
    return true
  }
  if (visible === null) {
    return true
  }
  return visible.has(laneId)
}

export type LaneScopedRead = {
  readonly __brand: 'lane-scoped-read'
  project: VerifiedProjectId
  visible: VisibleLanes
}

export function makeLaneScopedRead(
  project: VerifiedProjectId,
  visible: VisibleLanes,
): LaneScopedRead {
  return { __brand: 'lane-scoped-read', project, visible }
}
