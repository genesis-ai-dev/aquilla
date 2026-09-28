import { describe, expect, it } from 'vitest'
import type { SyncTokenClaims } from '../auth'
import { ROLE } from './role-policy'
import { makeVerifiedProjectId } from './scoped-search'
import {
  isLaneVisible,
  makeLaneScopedRead,
  resolveVisibleLanes,
} from './lane-visibility-authority'

const ALL_LANES = ['', 'es', 'fr'] as const

function claims(
  overrides: Partial<Pick<SyncTokenClaims, 'role' | 'src' | 'laneGrants'>>,
): Pick<SyncTokenClaims, 'role' | 'src' | 'laneGrants'> {
  return {
    role: ROLE.CONTRIBUTOR,
    ...overrides,
  }
}

function fullClaims(
  overrides: Partial<SyncTokenClaims> = {},
): SyncTokenClaims {
  return {
    userId: 1,
    projectId: 'proj-1',
    fileId: 'file-1',
    role: ROLE.CONTRIBUTOR,
    aud: 'sync',
    iat: 0,
    exp: 9_999_999_999,
    ...overrides,
  }
}

describe('resolveVisibleLanes', () => {
  it('returns null for platform operators', () => {
    expect(resolveVisibleLanes(claims({ src: 'platform', role: ROLE.VIEWER }), ALL_LANES)).toBe(
      null,
    )
  })

  it('returns null for Maintainer (600)', () => {
    expect(resolveVisibleLanes(claims({ role: ROLE.MAINTAINER }), ALL_LANES)).toBe(null)
  })

  it('returns null for Owner (700)', () => {
    expect(resolveVisibleLanes(claims({ role: ROLE.OWNER }), ALL_LANES)).toBe(null)
  })

  it('returns the exact granted lane set below Maintainer', () => {
    const visible = resolveVisibleLanes(
      claims({
        role: ROLE.CONTRIBUTOR,
        laneGrants: [
          { lane: 'es', level: ROLE.CONTRIBUTOR },
          { lane: 'fr', level: ROLE.REVIEWER },
        ],
      }),
      ALL_LANES,
    )

    expect(visible).not.toBeNull()
    expect(visible).toEqual(new Set(['es', 'fr']))
  })

  it('returns an empty set (not null) when below Maintainer with no grants', () => {
    const visible = resolveVisibleLanes(claims({ role: ROLE.CONTRIBUTOR }), ALL_LANES)

    expect(visible).not.toBeNull()
    expect(visible).toBeInstanceOf(Set)
    expect(visible!.size).toBe(0)
  })

  it('returns an empty set when laneGrants is an empty array', () => {
    const visible = resolveVisibleLanes(
      claims({ role: ROLE.CONTRIBUTOR, laneGrants: [] }),
      ALL_LANES,
    )

    expect(visible).not.toBeNull()
    expect(visible!.size).toBe(0)
  })

  it('platform src wins over empty grants', () => {
    expect(
      resolveVisibleLanes(
        claims({ src: 'platform', role: ROLE.VIEWER, laneGrants: [] }),
        ALL_LANES,
      ),
    ).toBe(null)
  })

  it('role 600+ wins over partial grants', () => {
    expect(
      resolveVisibleLanes(
        claims({ role: ROLE.MAINTAINER, laneGrants: [{ lane: 'es', level: ROLE.VIEWER }] }),
        ALL_LANES,
      ),
    ).toBe(null)
  })
})

describe('isLaneVisible', () => {
  it('always allows source-side rows', () => {
    expect(isLaneVisible(new Set(), 'es', 'source')).toBe(true)
    expect(isLaneVisible(null, 'es', 'source')).toBe(true)
  })

  it('allows every target lane when visible is null', () => {
    expect(isLaneVisible(null, 'es', 'target')).toBe(true)
    expect(isLaneVisible(null, 'fr', 'target')).toBe(true)
  })

  it('hides ungranted target lanes but still allows source', () => {
    const visible = new Set(['es'])

    expect(isLaneVisible(visible, 'fr', 'target')).toBe(false)
    expect(isLaneVisible(visible, 'fr', 'source')).toBe(true)
    expect(isLaneVisible(visible, 'es', 'target')).toBe(true)
  })
})

describe('makeLaneScopedRead', () => {
  it('round-trips project and visible lanes from the mint helper', () => {
    const project = makeVerifiedProjectId(fullClaims({ projectId: 'verified-proj' }))
    const visible = new Set(['es'])

    const scoped = makeLaneScopedRead(project, visible)

    expect(scoped.__brand).toBe('lane-scoped-read')
    expect(scoped.project).toBe(project)
    expect(scoped.visible).toBe(visible)
  })
})
