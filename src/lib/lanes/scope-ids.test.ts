import { describe, expect, it } from 'vitest'
import {
  laneScopeAdmitsTag,
  laneScopesAsTags,
  laneScopeIds,
  laneScopeIdsForStorage,
  laneScopeTags,
  resolveLaneScopeValue,
} from './scope-ids'
import type { LaneIdentity } from './read-wall'

const lanes: LaneIdentity[] = [
  { id: 'lane-default', name: 'Spanish', legacyTag: '' },
  { id: 'lane-fr', name: 'French', legacyTag: 'fr' },
  { id: 'lane-es-two', name: 'Spanish (Latin America)', legacyTag: 'es' },
  { id: 'lane-es-three', name: 'Spanish (Spain)', legacyTag: 'es' },
]

describe('resolveLaneScopeValue', () => {
  it('keeps a value that is already a lane id', () => {
    expect(resolveLaneScopeValue('lane-fr', lanes)).toEqual({ ok: true, laneId: 'lane-fr' })
  })

  it('converts the default lane tag to that lane id', () => {
    expect(resolveLaneScopeValue('', lanes)).toEqual({ ok: true, laneId: 'lane-default' })
  })

  it('converts a tag that names exactly one lane', () => {
    expect(resolveLaneScopeValue('fr', lanes)).toEqual({ ok: true, laneId: 'lane-fr' })
  })

  it('refuses a tag that names two lanes rather than guessing', () => {
    expect(resolveLaneScopeValue('es', lanes)).toEqual({ ok: false, reason: 'ambiguous' })
  })

  it('refuses a tag that names no lane', () => {
    expect(resolveLaneScopeValue('de', lanes)).toEqual({ ok: false, reason: 'unmatched' })
  })
})

describe('laneScopeIdsForStorage', () => {
  it('de-dupes ids and reports every value it could not place', () => {
    const converted = laneScopeIdsForStorage(['fr', 'lane-fr', '', 'es', 'de'], lanes)
    expect(converted.laneIds).toEqual(['lane-fr', 'lane-default'])
    expect(converted.rejected).toEqual([
      { value: 'es', reason: 'ambiguous' },
      { value: 'de', reason: 'unmatched' },
    ])
  })

  it('stores nothing for an empty list', () => {
    expect(laneScopeIdsForStorage([], lanes)).toEqual({ laneIds: [], rejected: [] })
  })
})

describe('laneScopeIds', () => {
  it('keeps an unresolvable stored value as a legacy tag', () => {
    const { ids, legacyTags } = laneScopeIds(['lane-fr', 'es'], lanes)
    expect([...ids]).toEqual(['lane-fr'])
    expect([...legacyTags]).toEqual(['es'])
  })

  it('treats every value as a legacy tag when there are no lane rows', () => {
    const { ids, legacyTags } = laneScopeIds(['', 'fr'], [])
    expect(ids.size).toBe(0)
    expect([...legacyTags]).toEqual(['', 'fr'])
  })
})

describe('laneScopeAdmitsTag', () => {
  it('admits only the lane the id names, not its same-language sibling', () => {
    expect(laneScopeAdmitsTag(['lane-es-two'], lanes, 'es')).toBe(true)
    // The sibling shares the tag, so the tag is admitted — but a scope on the
    // OTHER lane's id does not admit a lane it was never granted.
    const onlyThree = laneScopeAdmitsTag(['lane-es-three'], lanes, 'Spanish (Latin America)')
    expect(onlyThree).toBe(false)
  })

  it('admits the default lane through its id', () => {
    expect(laneScopeAdmitsTag(['lane-default'], lanes, '')).toBe(true)
    expect(laneScopeAdmitsTag(['lane-default'], lanes, 'fr')).toBe(false)
  })

  it('still compares an unconverted tag literally (pre-backfill rows)', () => {
    expect(laneScopeAdmitsTag(['es'], lanes, 'es')).toBe(true)
    expect(laneScopeAdmitsTag(['es'], lanes, 'fr')).toBe(false)
    // No lane rows to hand: exactly the pre-AQU-1607 string comparison.
    expect(laneScopeAdmitsTag([''], [], '')).toBe(true)
    expect(laneScopeAdmitsTag([''], [], 'fr')).toBe(false)
  })

  it('refuses everything when the scope list is empty', () => {
    expect(laneScopeAdmitsTag([], lanes, '')).toBe(false)
  })
})

describe('laneScopeTags', () => {
  it('maps ids back to the tags a tag-speaking surface compares against', () => {
    expect([...laneScopeTags(['lane-default', 'lane-fr'], lanes)]).toEqual(['', 'fr'])
  })

  it('keeps an unresolvable value as its own text', () => {
    expect([...laneScopeTags(['es'], lanes)]).toEqual(['es'])
  })
})

describe('laneScopesAsTags', () => {
  it('reads lane ids back as the tags a tag-speaking surface compares', () => {
    expect(
      laneScopesAsTags(
        [
          { kind: 'lane', value: 'lane-default' },
          { kind: 'lane', value: 'lane-fr' },
          { kind: 'file', value: 'lane-fr' },
        ],
        lanes,
      ),
    ).toEqual([
      { kind: 'lane', value: '' },
      { kind: 'lane', value: 'fr' },
      { kind: 'file', value: 'lane-fr' },
    ])
  })

  it('leaves a value that is no lane id alone', () => {
    expect(laneScopesAsTags([{ kind: 'lane', value: 'fr' }], lanes)).toEqual([
      { kind: 'lane', value: 'fr' },
    ])
    expect(laneScopesAsTags([{ kind: 'lane', value: 'fr' }], [])).toEqual([
      { kind: 'lane', value: 'fr' },
    ])
  })
})
