// Tests for the cell.lane.retime event (AQU-646 round 6):
//   - Per-LANE presentation timing merged into cells.metadata JSONB on the
//     source row (subtitle_start_ms / subtitle_end_ms / target_start_ms).
//   - NEVER touches cells.start_ms/end_ms (the frozen source split).
//   - Per key: number sets, null clears, undefined no-ops; corrupt values skipped.
//   - Non-chain-mutating; contributor-gated (same floor as cell.retime).

import { describe, it, expect } from 'vitest'
import {
  buildEventProjectionStmts,
  isChainMutatingKind,
  type PersistedEvent,
} from '../events/event-projection'
import { REQUIRED_ROLE } from '../events/role-policy'

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

function makeEvent(
  payload: Record<string, unknown>,
  overrides: Partial<PersistedEvent> = {},
): PersistedEvent<'cell.lane.retime'> {
  return {
    id: 'evt-lane-1',
    schemaVersion: 1,
    projectId: 'proj-1',
    fileId: 'file-a',
    cellId: 'cell-1',
    parentId: null,
    kind: 'cell.lane.retime',
    author: 'sam',
    payload,
    clientTs: 1000,
    serverTs: 2000,
    serverSeq: 99,
    ...overrides,
  } as PersistedEvent<'cell.lane.retime'>
}

describe('cell.lane.retime — classification', () => {
  it('is NOT chain-mutating', () => {
    expect(isChainMutatingKind('cell.lane.retime')).toBe(false)
  })

  it('is contributor-gated, same floor as cell.retime', () => {
    expect(REQUIRED_ROLE['cell.lane.retime']).toBe(REQUIRED_ROLE['cell.retime'])
  })
})

describe('cell.lane.retime — projection', () => {
  it('sets both subtitle keys via source-side JSONB merges; start_ms untouched', () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(
      db,
      makeEvent({ subtitleStartMs: 1500, subtitleEndMs: 4200 }),
      stmts,
    )
    expect(touches).toContain('cells')
    expect(recorded).toHaveLength(2)
    expect(recorded[0].sql).toContain("jsonb_build_object('subtitle_start_ms'")
    expect(recorded[0].sql).toContain("side = 'source'")
    expect(recorded[0].args[0]).toBe(1500)
    expect(recorded[1].sql).toContain("jsonb_build_object('subtitle_end_ms'")
    expect(recorded[1].args[0]).toBe(4200)
    for (const s of recorded) {
      expect(s.sql).not.toContain('start_ms = ')
      expect(s.sql).not.toContain('end_ms = ')
    }
  })

  it('sets target_start_ms alone without touching subtitle keys', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ targetStartMs: 9000 }), [])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain("jsonb_build_object('target_start_ms'")
    expect(recorded[0].sql).not.toContain('subtitle')
  })

  it('null clears a key (metadata - key), preserving the rest of metadata', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ targetStartMs: null }), [])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain("metadata - 'target_start_ms'")
    expect(recorded[0].sql).toContain("side = 'source'")
  })

  it('mixed set + clear in one event emits one statement per provided key', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent({ subtitleStartMs: 100, subtitleEndMs: 900, targetStartMs: null }),
      [],
    )
    expect(recorded).toHaveLength(3)
    expect(recorded[2].sql).toContain("metadata - 'target_start_ms'")
  })

  it('skips corrupt (non-number, non-null) values instead of writing them', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent({ subtitleStartMs: 'oops', targetStartMs: 5000 } as Record<string, unknown>),
      [],
    )
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain("jsonb_build_object('target_start_ms'")
  })

  it('rounds fractional milliseconds', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ targetStartMs: 1234.6 }), [])
    expect(recorded[0].args[0]).toBe(1235)
  })
})
