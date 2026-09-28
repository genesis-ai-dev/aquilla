// PRE-AQU-1240 characterization baseline — pins today's implicit `''` default-lane
// behavior via `laneOfEvent`. UPDATE (do not silently delete) when `''` is
// eliminated for target rows (AQU-1240 slice 0).

import { describe, it, expect } from 'vitest'
import { laneOfEvent } from '../events/event-projection'

describe('laneOfEvent — PRE-AQU-1240 default-lane baseline', () => {
  it('target.cell.commit with targetLang absent → ""', () => {
    expect(laneOfEvent('target.cell.commit', {})).toBe('')
    expect(laneOfEvent('target.cell.commit', { value: 'hello' })).toBe('')
  })

  it('target.cell.commit with targetLang non-string → ""', () => {
    expect(laneOfEvent('target.cell.commit', { targetLang: null })).toBe('')
    expect(laneOfEvent('target.cell.commit', { targetLang: undefined })).toBe('')
    expect(laneOfEvent('target.cell.commit', { targetLang: 42 })).toBe('')
    expect(laneOfEvent('target.cell.commit', { targetLang: true })).toBe('')
  })

  it('target.cell.commit with targetLang "" → ""', () => {
    expect(laneOfEvent('target.cell.commit', { targetLang: '' })).toBe('')
  })

  it("target.cell.commit with targetLang 'es' → 'es'", () => {
    expect(laneOfEvent('target.cell.commit', { targetLang: 'es' })).toBe('es')
    expect(laneOfEvent('target.cell.delete', { targetLang: 'es' })).toBe('es')
  })

  it('source.cell.* kinds → "" regardless of payload.targetLang', () => {
    expect(laneOfEvent('source.cell.create', {})).toBe('')
    expect(laneOfEvent('source.cell.create', { targetLang: 'es' })).toBe('')
    expect(laneOfEvent('source.cell.commit', { targetLang: 'fr' })).toBe('')
    expect(laneOfEvent('source.cell.mirror', { targetLang: 'de' })).toBe('')
  })
})
