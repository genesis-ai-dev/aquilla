// AQU-646 stage 2: the second gate on restructuring a timeline, at the
// perimeter.
//
// Modelled on authorize-cell-editing.test.ts, whose gate now has the SAME shape
// — and these tests are what stop someone giving this one a clearance term.
// AQU-1068 replaced the conditional floor RAISE that used to stand there
// (`allowLineCreation`, on a kind whose static floor had been lowered) with a
// bare whether-gate carrying no role term. `file.track.set` was never lowered —
// it is MAINTAINER in role-policy.ts — so this setting likewise answers
// *whether* a project restructures its timelines, not *who* may do it. The
// consequence is the owner case below, the single most important test here.
//
// These are the tests that hold when the browser lies: the UI withholds the
// controls when the setting is off, but a hand-rolled event, a stale tab or a
// replayed outbox does not go through the UI.

import { describe, it, expect } from 'vitest'
import { authorize } from '../events/authorize'
import { makeTestToken } from './helpers/auth'
import { ROLE } from '../events/role-policy'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret-value-for-track-editing'

function makeDb(options: { allowed?: boolean } = {}): AquillaDb {
  const { allowed = false } = options
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes('FROM project_settings')) {
                return { settings: JSON.stringify(allowed ? { allowTrackEditing: true } : {}) }
              }
              return null
            },
            async all() { return { results: [] } },
          }
        },
      }
    },
  } as unknown as AquillaDb
}

/** A db whose settings read throws — the fail-safe leg. */
const brokenDb = {
  prepare() {
    return {
      bind() {
        return {
          async first() { throw new Error('boom') },
          async all() { return { results: [] } },
        }
      },
    }
  },
} as unknown as AquillaDb

function ev(patch: unknown, trackId = 'trk-1'): RawEvent<'file.track.set'> {
  return {
    id: '00000000-0000-7000-0000-0000000000aa',
    schemaVersion: 1,
    kind: 'file.track.set',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: null,
    parentId: null,
    author: 'alice',
    payload: { trackId, patch },
    clientTs: 1000,
  } as unknown as RawEvent<'file.track.set'>
}

const tokenFor = (role: number) =>
  makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x', role })

describe('track editing at the perimeter — what the setting gates', () => {
  // The example restructuring is a FOLDER MOVE. It used to be a recolour, until
  // colour became ordinary maintainer work (Sam, 2026-09-26) — see the second
  // describe below.
  it('refuses a folder move while the project has not opted in — the default', async () => {
    const result = await authorize(await tokenFor(ROLE.MAINTAINER), ev({ groupId: 'grp-1' }), SECRET, makeDb())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.reason).toMatch(/track editing is not enabled/)
    }
  })

  it('admits the same folder move once the setting is on — the point of the change', async () => {
    const result = await authorize(
      await tokenFor(ROLE.MAINTAINER), ev({ groupId: 'grp-1' }), SECRET, makeDb({ allowed: true }),
    )
    expect(result.ok).toBe(true)
  })

  it('refuses a delete while the setting is off', async () => {
    const result = await authorize(await tokenFor(ROLE.MAINTAINER), ev(null), SECRET, makeDb())
    expect(result.ok).toBe(false)
  })

  it('refuses a folder drop while the setting is off, order or no order', async () => {
    const result = await authorize(
      await tokenFor(ROLE.MAINTAINER), ev({ order: 1.5, groupId: 'grp-1' }), SECRET, makeDb(),
    )
    expect(result.ok).toBe(false)
  })

  // THE ONE THAT PINS THE DECISION. An owner clears every role floor in the
  // app. Of the neighbouring carve-outs in authorize.ts only the timing lock
  // still carries a clearance term (`role < ROLE.MAINTAINER`) that would let an
  // owner straight past; the cell-editing gate deliberately carries none, and
  // neither does this one — this kind's floor was never lowered — so an owner
  // is refused like anyone else. If someone adds a role term back to make this
  // resemble the timing carve-out, this fails.
  it('refuses an OWNER too — two gates means two gates', async () => {
    const result = await authorize(await tokenFor(ROLE.OWNER), ev({ groupId: 'grp-1' }), SECRET, makeDb())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/track editing is not enabled/)
  })

  it('a broken settings read refuses rather than admitting — fail-safe OFF', async () => {
    const result = await authorize(await tokenFor(ROLE.MAINTAINER), ev({ groupId: 'grp-1' }), SECRET, brokenDb)
    expect(result.ok).toBe(false)
  })

  // Matches both neighbouring carve-outs: with no database handle there is
  // nothing to ask, so the policy layer stands down and the static role floor
  // is the whole answer.
  it('skips the gate entirely when there is no db to ask', async () => {
    const result = await authorize(await tokenFor(ROLE.MAINTAINER), ev({ groupId: 'grp-1' }), SECRET)
    expect(result.ok).toBe(true)
  })
})

describe('track editing at the perimeter — what the setting does NOT gate', () => {
  // Drag-to-reorder and rename already ship. A new setting defaulting to off
  // must not silently take an existing capability away from every project that
  // has one — so with the setting OFF, both still pass.
  it('admits a reorder with the setting off', async () => {
    const result = await authorize(await tokenFor(ROLE.MAINTAINER), ev({ order: 2 }), SECRET, makeDb())
    expect(result.ok).toBe(true)
  })

  it('admits a rename with the setting off', async () => {
    const result = await authorize(await tokenFor(ROLE.MAINTAINER), ev({ name: 'Captions' }), SECRET, makeDb())
    expect(result.ok).toBe(true)
  })

  // Sam, 2026-09-26: the Audio view offers the dub track's colour on projects
  // that never turn track editing on. A colour is how a track looks — like a
  // name — so a maintainer may set it either way.
  it('admits a recolour with the setting off', async () => {
    const result = await authorize(await tokenFor(ROLE.MAINTAINER), ev({ color: 'cyan' }, 'target-audio'), SECRET, makeDb())
    expect(result.ok).toBe(true)
  })

  it('still refuses a contributor a recolour', async () => {
    const result = await authorize(await tokenFor(ROLE.CONTRIBUTOR), ev({ color: 'cyan' }, 'target-audio'), SECRET, makeDb({ allowed: true }))
    expect(result.ok).toBe(false)
  })

  it('admits the renormalise batch shape (order only) with the setting off', async () => {
    // Every add and remove batches a run of bare {order} writes as bookkeeping,
    // and so does an ordinary drag that exhausts the gap between two rows. If
    // the toggle killed these, dragging would break the first time two tracks
    // tied.
    for (const order of [0, 1, 2, 3]) {
      const result = await authorize(await tokenFor(ROLE.MAINTAINER), ev({ order }), SECRET, makeDb())
      expect(result.ok).toBe(true)
    }
  })

  // The floor is UNDERNEATH the gate, not replaced by it: turning the setting
  // on does not admit a contributor to track structure.
  it('still refuses a contributor outright, setting on or off', async () => {
    const on = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev({ order: 2 }), SECRET, makeDb({ allowed: true }),
    )
    expect(on.ok).toBe(false)
    if (!on.ok) expect(on.status).toBe(403)
  })
})
