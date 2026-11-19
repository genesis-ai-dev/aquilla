// Tests for the cell.lane.retime event (AQU-646 round 6):
//   - Per-LANE presentation timing merged into cells.metadata JSONB on the
//     source row (subtitle_start_ms / subtitle_end_ms / target_start_ms).
//   - NEVER touches cells.start_ms/end_ms (the frozen source split).
//   - Per key: number sets, null clears, undefined no-ops; corrupt values skipped.
//   - Non-chain-mutating; contributor-gated (same floor as cell.retime).

import { describe, it, expect } from 'vitest'
import {
  buildEventProjectionStmts,
  coerceIntegerMsPayload,
  isChainMutatingKind,
  type PersistedEvent,
} from '../events/event-projection'
import { LINE_ROOM_MAX_MS } from '../events/line-room-authority'
import { REQUIRED_ROLE } from '../events/role-policy'
import { isLockedTimingEvent } from '../events/timing-authority'

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

// AQU-646 round 8: the dub anchor became RELATIVE to the cell (target_offset_ms)
// so a take travels with its line. The absolute key stays projected forever —
// rebuild.ts replays historical events, so it can never be retired.
describe('cell.lane.retime — target_offset_ms', () => {
  it('sets the offset alone, leaving the legacy absolute key alone', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ targetOffsetMs: 2000 }), [])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain("jsonb_build_object('target_offset_ms'")
    expect(recorded[0].sql).not.toContain('target_start_ms')
    expect(recorded[0].args[0]).toBe(2000)
  })

  it('a NEGATIVE offset survives — a take may lead its line', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ targetOffsetMs: -1500 }), [])
    expect(recorded[0].args[0]).toBe(-1500)
  })

  it('an offset of exactly 0 writes, rather than being skipped as falsy', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ targetOffsetMs: 0 }), [])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].args[0]).toBe(0)
  })

  it('null clears the offset', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ targetOffsetMs: null }), [])
    expect(recorded[0].sql).toContain("metadata - 'target_offset_ms'")
  })

  it('a legacy event still projects the absolute key, untouched by the new one', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ targetStartMs: 9000 }), [])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain("jsonb_build_object('target_start_ms'")
    expect(recorded[0].sql).not.toContain('target_offset_ms')
  })
})

// AQU-2432 (Sam, Nov 9): an unrecorded line's ROOM following the recordings.
// One number per line PER LANGUAGE (whether a line is recorded is per
// language), merged into the source row's metadata like the keys above, under
// a key that carries the language: `recordings_room_ms` for the default one,
// `recordings_room_ms:<tag>` for any other. The client reads the same key
// (src/lib/timeline/line-room.ts).
describe('cell.lane.retime — recordingsRoomMs', () => {
  it("the default language's room is stored under the plain key", () => {
    const { db, recorded } = makeRecordingDb()
    const touches = buildEventProjectionStmts(db, makeEvent({ recordingsRoomMs: 1500 }), [])
    expect(touches).toContain('cells')
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain('jsonb_build_object(?::text, ?::bigint)')
    expect(recorded[0].sql).toContain("side = 'source'")
    expect(recorded[0].args.slice(0, 2)).toEqual(['recordings_room_ms', 1500])
  })

  it("another language's room is stored under its own key, so two languages never share one", () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ recordingsRoomMs: 800, targetLang: 'fr' }), [])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].args.slice(0, 2)).toEqual(['recordings_room_ms:fr', 800])
  })

  it('the language tag is bound, never written into the SQL', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ recordingsRoomMs: 800, targetLang: "x'; DROP TABLE cells; --" }), [])
    expect(recorded[0].sql).not.toContain('DROP')
    expect(recorded[0].args[0]).toBe("recordings_room_ms:x'; DROP TABLE cells; --")
  })

  it('a room of exactly 0 writes: the line has no room, which is not "no room stored"', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ recordingsRoomMs: 0 }), [])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].args.slice(0, 2)).toEqual(['recordings_room_ms', 0])
  })

  it('null clears it: the line is back at its natural length', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ recordingsRoomMs: null, targetLang: 'fr' }), [])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain('metadata - ?::text')
    expect(recorded[0].args[0]).toBe('recordings_room_ms:fr')
  })

  it('a negative or corrupt room is skipped, and rounds to whole ms', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ recordingsRoomMs: -5 }), [])
    buildEventProjectionStmts(db, makeEvent({ recordingsRoomMs: 'wide' } as Record<string, unknown>), [])
    expect(recorded).toHaveLength(0)
    buildEventProjectionStmts(db, makeEvent({ recordingsRoomMs: 1234.6 }), [])
    expect(recorded[0].args[1]).toBe(1235)
  })

  it('it is the recordist\'s own work: the timing lock does not cover it', () => {
    expect(isLockedTimingEvent('cell.lane.retime', { recordingsRoomMs: 0 })).toBe(false)
  })

  it('an event without it leaves every room alone', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ subtitleStartMs: 100 }), [])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).not.toContain('?::text')
  })
})

// AQU-2432 (review, Nov 9): a bad room is refused for that field only. A
// number too large for the column used to fail the cast, and with it the whole
// batch of events it was flushed in; now it is skipped like a negative one,
// and the event's other keys still land.
describe('cell.lane.retime — recordingsRoomMs, refused for that field only', () => {
  it('an absurdly large room is skipped, not sent to the database', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ recordingsRoomMs: 1e30 }), [])
    buildEventProjectionStmts(db, makeEvent({ recordingsRoomMs: 9e15 }), [])
    buildEventProjectionStmts(db, makeEvent({ recordingsRoomMs: LINE_ROOM_MAX_MS + 1 }), [])
    expect(recorded).toHaveLength(0)
  })

  it('a day is the most a room can be, and is stored', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ recordingsRoomMs: LINE_ROOM_MAX_MS }), [])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].args.slice(0, 2)).toEqual(['recordings_room_ms', LINE_ROOM_MAX_MS])
  })

  it("a bad room leaves the event's other keys to land", () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent({ subtitleStartMs: 100, recordingsRoomMs: 1e30 }), [])
    buildEventProjectionStmts(db, makeEvent({ subtitleStartMs: 100, recordingsRoomMs: Number.NaN }), [])
    expect(recorded).toHaveLength(2)
    for (const r of recorded) expect(r.sql).toContain("'subtitle_start_ms'")
  })

  it('a fractional room is rounded on the way in, with the other ms keys', () => {
    const ev = coerceIntegerMsPayload(makeEvent({ recordingsRoomMs: 1234.6 }))
    expect((ev.payload as { recordingsRoomMs: number }).recordingsRoomMs).toBe(1235)
  })
})
