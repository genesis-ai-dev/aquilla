// A clip's playback trim window (2026-08-14).
//
// The window used to ride cell.audio.attach, where "clear this window" and "I'm
// not here about the window" were both spelled as an absent field. The
// projection could only guess, and it guessed "clear": the transcription's
// word-timings re-attach lands ~800ms after a take is saved and carries no
// trims, so every recorded take lost the window it had just been given and then
// played (and drew) a few hundred ms early, its anchor shift left un-undone.
//
// The fix is a split:
//   - cell.audio.attach COALESCEs the trim columns — it may SET a window (a
//     clip's birth values) and can never clear one.
//   - cell.audio.trim states BOTH ends, always, so null can mean the clip edge
//     without absence having to mean anything at all.

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

describe('cell.audio.attach — the trim columns', () => {
  // THE REGRESSION. Sam's event log, 2026-08-14: a take attached with
  // trimStartMs 304 and an anchor of -304ms (a perfect cancellation), then a
  // second attach 772ms later carrying only word timings nulled the window,
  // leaving the take anchored early with nothing to undo it. Three takes in a
  // row lost 256 / 304 / 339 ms this way. A plain assignment here is what
  // caused it, so a plain assignment here is what must never come back.
  it('COALESCEs both ends, so a re-attach carrying no trims cannot wipe them', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent('cell.audio.attach', {
        audioId: 'a1',
        url: 'frontier-audio://a1',
        slot: 'recording',
        timings: [{ word: 'hello', t0: 0, t1: 1, start: 0, end: 1 }],
      }),
      [],
    )
    const upsert = recorded.find((s) => s.sql.includes('INSERT INTO cell_audio'))!
    expect(upsert.sql).toContain('trim_start_ms = COALESCE(excluded.trim_start_ms, cell_audio.trim_start_ms)')
    expect(upsert.sql).toContain('trim_end_ms = COALESCE(excluded.trim_end_ms, cell_audio.trim_end_ms)')
    // …and specifically NOT the plain assignment that caused the wipe.
    expect(upsert.sql).not.toContain('trim_start_ms = excluded.trim_start_ms')
    expect(upsert.sql).not.toContain('trim_end_ms = excluded.trim_end_ms')
  })

  it('still binds a birth window — a fresh take attaches already trimmed', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent('cell.audio.attach', {
        audioId: 'a1', url: 'frontier-audio://a1', slot: 'recording',
        durationMs: 3896, trimStartMs: 304, trimEndMs: 3656,
      }),
      [],
    )
    const upsert = recorded.find((s) => s.sql.includes('INSERT INTO cell_audio'))!
    expect(upsert.args).toContain(304)
    expect(upsert.args).toContain(3656)
  })
})

describe('cell.audio.trim', () => {
  it('is contributor-gated and non-chain-mutating', () => {
    expect(REQUIRED_ROLE['cell.audio.trim']).toBe(400)
    expect(isChainMutatingKind('cell.audio.trim')).toBe(false)
  })

  it('updates ONLY the two trim columns — never selection, slot, url or duration', () => {
    const { db, recorded } = makeRecordingDb()
    const touches = buildEventProjectionStmts(
      db,
      makeEvent('cell.audio.trim', { audioId: 'a1', trimStartMs: 250, trimEndMs: 3000 }),
      [],
    )
    expect(touches).toContain('cell_audio')
    // The UPDATE, then AQU-490's pair: trimming changes what a validator
    // heard, so that take's votes are discarded and its count re-derived.
    expect(recorded).toHaveLength(3)
    expect(recorded[1].sql).toContain('DELETE FROM cell_audio_validators')
    expect(recorded[2].sql).toContain('SET validator_count')
    const [stmt] = recorded
    expect(stmt.sql).toContain('SET trim_start_ms = ?, trim_end_ms = ?')
    // Trimming a non-selected generated voice must not promote it over the real
    // take — which a re-attach (selected = 1) used to do on the way past.
    expect(stmt.sql).not.toContain('selected')
    expect(stmt.sql).not.toContain('slot')
    expect(stmt.sql).not.toContain('url')
    expect(stmt.sql).not.toContain('duration_ms')
    expect(stmt.args[0]).toBe(250)
    expect(stmt.args[1]).toBe(3000)
    expect(stmt.args).toContain('a1')
  })

  it('null on either end clears that bound back to the clip edge', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent('cell.audio.trim', { audioId: 'a1', trimStartMs: null, trimEndMs: null }),
      [],
    )
    expect(recorded[0].args[0]).toBeNull()
    expect(recorded[0].args[1]).toBeNull()
  })

  it('scopes the write to one clip on one cell', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent('cell.audio.trim', { audioId: 'a1', trimStartMs: 10, trimEndMs: 20 }),
      [],
    )
    expect(recorded[0].sql).toContain(
      'WHERE project_id = ? AND file_id = ? AND cell_id = ? AND audio_id = ?',
    )
    expect(recorded[0].args).toEqual([10, 20, 'proj-1', 'file-a', 'cell-1', 'a1'])
  })
})
