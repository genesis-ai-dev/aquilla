import { describe, it, expect } from 'vitest'
import {
  defaultLaneDraftReviewHref,
  resolveDeepLinkLane,
  resolveDeepLinkLaneFromSearchParams,
} from './project-workspace-lane-deeplink'

// AQU-538: `/project/:id/editor?lane=<tag>` deep-link resolution.
describe('resolveDeepLinkLane', () => {
  const available = ['', 'es', 'fr']

  it('returns null when there is no lane param (leave current lane untouched)', () => {
    expect(resolveDeepLinkLane(null, available)).toBeNull()
    expect(resolveDeepLinkLane(undefined, available)).toBeNull()
  })

  it('treats an explicit empty lane param as an instruction to select Project default', () => {
    expect(resolveDeepLinkLane('', available)).toBe('')
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

  it('a review link overrides a persisted multilingual lane with explicit Project default', () => {
    const persistedLane = 'fr'
    const href = defaultLaneDraftReviewHref('p1', 'file/1', 'cell 2')
    const searchParams = new URL(href, 'https://app.test').searchParams
    const deepLinkLane = resolveDeepLinkLaneFromSearchParams(searchParams, available)

    expect(href).toBe('/project/p1/editor/file/file%2F1?cellId=cell%202&lane=')
    expect(deepLinkLane ?? persistedLane).toBe('')
  })
})
