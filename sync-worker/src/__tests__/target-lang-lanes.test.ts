// AQU-538 slice 1: target-language lanes on the cells projection.
//
// The TMS-style data-model decision (docs/superpowers/specs/
// 2026-07-11-project-data-model-decision.md) makes a project one shared
// source + N target lanes. This suite pins the invariants of the schema/
// projection slice on a REAL Postgres engine (PGlite + the prod shim):
//
//   1. N=1 back-compat — lane-less events behave byte-identically to before
//      (target_lang = '' everywhere, one target row per cell).
//   2. Two lanes' commits on the same cell coexist as two rows with
//      independent chain heads.
//   3. Chain slots are lane-qualified: both lanes' FIRST commits share the
//      same parent (the source head) and must both win their slot — via
//      laneQualifiedParentKey (live claim) and isWinningChild (pre-check).
//   4. A same-lane sibling still loses its slot (AD-2 preserved per lane).
//   5. Lane-scoped delete removes only that lane's row.
//   6. Validation derives per lane: validating lane A's head does not mark
//      lane B validated.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  buildEventProjectionStmts,
  isWinningChild,
  laneOfEvent,
  type PersistedEvent,
} from '../events/event-projection'
import {
  eventQualifiedParentKey,
  laneQualifiedParentKey,
  GENESIS_PARENT_KEY,
} from '../events/chain-claims'
import type { EventKind } from '../events/types'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const PROJECT = 'proj-lanes'
const FILE = 'file-1'
const CELL = 'cell-1'

let seq = 0
function ev(partial: Partial<PersistedEvent> & { kind: EventKind }): PersistedEvent {
  seq += 1
  return {
    id: partial.id ?? `e${seq}`,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    author: 'alice',
    payload: {},
    clientTs: 1000 + seq,
    serverTs: 1000 + seq,
    serverSeq: seq,
    ...partial,
  }
}

async function applyEvents(db: AquillaDb, events: PersistedEvent[]): Promise<void> {
  const stmts: AquillaStatement[] = []
  for (const e of events) buildEventProjectionStmts(db, e, stmts, { deferFileCounters: true })
  for (const s of stmts) await s.run()
}

async function insertEventRow(db: AquillaDb, e: PersistedEvent): Promise<void> {
  await db
    .prepare(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      e.id, e.schemaVersion, e.projectId, e.fileId, e.cellId, e.parentId ?? null,
      e.kind, e.author, JSON.stringify(e.payload), e.clientTs, e.serverTs, e.serverSeq ?? 0,
    )
    .run()
}

interface LaneCellRow {
  cell_id: string
  side: string
  target_lang: string
  value: string
  event_id: string
  validated: number
}

let t: TestDb
beforeEach(async () => {
  if (!t) t = await makeTestDb()
  else await t.reset()
  seq = 0
})
afterAll(async () => {
  await t?.close()
})

async function laneRows(): Promise<LaneCellRow[]> {
  const rows = await t.rows<LaneCellRow>('cells')
  return rows.sort((a, b) => a.side.localeCompare(b.side) || a.target_lang.localeCompare(b.target_lang))
}

describe('laneOfEvent', () => {
  it("is '' for non-target kinds and lane-less target events", () => {
    expect(laneOfEvent('source.cell.create', { targetLang: 'fr' })).toBe('')
    expect(laneOfEvent('target.cell.commit', {})).toBe('')
    expect(laneOfEvent('target.cell.commit', { targetLang: '' })).toBe('')
  })
  it('reads the lane from target.cell.* payloads', () => {
    expect(laneOfEvent('target.cell.commit', { targetLang: 'fr' })).toBe('fr')
    expect(laneOfEvent('target.cell.delete', { targetLang: 'swh' })).toBe('swh')
  })
})

describe('laneQualifiedParentKey', () => {
  it('keeps the legacy key for the default lane (N=1 back-compat)', () => {
    expect(laneQualifiedParentKey(null, undefined)).toBe(GENESIS_PARENT_KEY)
    expect(laneQualifiedParentKey('evt-1', undefined)).toBe('evt-1')
    expect(laneQualifiedParentKey('evt-1', '')).toBe('evt-1')
  })

  it('keeps source corrections independent from targets pinned to the same head', () => {
    expect(eventQualifiedParentKey('src-head', 'source.cell.create', {}))
      .toBe('src-head@side:source')
    expect(eventQualifiedParentKey('src-head', 'target.cell.commit', {}))
      .toBe('src-head')
    expect(eventQualifiedParentKey('src-head', 'target.cell.commit', { targetLang: 'fr' }))
      .toBe('src-head@lane:fr')
  })
  it('qualifies non-default lanes so sibling lanes get distinct slots', () => {
    const a = laneQualifiedParentKey('src-head', 'fr')
    const b = laneQualifiedParentKey('src-head', 'swh')
    const legacy = laneQualifiedParentKey('src-head', undefined)
    expect(a).not.toBe(b)
    expect(a).not.toBe(legacy)
    expect(a).toBe('src-head@lane:fr')
  })
})

describe('projection — two lanes on one cell', () => {
  it('N=1: a lane-less commit lands on target_lang = "" exactly as before', async () => {
    await applyEvents(t.db, [
      ev({ kind: 'source.cell.create', id: 'src-1', payload: { cellId: CELL, value: 'Hello' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-1', parentId: 'src-1', payload: { value: 'Bonjour' } }),
    ])
    const rows = await laneRows()
    expect(rows).toHaveLength(2)
    const target = rows.find((r) => r.side === 'target')!
    expect(target.target_lang).toBe('')
    expect(target.value).toBe('Bonjour')
    expect(target.event_id).toBe('tc-1')
  })

  it('two lanes commit independently: two target rows, independent heads', async () => {
    await applyEvents(t.db, [
      ev({ kind: 'source.cell.create', id: 'src-1', payload: { cellId: CELL, value: 'Hello' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-fr', parentId: 'src-1', payload: { value: 'Bonjour', targetLang: 'fr' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-swh', parentId: 'src-1', payload: { value: 'Habari', targetLang: 'swh' } }),
    ])
    const targets = (await laneRows()).filter((r) => r.side === 'target')
    expect(targets.map((r) => [r.target_lang, r.value, r.event_id])).toEqual([
      ['fr', 'Bonjour', 'tc-fr'],
      ['swh', 'Habari', 'tc-swh'],
    ])

    // A follow-up commit on fr moves ONLY fr's head.
    await applyEvents(t.db, [
      ev({ kind: 'target.cell.commit', id: 'tc-fr2', parentId: 'tc-fr', payload: { value: 'Salut', targetLang: 'fr' } }),
    ])
    const after = (await laneRows()).filter((r) => r.side === 'target')
    expect(after.find((r) => r.target_lang === 'fr')!.value).toBe('Salut')
    expect(after.find((r) => r.target_lang === 'swh')!.value).toBe('Habari')
    expect(after.find((r) => r.target_lang === 'swh')!.event_id).toBe('tc-swh')
  })

  it('a default-lane commit coexists with named lanes', async () => {
    await applyEvents(t.db, [
      ev({ kind: 'source.cell.create', id: 'src-1', payload: { cellId: CELL, value: 'Hello' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-def', parentId: 'src-1', payload: { value: 'Hallo' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-fr', parentId: 'src-1', payload: { value: 'Bonjour', targetLang: 'fr' } }),
    ])
    const targets = (await laneRows()).filter((r) => r.side === 'target')
    expect(targets.map((r) => [r.target_lang, r.value])).toEqual([
      ['', 'Hallo'],
      ['fr', 'Bonjour'],
    ])
  })

  it('lane-scoped delete removes only that lane', async () => {
    await applyEvents(t.db, [
      ev({ kind: 'source.cell.create', id: 'src-1', payload: { cellId: CELL, value: 'Hello' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-fr', parentId: 'src-1', payload: { value: 'Bonjour', targetLang: 'fr' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-swh', parentId: 'src-1', payload: { value: 'Habari', targetLang: 'swh' } }),
      ev({ kind: 'target.cell.delete', id: 'td-fr', parentId: 'tc-fr', payload: { targetLang: 'fr' } }),
    ])
    const rows = await laneRows()
    expect(rows.filter((r) => r.side === 'target').map((r) => r.target_lang)).toEqual(['swh'])
    // Source row untouched.
    expect(rows.filter((r) => r.side === 'source')).toHaveLength(1)
  })

  it('validation derives per lane: validating fr leaves swh unvalidated', async () => {
    await applyEvents(t.db, [
      ev({ kind: 'source.cell.create', id: 'src-1', payload: { cellId: CELL, value: 'Hello' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-fr', parentId: 'src-1', payload: { value: 'Bonjour', targetLang: 'fr' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-swh', parentId: 'src-1', payload: { value: 'Habari', targetLang: 'swh' } }),
      // AQU-538 slice 2: validate events carry the lane; validating fr's head
      // marks only the fr row (a lane-less validate would address the '' lane).
      ev({ kind: 'cell.validate', author: 'reviewer', payload: { editEventId: 'tc-fr', targetLang: 'fr' } }),
    ])
    const targets = (await laneRows()).filter((r) => r.side === 'target')
    expect(targets.find((r) => r.target_lang === 'fr')!.validated).toBe(1)
    expect(targets.find((r) => r.target_lang === 'swh')!.validated).toBe(0)
  })
})

describe('isWinningChild — lane-aware sibling arbitration', () => {
  it('a source correction and target commit can share a source parent', async () => {
    const target = ev({
      kind: 'target.cell.commit', id: 'tc-default', parentId: 'src-1',
      payload: { value: 'Bonjour' },
    })
    await insertEventRow(t.db, target)

    const source = ev({
      kind: 'source.cell.create', id: 'src-2', parentId: 'src-1',
      payload: { cellId: CELL, value: 'Corrected source' },
    })
    await insertEventRow(t.db, source)
    expect(await isWinningChild(t.db, source)).toBe(true)
  })

  it('two lanes\' first commits share a parent but both win their slots', async () => {
    const frCommit = ev({
      kind: 'target.cell.commit', id: 'tc-fr', parentId: 'src-1',
      payload: { value: 'Bonjour', targetLang: 'fr' },
    })
    await insertEventRow(t.db, frCommit)

    // A LATER swh commit on the same parent is NOT blocked by fr's commit.
    const swhCommit = ev({
      kind: 'target.cell.commit', id: 'tc-swh', parentId: 'src-1',
      payload: { value: 'Habari', targetLang: 'swh' },
    })
    await insertEventRow(t.db, swhCommit)
    expect(await isWinningChild(t.db, swhCommit)).toBe(true)

    // And a default-lane commit is not blocked by either named lane.
    const defCommit = ev({
      kind: 'target.cell.commit', id: 'tc-def', parentId: 'src-1',
      payload: { value: 'Hallo' },
    })
    await insertEventRow(t.db, defCommit)
    expect(await isWinningChild(t.db, defCommit)).toBe(true)
  })

  it('a same-lane sibling still loses (AD-2 preserved per lane)', async () => {
    const first = ev({
      kind: 'target.cell.commit', id: 'tc-fr-1', parentId: 'src-1',
      payload: { value: 'Bonjour', targetLang: 'fr' },
    })
    const second = ev({
      kind: 'target.cell.commit', id: 'tc-fr-2', parentId: 'src-1',
      payload: { value: 'Salut', targetLang: 'fr' },
    })
    await insertEventRow(t.db, first)
    await insertEventRow(t.db, second)
    expect(await isWinningChild(t.db, first)).toBe(true) // idempotent replay of the winner
    expect(await isWinningChild(t.db, second)).toBe(false) // stale sibling, same lane
  })

  it('default-lane siblings still lose to each other (legacy behavior intact)', async () => {
    const first = ev({ kind: 'target.cell.commit', id: 'tc-1', parentId: 'src-1', payload: { value: 'a' } })
    const second = ev({ kind: 'target.cell.commit', id: 'tc-2', parentId: 'src-1', payload: { value: 'b' } })
    await insertEventRow(t.db, first)
    await insertEventRow(t.db, second)
    expect(await isWinningChild(t.db, second)).toBe(false)
  })
})
