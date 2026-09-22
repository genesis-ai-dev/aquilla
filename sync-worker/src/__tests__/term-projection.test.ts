// Terminology concepts on the event log. (AQU-1006 follow-up, 2026-09-04)
//
// THE BUG THIS FILE EXISTS TO PIN, stated plainly because the fix looks like
// ordinary plumbing otherwise:
//
// Concepts used to live in the `project_settings` JSON blob under a single
// `terminology` key. Adding a term rebuilt the WHOLE array from the writer's
// in-memory snapshot and PATCHed it back. `useProjectSettings` re-probed the
// server first and merged `{...fresh.settings, ...partial}` — a KEY-level
// merge, which cannot see inside an array. So two people adding terms a few
// seconds apart each wrote a full array built from a snapshot taken before the
// other's write, and the second silently destroyed the first. No 409, no
// conflict banner, no trace. Observed live on 2026-09-04: five people on a
// demo call added terms, one survived.
//
// The property that makes that impossible is not "we added events" — it is
// that EVERY WRITE NAMES EXACTLY ONE CONCEPT. The concurrent-add test below is
// the regression test for the outage; the "never writes a project-wide
// statement" test is the one that stops the bug being reintroduced by a
// well-meaning bulk-update optimisation later.

import { describe, it, expect } from 'vitest'
import {
  buildEventProjectionStmts,
  isChainMutatingKind,
  type PersistedEvent,
} from '../events/event-projection'
import { isBindingTermWrite, resolveTermbaseEditFloor } from '../events/termbase-authority'
import type { EventKind, EventPayloads } from '../events/types'

interface RecordedStmt {
  sql: string
  args: unknown[]
}

function makeRecordingDb() {
  const recorded: RecordedStmt[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          recorded.push({ sql: sql.replace(/\s+/g, ' ').trim(), args })
          return this
        },
      } as unknown as AquillaStatement
    },
  } as unknown as AquillaDb
  return { db, recorded }
}

function makeEvent<K extends EventKind>(
  kind: K,
  payload: EventPayloads[K],
  overrides: Partial<PersistedEvent<K>> = {},
): PersistedEvent<K> {
  return {
    id: 'evt-1',
    schemaVersion: 1,
    projectId: 'proj-1',
    // Project-scoped: no file, no cell. The sentinel is normalized to null by
    // the handler before the event reaches the projector.
    fileId: null,
    cellId: null,
    parentId: null,
    kind,
    author: 'ryder',
    payload,
    clientTs: 1000,
    serverTs: 2000,
    serverSeq: 9,
    ...overrides,
  } as PersistedEvent<K>
}

function project<K extends EventKind>(kind: K, payload: EventPayloads[K], author = 'ryder') {
  const { db, recorded } = makeRecordingDb()
  const stmts: AquillaStatement[] = []
  const touches = buildEventProjectionStmts(db, makeEvent(kind, payload, { author } as never), stmts)
  return { recorded, touches }
}

describe('term.* projection', () => {
  it('is never chain-mutating — a concept moves no cell head', () => {
    // If any term kind were classified chain-mutating it would be subjected to
    // the AD-2 first-child-of-parent guard and dropped as a stale sibling,
    // since these events carry no parentId and no cell.
    for (const kind of ['term.create', 'term.update', 'term.delete', 'term.approve', 'term.reject'] as const) {
      expect(isChainMutatingKind(kind)).toBe(false)
    }
  })

  it('REGRESSION (2026-09-04 outage): two concurrent creates both survive', () => {
    // The exact shape of the demo failure: two people, no coordination, each
    // unaware of the other's term. Under the blob this left one concept.
    const a = project('term.create', {
      conceptId: 'cpt-abraham',
      sourceTerm: 'Abraham',
      renderings: [{ rendering: 'Ibrahim', status: 'preferred' }],
      status: 'active',
    }, 'ryder')
    const b = project('term.create', {
      conceptId: 'cpt-amen',
      sourceTerm: 'amen',
      renderings: [],
      status: 'draft',
    }, 'jocelyn')

    // Each write is an INSERT of ONE named concept. Neither statement can
    // affect the other's row, whatever order they land in.
    expect(a.recorded).toHaveLength(1)
    expect(b.recorded).toHaveLength(1)
    expect(a.recorded[0].sql).toContain('INSERT INTO concepts')
    expect(b.recorded[0].sql).toContain('INSERT INTO concepts')
    expect(a.recorded[0].args).toContain('cpt-abraham')
    expect(b.recorded[0].args).toContain('cpt-amen')
    // Neither mentions the other's concept in any position.
    expect(a.recorded[0].args).not.toContain('cpt-amen')
    expect(b.recorded[0].args).not.toContain('cpt-abraham')
  })

  it('no term statement can address more than one concept', () => {
    // The structural guarantee behind the test above, asserted directly so a
    // future bulk-write optimisation cannot quietly reintroduce the outage.
    const cases: Array<[EventKind, unknown]> = [
      ['term.create', { conceptId: 'c1', sourceTerm: 'x', renderings: [], status: 'draft' }],
      ['term.update', { conceptId: 'c1', sourceTerm: 'y' }],
      ['term.delete', { conceptId: 'c1' }],
      ['term.approve', { conceptId: 'c1' }],
      ['term.reject', { conceptId: 'c1', mode: 'delete' }],
      ['term.reject', { conceptId: 'c1', mode: 'deprecate' }],
    ]
    for (const [kind, payload] of cases) {
      const { recorded } = project(kind as 'term.delete', payload as never)
      expect(recorded).toHaveLength(1)
      const { sql, args } = recorded[0]
      // Every mutating statement is keyed on the concept id.
      expect(sql).toMatch(/concept_id/)
      expect(args).toContain('c1')
      // And none is scoped to the project alone — the shape that lost data.
      expect(sql).not.toMatch(/WHERE\s+project_id\s*=\s*\?\s*(AND\s+deleted_at|$)/i)
    }
  })

  it('a create is idempotent, so a replayed outbox flush is not a duplicate', () => {
    const { recorded } = project('term.create', {
      conceptId: 'cpt-1', sourceTerm: 'grace', renderings: [], status: 'draft',
    })
    expect(recorded[0].sql).toContain('ON CONFLICT(concept_id) DO NOTHING')
  })

  it('an update leaves absent fields alone, so parallel field edits both survive', () => {
    // Someone renaming the headword must not blank the notes another person
    // just wrote. COALESCE-per-column is what buys that.
    const { recorded } = project('term.update', { conceptId: 'cpt-1', sourceTerm: 'Grace' })
    const { sql, args } = recorded[0]
    expect(sql).toContain('COALESCE')
    // notes / renderings / case_sensitive absent from the payload → bound null
    // → COALESCE keeps the projected value.
    expect(args[0]).toBe('Grace')
    expect(args.slice(1, 4)).toEqual([null, null, null])
  })

  it('renderings replace wholesale when present, and only when present', () => {
    const withR = project('term.update', {
      conceptId: 'cpt-1',
      renderings: [{ rendering: 'gracia', status: 'forbidden' }],
    })
    expect(withR.recorded[0].args[1]).toBe('[{"rendering":"gracia","status":"forbidden"}]')
    const withoutR = project('term.update', { conceptId: 'cpt-1', notes: 'hi' })
    expect(withoutR.recorded[0].args[1]).toBeNull()
  })

  it('term.create stores match options as JSON; absent writes NULL', () => {
    // WHY: the option object must survive the round trip verbatim; a concept
    // without options must project NULL so the read route resolves defaults.
    const withOpts = project('term.create', {
      conceptId: 'c1', sourceTerm: 'הארץ', renderings: [], status: 'draft',
      match: { foldMarks: true, excludedForms: ['בארץ'] },
    })
    expect(withOpts.recorded[0].sql).toContain('match_options')
    expect(withOpts.recorded[0].args).toContain(JSON.stringify({ foldMarks: true, excludedForms: ['בארץ'] }))
    const without = project('term.create', { conceptId: 'c2', sourceTerm: 'x', renderings: [], status: 'draft' })
    expect(without.recorded[0].args).toContain(null)
  })

  it('term.update replaces match wholesale when present and leaves it alone when absent', () => {
    // WHY: like renderings, an options object has no per-key identity worth
    // merging; but an absent key must be COALESCEd so a notes-only edit from
    // another user never wipes someone's exclusions.
    const present = project('term.update', { conceptId: 'c1', match: { affixes: false } })
    expect(present.recorded[0].sql).toMatch(/match_options\s*=\s*COALESCE\(/)
    expect(present.recorded[0].args).toContain(JSON.stringify({ affixes: false }))
    const absent = project('term.update', { conceptId: 'c1', notes: 'hi' })
    const idx = absent.recorded[0].sql.split('COALESCE').findIndex((s) => s.includes('match_options'))
    expect(idx).toBeGreaterThan(-1)
    expect(absent.recorded[0].args.filter((a) => a === null).length).toBeGreaterThanOrEqual(1)
  })

  it('approve promotes a draft or restores an archived term, but cannot resurrect a deleted one', () => {
    const { recorded } = project('term.approve', { conceptId: 'cpt-1' })
    expect(recorded[0].sql).toContain("status IN ('draft', 'deprecated')")
    expect(recorded[0].sql).toContain('deleted_at IS NULL')
  })

  it('reject honours its mode: deprecate keeps the row, delete tombstones it', () => {
    const dep = project('term.reject', { conceptId: 'cpt-1', mode: 'deprecate' })
    expect(dep.recorded[0].sql).toContain("status = 'deprecated'")
    expect(dep.recorded[0].sql).not.toContain('deleted_at = ?')
    const del = project('term.reject', { conceptId: 'cpt-1', mode: 'delete' })
    expect(del.recorded[0].sql).toContain('deleted_at = ?')
  })

  it('every term kind touches only the concepts projection', () => {
    const { touches } = project('term.create', {
      conceptId: 'c', sourceTerm: 's', renderings: [], status: 'draft',
    })
    expect(touches).toEqual(['concepts'])
  })
})

describe('termbase authority', () => {
  it('suggesting is ungated; every binding write is gated', () => {
    // A draft compiles to no rules, so it changes nothing for anybody — that
    // is precisely why a contributor may write one without a manager.
    expect(isBindingTermWrite('term.create', { status: 'draft' })).toBe(false)
    // Creating an already-active term is approving it in one step.
    expect(isBindingTermWrite('term.create', { status: 'active' })).toBe(true)
    for (const kind of ['term.update', 'term.delete', 'term.approve', 'term.reject'] as const) {
      expect(isBindingTermWrite(kind, {})).toBe(true)
    }
  })

  it('a malformed payload is treated as binding, not as a suggestion', () => {
    // Fail closed: the permissive reading would let a garbled payload write an
    // enforced term at contributor clearance.
    expect(isBindingTermWrite('term.create', null)).toBe(true)
    expect(isBindingTermWrite('term.create', 'nonsense')).toBe(true)
    expect(isBindingTermWrite('term.create', {})).toBe(true)
  })

  it('an out-of-ladder or absent floor falls back to the default, never to open', () => {
    expect(resolveTermbaseEditFloor(400)).toBe(400)
    expect(resolveTermbaseEditFloor(null)).toBe(500)
    expect(resolveTermbaseEditFloor(undefined)).toBe(500)
    expect(resolveTermbaseEditFloor(0)).toBe(500)
    expect(resolveTermbaseEditFloor(9999)).toBe(500)
    expect(resolveTermbaseEditFloor(Number.NaN)).toBe(500)
  })
})
