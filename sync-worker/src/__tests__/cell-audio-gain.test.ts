// AQU-2327: a take's volume and fades are data on the clip, like its trim —
// set by their own event, all three always stated, never a new recording.
import { describe, it, expect } from 'vitest'
import { buildEventProjectionStmts, isChainMutatingKind, type PersistedEvent } from '../events/event-projection'
import { REQUIRED_ROLE } from '../events/role-policy'
import type { EventKind, EventPayloads } from '../events/types'

function makeRecordingDb() {
  const recorded: Array<{ sql: string; args: unknown[] }> = []
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
    id: 'evt-1', schemaVersion: 1, projectId: 'proj-1', fileId: 'file-a', cellId: 'cell-1', parentId: null,
    kind, author: 'sam', payload, clientTs: 1000, serverTs: 2000, serverSeq: 9,
  } as PersistedEvent<K>
}

describe('cell.audio.gain', () => {
  it('needs what a trim needs and never moves the text chain', () => {
    expect(REQUIRED_ROLE['cell.audio.gain']).toBe(REQUIRED_ROLE['cell.audio.trim'])
    expect(isChainMutatingKind('cell.audio.gain')).toBe(false)
  })

  it('sets the three level columns and nothing else — votes stay, as with a trim', () => {
    const { db, recorded } = makeRecordingDb()
    const touches = buildEventProjectionStmts(db, makeEvent('cell.audio.gain', { audioId: 'a1', gainDb: -3, fadeInMs: 300, fadeOutMs: null }), [])
    expect(touches).toEqual(['cell_audio'])
    expect(recorded).toHaveLength(1)
    const [stmt] = recorded
    expect(stmt.sql).toContain('SET gain_db = ?, fade_in_ms = ?, fade_out_ms = ?')
    expect(stmt.sql).not.toContain('selected')
    expect(stmt.sql).not.toContain('validator')
    expect(stmt.args.slice(0, 3)).toEqual([-3, 300, null])
    expect(stmt.args).toContain('a1')
  })
})
