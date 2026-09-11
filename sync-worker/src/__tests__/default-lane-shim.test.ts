// AQU-1240 slice 3b (machinery): the laneOfEvent replay shim + resolveDefaultLane.
// These assert the NEW 3-arg behavior and the resolver contract. The separate
// lane-of-event.default-lane-baseline.test.ts pins the pre-1240 2-arg behavior;
// both must hold because the 3rd arg is optional and defaults to legacy ''.

import { describe, expect, it } from 'vitest'
import { laneOfEvent } from '../events/event-projection'
import { resolveDefaultLane } from '../events/default-lane'
import type { AquillaDb } from '../../../db/shim/postgres'

describe('laneOfEvent — AQU-1240 shim (projectDefaultLane)', () => {
  it('returns an explicit non-empty target lane verbatim, ignoring the default', () => {
    expect(laneOfEvent('target.cell.commit', { targetLang: 'es' }, 'en')).toBe('es')
  })

  it('resolves an ABSENT target lane to the project default when known', () => {
    expect(laneOfEvent('target.cell.commit', {}, 'en')).toBe('en')
    expect(laneOfEvent('target.cell.commit', undefined, 'en')).toBe('en')
  })

  it("resolves an explicit '' target lane to the project default when known", () => {
    expect(laneOfEvent('target.cell.commit', { targetLang: '' }, 'en')).toBe('en')
  })

  it("falls back to '' when the default is null/undefined/'' (byte-identical to pre-1240)", () => {
    expect(laneOfEvent('target.cell.commit', {}, null)).toBe('')
    expect(laneOfEvent('target.cell.commit', {})).toBe('')
    expect(laneOfEvent('target.cell.commit', {}, '')).toBe('')
  })

  it("NEVER laneifies source kinds, even with a default present (source is always '')", () => {
    expect(laneOfEvent('source.cell.create', { targetLang: 'es' }, 'en')).toBe('')
    expect(laneOfEvent('source.cell.commit', {}, 'en')).toBe('')
  })
})

// Minimal AquillaDb stub: only prepare().bind().first() is exercised.
function stubDb(row: { resolved_lane: string } | null): AquillaDb {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => row,
      }),
    }),
  } as unknown as AquillaDb
}

describe('resolveDefaultLane — AQU-1240', () => {
  it('returns the resolved tag when a mapping row exists', async () => {
    expect(await resolveDefaultLane(stubDb({ resolved_lane: 'en' }), 'p1')).toBe('en')
  })

  it('returns null when the project has no mapping row (unpopulated table)', async () => {
    expect(await resolveDefaultLane(stubDb(null), 'p1')).toBeNull()
  })

  it("returns null defensively when a row's resolved_lane is '' (guards a hand-edited row)", async () => {
    expect(await resolveDefaultLane(stubDb({ resolved_lane: '' }), 'p1')).toBeNull()
  })
})
