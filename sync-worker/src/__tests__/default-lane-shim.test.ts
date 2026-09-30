// AQU-1240 slice 3b (machinery): the laneOfEvent replay shim.
// These assert the NEW 3-arg behavior of laneOfEvent. The separate
// lane-of-event.default-lane-baseline.test.ts pins the pre-1240 2-arg behavior;
// both must hold because the 3rd arg is optional and defaults to legacy ''.
//
// (The v1 `resolveDefaultLane` reader over the `default_lane_migration` table
// was dropped: under v2 the default-lane tag is carried by the `lanes` table's
// `legacy_tag`, and the resolver is wired at the enable step.)

import { describe, expect, it } from 'vitest'
import { laneOfEvent } from '../events/event-projection'

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
