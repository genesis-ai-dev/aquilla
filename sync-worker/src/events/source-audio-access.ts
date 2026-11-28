/**
 * AQU-2682: does this caller's access cover every language of the project?
 *
 * The shared source clip is what every language hears, so declaring audio as
 * source (`cell.audio.attach` with `role: 'source'`) needs it. One rule, used
 * by `authorize()` to refuse the attach and by the source-audio-access read
 * so the app offers "Upload a recording to make lines" and attaching media
 * only to people the server will accept.
 *
 *  - Under the lane wall: Maintainer+ and platform tokens are not limited.
 *    Anyone else needs a grant on each of the project's target lanes at
 *    `requiredRole` or above (the same effective-role sum as a lane write).
 *  - With the wall off: any lane scope limits the caller.
 */

import type { SyncTokenClaims } from '../auth'
import { ROLE } from './role-policy'
import { effectiveRoleInLane, revealingGrantLevel } from '../../../src/lib/lanes/write-wall'
import type { LaneIdentity } from '../../../src/lib/lanes/read-wall'

type Claims = Pick<SyncTokenClaims, 'role' | 'scopes' | 'laneGrants'> & { src?: string }

/** Whether a language limit can apply to this caller's audio at all. */
export function audioLaneLimited(wallOn: boolean, claims: Claims): boolean {
  return wallOn
    ? claims.role < ROLE.MAINTAINER && claims.src !== 'platform'
    : (claims.scopes ?? []).some((sc) => sc.kind === 'lane')
}

/**
 * True when the caller may act in every language at once. `loadLanes` is only
 * called when the answer depends on the project's lanes (below Maintainer,
 * under the wall), so the common cases cost no lookup.
 */
export async function coversEveryLanguage(input: {
  wallOn: boolean
  claims: Claims
  requiredRole: number
  loadLanes: () => Promise<readonly LaneIdentity[]>
}): Promise<boolean> {
  const { wallOn, claims, requiredRole } = input
  if (!audioLaneLimited(wallOn, claims)) return true
  if (!wallOn) return false
  return (await input.loadLanes()).every((lane) => {
    const effective = effectiveRoleInLane(claims.role, revealingGrantLevel(claims.laneGrants, lane.id))
    return effective != null && effective >= requiredRole
  })
}
