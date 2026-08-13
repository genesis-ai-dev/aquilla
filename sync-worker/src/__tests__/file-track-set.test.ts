// Handler-level tests for file.track.set (stage 1: first-class timeline
// tracks), driven through dispatchEvent so the role floor, the dispatcher
// wiring and handleFileTrackSet's validation are all exercised together.
//
// The projection SQL itself is covered in timeline-events.test.ts. What lives
// here is the asymmetry: the LIVE path is strict, because it is the only place
// a new shape can enter files.meta, while the rebuild projection case accepts
// anything it already accepted once.

import { describe, it, expect } from 'vitest'
import { dispatchEvent } from '../events/dispatch'
import { authorize, type AuthorizedEvent } from '../events/authorize'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'

/** Valid patches use this; the rejection table below swaps in its own. */
const VALID_PATCH = { name: 'Captions' }

async function authorizeTrackSet(
  payload: unknown,
  role = 600,
): Promise<AuthorizedEvent<'file.track.set'>> {
  const result = await authorizeTrackSetRaw(payload, role)
  if (!result.ok) {
    throw new Error(`authorize unexpectedly failed: ${result.reason}`)
  }
  return result.event
}

async function authorizeTrackSetRaw(payload: unknown, role: number) {
  const token = await makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x', role })
  const raw = {
    id: 'evt-00000000-0000-7000-0000-000000000001',
    schemaVersion: 1,
    kind: 'file.track.set',
    projectId: 'proj-a',
    fileId: 'file-x',
    parentId: null,
    author: 'alice',
    payload,
    clientTs: 1000,
  } as unknown as RawEvent<'file.track.set'>
  return await authorize(token, raw, SECRET)
}

function makeNoOpD1(): AquillaDb {
  function makePrepared() {
    const stmt = {
      bind(..._args: unknown[]) { return this },
      async first() { return null },
      async all() { return { results: [], success: true, meta: {} } },
      async run() { return { success: true, meta: {} } },
      raw: async () => [],
    } as unknown as AquillaStatement
    return stmt
  }
  return {
    prepare: makePrepared,
    async batch(ss: AquillaStatement[]) {
      return ss.map(() => ({ success: true, results: [], meta: {} }))
    },
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as AquillaDb
}

function dispatch(authed: AuthorizedEvent<'file.track.set'>) {
  return dispatchEvent(makeNoOpD1(), authed, 9999, { updateProjection: true })
}

describe('file.track.set — role floor', () => {
  it('accepts a maintainer (600)', async () => {
    const result = await authorizeTrackSetRaw({ trackId: 'source-subtitles', patch: VALID_PATCH }, 600)
    expect(result.ok).toBe(true)
  })

  it('rejects a contributor (400) — track structure is file structure', async () => {
    const result = await authorizeTrackSetRaw({ trackId: 'source-subtitles', patch: VALID_PATCH }, 400)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe(403)
  })
})

describe('file.track.set — accepted writes', () => {
  it('routes an upsert to the handler: events INSERT + files UPDATE', async () => {
    const authed = await authorizeTrackSet({
      trackId: '9f1c3a7e-2b40-4d55-8e0a-6c1d2f3a4b5c',
      patch: { kind: 'target-audio', name: 'Spanish VO', order: 3, groupId: 'dubs' },
    })
    const outcome = dispatch(authed)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.stmts.length).toBe(2)
    expect(outcome.result.dirtyTables).toContain('events')
    expect(outcome.result.dirtyTables).toContain('files')
  })

  it('routes a delete (patch: null) the same way', async () => {
    const authed = await authorizeTrackSet({ trackId: 'source-audio', patch: null })
    const outcome = dispatch(authed)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.stmts.length).toBe(2)
  })

  it('accepts a field-clearing patch', async () => {
    const authed = await authorizeTrackSet({
      trackId: 'source-subtitles',
      patch: { name: null, order: null, groupId: null },
    })
    expect(dispatch(authed).ok).toBe(true)
  })

  // Order is a SORT KEY, not an index: stage 3 slots a new track between two
  // existing ones (0.5) or ahead of the first (-1) without rewriting anything
  // else. Both shapes must stay accepted forever.
  it('accepts a negative order', async () => {
    const authed = await authorizeTrackSet({ trackId: 'source-subtitles', patch: { order: -1 } })
    expect(dispatch(authed).ok).toBe(true)
  })

  it('accepts a fractional order', async () => {
    const authed = await authorizeTrackSet({ trackId: 'source-subtitles', patch: { order: 0.5 } })
    expect(dispatch(authed).ok).toBe(true)
  })

  it('accepts a 120-character name (the cap itself is legal)', async () => {
    const authed = await authorizeTrackSet({ trackId: 'source-subtitles', patch: { name: 'x'.repeat(120) } })
    expect(dispatch(authed).ok).toBe(true)
  })
})

describe('file.track.set — rejected writes', () => {
  it('throws when fileId is absent', async () => {
    // The perimeter (authorize) refuses a fileId-less event before dispatch
    // ever sees one, so clear the field on the already-authorized envelope to
    // reach the handler's own guard — the last line of defence for in-process
    // callers that skip the route.
    const authed = await authorizeTrackSet({ trackId: 'source-subtitles', patch: VALID_PATCH })
    delete (authed.event as { fileId?: string }).fileId
    expect(() => dispatch(authed)).toThrow(/missing fileId/)
  })

  const badPayloads: Array<[string, unknown, RegExp]> = [
    ['a non-string trackId', { trackId: 42, patch: VALID_PATCH }, /unusable trackId/],
    ['an empty trackId', { trackId: '', patch: VALID_PATCH }, /unusable trackId/],
    ['a trackId with punctuation', { trackId: 'sub titles!', patch: VALID_PATCH }, /unusable trackId/],
    ['a trackId over 64 chars', { trackId: 'a'.repeat(65), patch: VALID_PATCH }, /unusable trackId/],
    ['an undefined patch', { trackId: 'source-subtitles' }, /non-object patch/],
    ['a string patch', { trackId: 'source-subtitles', patch: 'name' }, /non-object patch/],
    ['an array patch', { trackId: 'source-subtitles', patch: [] }, /non-object patch/],
    ['an empty patch', { trackId: 'source-subtitles', patch: {} }, /empty patch/],
    [
      'an unknown patch key',
      { trackId: 'source-subtitles', patch: { name: 'Captions', colour: 'sky' } },
      /unknown patch key: colour/,
    ],
    [
      'an unknown kind',
      { trackId: 'custom-1', patch: { kind: 'video' } },
      /unknown track kind/,
    ],
    // The stage-2 rename ('subtitles' -> 'source-subtitles') was free only
    // because the kind was dormant and nothing had ever persisted the old
    // word. This case is what keeps it that way: if the retired spelling
    // could still get in, files.meta would start carrying a kind the client's
    // merge drops on sight, and the row would be invisible with no way to
    // tell it from a bug.
    [
      'the retired "subtitles" kind',
      { trackId: 'custom-1', patch: { kind: 'subtitles' } },
      /unknown track kind/,
    ],
    // kind is identity — there is nothing to fall back to, so null is not a
    // way to spell "clear it".
    ['a null kind', { trackId: 'custom-1', patch: { kind: null } }, /unknown track kind/],
    // A default track's kind is derived from its id; an override could only
    // ever contradict it.
    [
      'a kind on a default track',
      { trackId: 'source-subtitles', patch: { kind: 'source-subtitles' } },
      /sets kind on default track source-subtitles/,
    ],
    ['a non-string name', { trackId: 'source-subtitles', patch: { name: 7 } }, /unusable track name/],
    // Clearing a rename is name: null, never "".
    ['an empty name', { trackId: 'source-subtitles', patch: { name: '' } }, /unusable track name/],
    ['a whitespace-only name', { trackId: 'source-subtitles', patch: { name: '   ' } }, /unusable track name/],
    [
      'a name over 120 chars',
      { trackId: 'source-subtitles', patch: { name: 'x'.repeat(121) } },
      /unusable track name/,
    ],
    ['a non-number order', { trackId: 'source-subtitles', patch: { order: '2' } }, /non-finite track order/],
    ['a NaN order', { trackId: 'source-subtitles', patch: { order: Number.NaN } }, /non-finite track order/],
    [
      'an infinite order',
      { trackId: 'source-subtitles', patch: { order: Number.POSITIVE_INFINITY } },
      /non-finite track order/,
    ],
    [
      'a negatively infinite order',
      { trackId: 'source-subtitles', patch: { order: Number.NEGATIVE_INFINITY } },
      /non-finite track order/,
    ],
    ['a non-string groupId', { trackId: 'source-subtitles', patch: { groupId: 3 } }, /unusable groupId/],
    [
      'a groupId with punctuation',
      { trackId: 'source-subtitles', patch: { groupId: 'dubs/es' } },
      /unusable groupId/,
    ],
    [
      'a groupId over 64 chars',
      { trackId: 'source-subtitles', patch: { groupId: 'g'.repeat(65) } },
      /unusable groupId/,
    ],
  ]

  for (const [label, payload, message] of badPayloads) {
    it(`rejects ${label}`, async () => {
      const authed = await authorizeTrackSet(payload)
      expect(() => dispatch(authed)).toThrow(message)
    })
  }
})
