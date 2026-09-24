// AQU-730 slice 3: pure lane-visibility authority + branded read type.
//
// Grant-driven metadata/read isolation: below Maintainer (600), a member sees
// only lanes explicitly granted on the sync token. No grant ⇒ empty set (not
// null — the inversion from the old scopes model where absence meant all).
// Platform operators and 600+ cascade to null (all lanes).
//
// UNWIRED: no route calls resolveVisibleLanes yet. The LaneScopedRead brand
// and ESLint perimeter exist so future read paths cannot skip the resolver.
//
// AQU-1389: this file is PRESERVED, NOT ACTIVE, and is owned by AQU-1352 — not
// by the AQU-1240 lane-model cutover. The `laneGrants` claim it reads is also
// gated off at the mint (auth-worker/src/services/lane-grants.ts), so today
// every caller would get the `role >= 600` or empty-set answer regardless.
// Do NOT wire this up as a standalone second authority: AQU-1352 collapses
// every grant source into `access_grants` behind one resolver, and this
// function's read perimeter is meant to sit in FRONT of that resolver, taking
// its lane answer from it. Wiring it to project_member_lane_roles directly
// would re-create the divergence AQU-1389 just removed.

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

/** Source rows (side='source') are ALWAYS visible; callers pass side. */
export function isLaneVisible(
  visible: VisibleLanes,
  targetLang: string,
  side: 'source' | 'target',
): boolean {
  if (side === 'source') {
    return true
  }
  if (visible === null) {
    return true
  }
  return visible.has(targetLang)
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
