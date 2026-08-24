// Edges between the two cue lists. (AQU-646 stage 4, 2026-08-14)
//
// An episode ships a SUBTITLE VTT (what gets translated) and an AUDIO VTT (a
// transcript of what is heard, and what the picture demands when recording).
// They deliberately disagree in segmentation, so the relationship is
// many-to-many and a link is one pairwise edge.
//
// Two properties are load-bearing and are what this file pins:
//   - the ENDPOINTS are the primary key, so re-delivery and log replay are
//     no-ops rather than duplicate edges;
//   - an unlink is a TOMBSTONE, so replaying the import-time linker (which
//     writes ~650 events in one go) cannot resurrect an edge a person removed.

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
    // The SUBTITLE side rides the envelope; the audio cue rides the payload.
    fileId: 'file-subs',
    cellId: 'sub-12',
    parentId: null,
    kind,
    author: 'sam',
    payload,
    clientTs: 1000,
    serverTs: 2000,
    serverSeq: 9,
  } as PersistedEvent<K>
}

const link = (over: Partial<EventPayloads['cell.link.set']> = {}): EventPayloads['cell.link.set'] => ({
  kind: 'text-audio',
  toFileId: 'file-cues',
  toCellId: 'cue-7',
  linked: true,
  origin: 'auto',
  confidence: 0.92,
  ...over,
})

describe('cell.link.set', () => {
  it('is lead-gated and non-chain-mutating', () => {
    // AQU-646 (Sam, 2026-08-18): raised from 400 to 500. The pairings are
    // settled during setup and handed off; a contributor re-cutting one
    // silently moves which line a recording belongs to, for everyone. It still
    // never moves the cell's own text chain.
    expect(REQUIRED_ROLE['cell.link.set']).toBe(500)
    expect(isChainMutatingKind('cell.link.set')).toBe(false)
  })

  it('writes one row keyed by BOTH endpoints, so replay cannot duplicate it', () => {
    const { db, recorded } = makeRecordingDb()
    const touches = buildEventProjectionStmts(db, makeEvent('cell.link.set', link()), [])
    expect(touches).toEqual(['cell_links'])
    expect(recorded).toHaveLength(1)
    const [stmt] = recorded
    expect(stmt.sql).toContain('INSERT INTO cell_links')
    expect(stmt.sql).toContain(
      'ON CONFLICT(project_id, kind, from_file_id, from_cell_id, to_file_id, to_cell_id)',
    )
    expect(stmt.args).toEqual([
      'proj-1', 'text-audio', 'file-subs', 'sub-12', 'file-cues', 'cue-7',
      1, 'auto', 0.92, 'evt-1', 2000,
    ])
  })

  it('unlinks as a TOMBSTONE — the row stays, linked goes to 0', () => {
    // If an unlink deleted the row, replaying the import-time linker's own
    // event afterwards would resurrect an edge a person deliberately removed.
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent('cell.link.set', link({ linked: false, origin: 'manual', confidence: null })),
      [],
    )
    const [stmt] = recorded
    expect(stmt.sql).not.toContain('DELETE')
    expect(stmt.args[6]).toBe(0)
    expect(stmt.args[7]).toBe('manual')
    expect(stmt.args[8]).toBeNull()
  })

  it('PLAIN-ASSIGNS linked on conflict — the payload always states it', () => {
    // Deliberately NOT a COALESCE, and the opposite of the cell.audio.attach
    // rule one file over. There the trim columns had to be COALESCEd because
    // an attach may legitimately have no opinion about them; here `linked` is
    // required-and-boolean, so "no opinion" is not expressible and a COALESCE
    // would make an unlink silently do nothing.
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent('cell.link.set', link()), [])
    expect(recorded[0].sql).toContain('linked = excluded.linked')
    expect(recorded[0].sql).not.toContain('COALESCE(excluded.linked')
  })

  it('does not overwrite created_ts — that is when the edge first appeared', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent('cell.link.set', link()), [])
    const onConflict = recorded[0].sql.slice(recorded[0].sql.indexOf('DO UPDATE SET'))
    expect(onConflict).not.toContain('created_ts')
    expect(onConflict).toContain('event_id = excluded.event_id')
  })

  it('touches nothing but cell_links — never cells, never cell_audio', () => {
    const { db, recorded } = makeRecordingDb()
    const touches = buildEventProjectionStmts(db, makeEvent('cell.link.set', link()), [])
    expect(touches).not.toContain('cells')
    expect(recorded[0].sql).not.toContain('INSERT INTO cells')
    expect(recorded[0].sql).not.toContain('cell_audio')
  })

  it('refuses an event with no subtitle side rather than writing a half edge', () => {
    const { db } = makeRecordingDb()
    const bad = { ...makeEvent('cell.link.set', link()), cellId: null } as PersistedEvent
    expect(() => buildEventProjectionStmts(db, bad, [])).toThrow(/missing fileId or cellId/)
  })
})
