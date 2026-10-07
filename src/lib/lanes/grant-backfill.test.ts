import { describe, expect, it } from 'vitest'
import { planLaneGrants } from './grant-backfill'
import type { LaneIdentity } from './read-wall'

const lanes: LaneIdentity[] = [
  { id: 'lane-default', name: 'Spanish', legacyTag: '' },
  { id: 'lane-fr', name: 'French', legacyTag: 'fr' },
  { id: 'lane-yo', name: 'Yoruba Team', legacyTag: 'yo' },
]

describe('planLaneGrants', () => {
  it('gives a member with no lane scopes one row per current target lane', () => {
    const plan = planLaneGrants({ roleLevel: 400, laneScopes: [], lanes })
    expect(plan.skipped).toEqual([])
    expect(plan.grants).toEqual([
      { laneId: 'lane-default', level: 400 },
      { laneId: 'lane-fr', level: 400 },
      { laneId: 'lane-yo', level: 400 },
    ])
  })

  it('grants only the lane whose tag or name is exactly the scope', () => {
    const plan = planLaneGrants({
      roleLevel: 300,
      laneScopes: ['fr', 'Yoruba Team'],
      lanes,
    })
    expect(plan.skipped).toEqual([])
    expect(plan.grants.map((g) => g.laneId)).toEqual(['lane-fr', 'lane-yo'])
  })

  it('does not treat a language word as a second lane', () => {
    const plan = planLaneGrants({
      roleLevel: 300,
      laneScopes: ['Yoruba'],
      lanes,
    })
    expect(plan.grants).toEqual([])
    expect(plan.skipped).toEqual([{ scope: 'Yoruba', reason: 'unmatched' }])
  })

  it('skips a scope that matches two lanes and still grants the exact one', () => {
    const doubled: LaneIdentity[] = [
      ...lanes,
      { id: 'lane-es-2', name: 'Spanish', legacyTag: 'es' },
    ]
    const plan = planLaneGrants({
      roleLevel: 200,
      laneScopes: ['Spanish', 'fr'],
      lanes: doubled,
    })
    expect(plan.grants).toEqual([{ laneId: 'lane-fr', level: 200 }])
    expect(plan.skipped).toEqual([{ scope: 'Spanish', reason: 'ambiguous' }])
  })

  it('writes nothing for Maintainer and above, or below Viewer', () => {
    expect(planLaneGrants({ roleLevel: 600, laneScopes: [], lanes }).grants).toEqual([])
    expect(planLaneGrants({ roleLevel: 700, laneScopes: ['fr'], lanes }).grants).toEqual([])
    expect(planLaneGrants({ roleLevel: 50, laneScopes: [], lanes }).grants).toEqual([])
  })

  it('treats an empty scope as the default lane only', () => {
    const plan = planLaneGrants({ roleLevel: 400, laneScopes: [''], lanes })
    expect(plan.grants).toEqual([{ laneId: 'lane-default', level: 400 }])
    expect(plan.skipped).toEqual([])
  })

  it('dedupes two scopes that name the same lane', () => {
    const plan = planLaneGrants({
      roleLevel: 400,
      laneScopes: ['yo', 'Yoruba Team'],
      lanes,
    })
    expect(plan.grants).toEqual([{ laneId: 'lane-yo', level: 400 }])
  })
})
