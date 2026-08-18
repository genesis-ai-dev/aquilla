// AQU-927 regression guard: a fractional millisecond value must never reach a
// BIGINT bind.
//
// `cells.start_ms/end_ms` and `cell_audio.duration_ms/trim_start_ms/trim_end_ms`
// are BIGINT. Postgres rejects a fractional literal outright ("invalid input
// syntax for type bigint: \"2403.5\""), and a /events flush is applied as ONE
// batch — so a single stray float from an un-rounded client producer failed
// *every* event in that flush, silently losing whole groups of uploaded audio.
//
// The client now rounds at the source and again at the emit boundary; the
// projection rounds as a last line of defence, which also covers clients still
// running the old code.

import { describe, it, expect } from 'vitest'
import {
  buildEventProjectionStmts,
  coerceIntegerMsPayload,
  type PersistedEvent,
} from '../events/event-projection'
import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'
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

/** Any numeric bind whose magnitude looks like a ms value must be an integer. */
function expectNoFractionalBinds(recorded: RecordedStmt[]) {
  for (const stmt of recorded) {
    for (const arg of stmt.args) {
      if (typeof arg !== 'number' || !Number.isFinite(arg)) continue
      expect(Number.isInteger(arg), `bind ${arg} in "${stmt.sql}" is fractional`).toBe(true)
    }
  }
}

describe('coerceIntegerMsPayload', () => {
  it('rounds every fractional ms key', () => {
    const event = makeEvent('cell.audio.attach', {
      audioId: 'a1',
      url: 'https://cdn/a.webm',
      slot: 'recording',
      durationMs: 2403.5,
      trimStartMs: 120.25,
      trimEndMs: 9586.938,
    } as EventPayloads['cell.audio.attach'])
    const p = coerceIntegerMsPayload(event).payload as Record<string, unknown>
    expect(p.durationMs).toBe(2404)
    expect(p.trimStartMs).toBe(120)
    expect(p.trimEndMs).toBe(9587)
  })

  it('returns the SAME object when nothing needs rounding', () => {
    const event = makeEvent('cell.audio.measure', { audioId: 'a1', durationMs: 4180 })
    expect(coerceIntegerMsPayload(event)).toBe(event)
  })

  it('does not mutate the caller’s payload', () => {
    const payload = { audioId: 'a1', durationMs: 4180.7 }
    const event = makeEvent('cell.audio.measure', payload)
    coerceIntegerMsPayload(event)
    expect(payload.durationMs).toBe(4180.7)
  })

  it('leaves non-numeric and non-finite values alone for the existing guards', () => {
    const event = makeEvent('cell.lane.retime', {
      subtitleStartMs: Number.NaN,
      subtitleEndMs: null,
    } as EventPayloads['cell.lane.retime'])
    const p = coerceIntegerMsPayload(event).payload as Record<string, unknown>
    expect(p.subtitleStartMs).toBeNaN()
    expect(p.subtitleEndMs).toBeNull()
  })

  it('tolerates a non-object payload', () => {
    const event = { ...makeEvent('cell.audio.measure', { audioId: 'a1', durationMs: 1 }), payload: null }
    expect(coerceIntegerMsPayload(event as PersistedEvent).payload).toBeNull()
  })
})

describe('projection binds integer ms into BIGINT columns', () => {
  it('cell.audio.attach — the denoise repro no longer reaches the bind as a float', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent('cell.audio.attach', {
        audioId: 'dn-cell-1.webm',
        url: 'https://cdn/a.webm',
        slot: 'recording',
        durationMs: 2403.5,
        trimStartMs: 120.25,
        trimEndMs: 9586.938,
      } as EventPayloads['cell.audio.attach']),
      [],
    )
    expect(recorded.length).toBeGreaterThan(0)
    expectNoFractionalBinds(recorded)
    const attach = recorded.find((s) => s.sql.includes('duration_ms'))!
    expect(attach.args).toContain(2404)
    expect(attach.args).toContain(9587)
  })

  it('cell.audio.measure — fractional duration backfill', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent('cell.audio.measure', { audioId: 'a1', durationMs: 4180.7 }), [])
    expect(recorded[0].args[0]).toBe(4181)
    expectNoFractionalBinds(recorded)
  })

  it('cell.retime — fractional segment bounds', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent('cell.retime', { startMs: 400.4, endMs: 6000.6 }), [])
    expect(recorded[0].args.slice(0, 2)).toEqual([400, 6001])
    expectNoFractionalBinds(recorded)
  })

  it('integer ms projects byte-identically (no regression)', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent('cell.audio.measure', { audioId: 'a1', durationMs: 900 }), [])
    expect(recorded[0].args).toEqual([900, 'proj-1', 'file-a', 'cell-1', 'a1'])
  })
})
