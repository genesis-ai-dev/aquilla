// AQU-646 round 8: takes get PERMANENT names.
//   - cell.audio.attach may carry `label` (set at birth); re-attaches WITHOUT
//     one keep the existing name (COALESCE) — trim persists can't wipe it.
//   - cell.audio.rename updates the label ONLY — never selection/trims.

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

describe('cell.audio.attach — label (round 8)', () => {
  it('binds the label on attach and COALESCEs it on conflict (re-attach keeps the name)', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent('cell.audio.attach', {
        audioId: 'a1', url: 'frontier-audio://a1', slot: 'recording', label: 'Take 3',
      }),
      [],
    )
    const upsert = recorded.find((s) => s.sql.includes('INSERT INTO cell_audio'))!
    expect(upsert.sql).toContain('label = COALESCE(excluded.label, cell_audio.label)')
    expect(upsert.args).toContain('Take 3')
  })
})

describe('cell.audio.rename (round 8)', () => {
  it('is contributor-gated and non-chain-mutating', () => {
    expect(REQUIRED_ROLE['cell.audio.rename']).toBe(400)
    expect(isChainMutatingKind('cell.audio.rename')).toBe(false)
  })

  it('updates ONLY the label — never selection or trims', () => {
    const { db, recorded } = makeRecordingDb()
    const touches = buildEventProjectionStmts(
      db,
      makeEvent('cell.audio.rename', { audioId: 'a1', label: 'Best whisper' }),
      [],
    )
    expect(touches).toContain('cell_audio')
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain('SET label = ?')
    expect(recorded[0].sql).not.toContain('selected')
    expect(recorded[0].sql).not.toContain('trim_')
    expect(recorded[0].args[0]).toBe('Best whisper')
    expect(recorded[0].args).toContain('a1')
  })

  it('null clears the label', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent('cell.audio.rename', { audioId: 'a1', label: null }), [])
    expect(recorded[0].args[0]).toBeNull()
  })
})
