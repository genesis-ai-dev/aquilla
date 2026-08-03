import { describe, it, expect } from 'vitest'
import { resolveDeepLinkLane } from './project-workspace-lane-deeplink'

// AQU-538: `/project/:id/editor?lane=<tag>` deep-link resolution.
describe('resolveDeepLinkLane', () => {
  const available = ['', 'es', 'fr']

  it('returns null when there is no lane param (leave current lane untouched)', () => {
    expect(resolveDeepLinkLane(null, available)).toBeNull()
    expect(resolveDeepLinkLane(undefined, available)).toBeNull()
    expect(resolveDeepLinkLane('', available)).toBeNull()
  })

  it('returns the param when it is an available lane', () => {
    expect(resolveDeepLinkLane('es', available)).toBe('es')
    expect(resolveDeepLinkLane('fr', available)).toBe('fr')
  })

  it('falls back to the default lane for an unknown tag', () => {
    expect(resolveDeepLinkLane('de', available)).toBe('')
    expect(resolveDeepLinkLane('xx', ['', 'es'])).toBe('')
  })

  it('an N=1 project (only the default lane) rejects any non-empty tag', () => {
    expect(resolveDeepLinkLane('es', [''])).toBe('')
  })
})
