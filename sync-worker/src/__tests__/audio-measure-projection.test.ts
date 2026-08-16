// Pre-merge round: cell.audio.measure — duration backfill for takes that
// predate duration capture (their chips draw at fallback width, and Free
// timing cannot lay them out). Deliberately NOT a re-attach: the attach
// UPSERT re-selects the clip and plain-assigns trims, which a backfill of an
// arbitrary, possibly non-selected take must never do. COALESCE makes it
// fill-only, so replays and races with a genuine re-attach are no-ops.

import { describe, it, expect } from 'vitest'
import {
  buildEventProjectionStmts,
  isChainMutatingKind,
  type PersistedEvent,
} from '../events/event-projection'
import { REQUIRED_ROLE } from '../events/role-policy'
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

function makeEvent<K extends EventKind>(kind: K, payload: EventPayloads[K]): PersistedEvent<K> {
  return {
    id: 'evt-1',
    schemaVersion: 1,
    projectId: 'proj-1',
    fileId: 'file-a',
    cellId: 'cell-1',
    parentId: null,
    kind,
    author: 'sam',
    payload,
    clientTs: 1000,
    serverTs: 2000,
    serverSeq: 9,
  } as PersistedEvent<K>
}

describe('cell.audio.measure', () => {
  it('is contributor-gated and non-chain-mutating', () => {
    expect(REQUIRED_ROLE['cell.audio.measure']).toBe(400)
    expect(isChainMutatingKind('cell.audio.measure')).toBe(false)
  })

  it('fills only a NULL duration — COALESCE keeps an existing measurement', () => {
    const { db, recorded } = makeRecordingDb()
    const touches = buildEventProjectionStmts(
      db,
      makeEvent('cell.audio.measure', { audioId: 'a1', durationMs: 4180 }),
      [],
    )
    expect(touches).toContain('cell_audio')
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain('SET duration_ms = COALESCE(duration_ms, ?)')
    expect(recorded[0].args[0]).toBe(4180)
    expect(recorded[0].args).toContain('a1')
  })

  it('never touches selection, url, slot, trims, or timings', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent('cell.audio.measure', { audioId: 'a1', durationMs: 900 }), [])
    const sql = recorded[0].sql
    expect(sql).not.toContain('selected')
    expect(sql).not.toContain('url')
    expect(sql).not.toContain('slot')
    expect(sql).not.toContain('trim_')
    expect(sql).not.toContain('timings')
    expect(sql).not.toContain('label')
  })

  it('scopes the update to the exact take', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent('cell.audio.measure', { audioId: 'a1', durationMs: 900 }), [])
    expect(recorded[0].sql).toContain(
      'WHERE project_id = ? AND file_id = ? AND cell_id = ? AND audio_id = ?',
    )
    expect(recorded[0].args).toEqual([900, 'proj-1', 'file-a', 'cell-1', 'a1'])
  })
})
