// Tests for buildEventProjectionStmts. Validates the SQL + bindings emitted
// for each event kind without hitting a real D1 database.
//
// The D1Database stub records (sql, args) pairs per prepared statement so we
// can assert on exactly what SQL and what bound values were generated.

import { describe, it, expect } from 'vitest'
import {
  buildEventProjectionStmts,
  contentHash,
  type PersistedEvent,
} from '../events/event-projection'

// ── D1 stub ──────────────────────────────────────────────────────────────────

interface RecordedStmt {
  sql: string
  args: unknown[]
}

function makeD1Stub() {
  const recorded: RecordedStmt[] = []

  // A prepared statement stub whose bind() records (sql, args) and returns
  // a fake D1PreparedStatement that satisfies the type. The caller only ever
  // pushes the bound statement into the stmts array -- it doesn't call .run()
  // or .all() directly -- so we only need bind().
  function makePrepared(sql: string): D1PreparedStatement {
    const stmt = {
      bind(...args: unknown[]): D1PreparedStatement {
        recorded.push({ sql: sql.replace(/\s+/g, ' ').trim(), args })
        return this as unknown as D1PreparedStatement
      },
      // The following are never called in unit tests but are required by the
      // D1PreparedStatement interface. They throw to catch accidental usage.
      first: () => Promise.reject(new Error('stub: first() not implemented')),
      run: () => Promise.reject(new Error('stub: run() not implemented')),
      all: () => Promise.reject(new Error('stub: all() not implemented')),
      raw: () => Promise.reject(new Error('stub: raw() not implemented')),
    } as unknown as D1PreparedStatement
    return stmt
  }

  const db = {
    prepare(sql: string) {
      return makePrepared(sql)
    },
    batch: () => Promise.resolve([]),
    dump: () => Promise.resolve(new ArrayBuffer(0)),
    exec: () => Promise.resolve({ count: 0, duration: 0 }),
  } as unknown as D1Database

  return { db, recorded }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent<K extends PersistedEvent['kind']>(
  kind: K,
  payload: unknown,
  overrides: Partial<PersistedEvent> = {},
): PersistedEvent<K> {
  return {
    id: 'evt-test-id',
    schemaVersion: 1,
    projectId: 'proj-1',
    fileId: 'file-a',
    cellId: 'cell-1',
    kind,
    author: 'alice',
    payload,
    clientTs: 1000,
    serverTs: 2000,
    ...overrides,
  } as PersistedEvent<K>
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('contentHash', () => {
  it('returns an 8-char hex string', () => {
    expect(contentHash('hello')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is stable -- same text always hashes to the same value', () => {
    expect(contentHash('Genesis 1:1')).toBe(contentHash('Genesis 1:1'))
  })

  it('changes when text changes', () => {
    expect(contentHash('abc')).not.toBe(contentHash('abd'))
  })
})

describe('buildEventProjectionStmts', () => {
  describe('cell.commit', () => {
    it('produces a cells UPSERT with the correct column values', () => {
      const { db, recorded } = makeD1Stub()
      const stmts: D1PreparedStatement[] = []
      const text = 'In the beginning God created the heavens and the earth'

      buildEventProjectionStmts(
        db,
        makeEvent('cell.commit', { value: text, valueHtml: '<p>' + text + '</p>' }),
        stmts,
      )

      expect(stmts).toHaveLength(1)
      expect(recorded).toHaveLength(1)

      const { sql, args } = recorded[0]
      expect(sql).toContain('INSERT INTO cells')
      expect(sql).toContain('edit_count')
      expect(sql).toContain('ON CONFLICT(file_id, cell_id)')
      expect(sql).toContain('WHERE excluded.last_edit_at > cells.last_edit_at')

      // Positional bindings: file_id, cell_id, content_text, content_hash,
      //   word_count, last_editor, last_edit_at, projected_from
      expect(args[0]).toBe('file-a')           // file_id
      expect(args[1]).toBe('cell-1')           // cell_id
      expect(args[2]).toBe(text)               // content_text
      expect(args[3]).toBe(contentHash(text))  // content_hash (djb2)
      // validated is hardcoded 0 in the INSERT literal, not a bind param
      expect(args[4]).toBe(10)                 // word_count
      expect(args[5]).toBe('alice')            // last_editor
      expect(args[6]).toBe(2000)               // last_edit_at = serverTs
      expect(args[7]).toBe('event:evt-test-id') // projected_from
    })

    it('computes word_count correctly for multi-word and empty text', () => {
      const { db: db1, recorded: r1 } = makeD1Stub()
      const stmts1: D1PreparedStatement[] = []
      buildEventProjectionStmts(
        db1,
        makeEvent('cell.commit', { value: 'one two three', valueHtml: '' }),
        stmts1,
      )
      expect(r1[0].args[4]).toBe(3)

      const { db: db2, recorded: r2 } = makeD1Stub()
      const stmts2: D1PreparedStatement[] = []
      buildEventProjectionStmts(
        db2,
        makeEvent('cell.commit', { value: '', valueHtml: '' }),
        stmts2,
      )
      expect(r2[0].args[4]).toBe(0)
    })

    it('throws when fileId is missing', () => {
      const { db } = makeD1Stub()
      expect(() =>
        buildEventProjectionStmts(
          db,
          makeEvent('cell.commit', { value: 'x', valueHtml: '' }, { fileId: null }),
          [],
        )
      ).toThrow(/fileId/)
    })
  })

  describe('idempotency', () => {
    it('replaying the same cell.commit event twice leaves the cells row unchanged (LWW guard)', () => {
      // The D1 stub in this file only records SQL/args; it doesn't maintain real
      // state. We verify idempotency at the SQL level: the second apply produces
      // the same statement with identical args, and the ON CONFLICT WHERE guard
      // (excluded.last_edit_at > cells.last_edit_at) prevents any mutation when
      // the timestamp is equal.
      const { db, recorded } = makeD1Stub()
      const stmts: D1PreparedStatement[] = []
      const event = makeEvent('cell.commit', { value: 'hello', valueHtml: '<p>hello</p>' })

      buildEventProjectionStmts(db, event, stmts)
      buildEventProjectionStmts(db, event, stmts)

      // Two statements emitted -- both are the same SQL shape and same args.
      expect(stmts).toHaveLength(2)
      expect(recorded[0].sql).toBe(recorded[1].sql)
      expect(recorded[0].args).toEqual(recorded[1].args)
      // Both include the LWW WHERE guard that prevents clobbering on equal ts.
      expect(recorded[0].sql).toContain('WHERE excluded.last_edit_at > cells.last_edit_at')
    })
  })

  describe('cell.validate', () => {
    it('produces TWO statements: cell_validators UPSERT with is_active=1 + cells.validated recompute', () => {
      const { db, recorded } = makeD1Stub()
      const stmts: D1PreparedStatement[] = []

      buildEventProjectionStmts(
        db,
        makeEvent('cell.validate', { editEventId: 'evt-commit-id' }),
        stmts,
      )

      expect(stmts).toHaveLength(2)
      expect(recorded).toHaveLength(2)

      const { sql, args } = recorded[0]
      expect(sql).toContain('INSERT INTO cell_validators')
      expect(sql).toContain('ON CONFLICT(project_id, file_id, cell_id, edit_event_id, username)')
      expect(sql).toContain('WHERE excluded.decided_ts > cell_validators.decided_ts')

      expect(args[0]).toBe('proj-1')         // project_id
      expect(args[1]).toBe('file-a')         // file_id
      expect(args[2]).toBe('cell-1')         // cell_id
      expect(args[3]).toBe('evt-commit-id')  // edit_event_id
      expect(args[4]).toBe('alice')          // username
      // is_active=1 is in the SQL literal, not a bind param
      expect(args[5]).toBe(2000)             // decided_ts = serverTs

      // Second statement: recompute cells.validated
      const { sql: sql2, args: args2 } = recorded[1]
      expect(sql2).toContain('UPDATE cells')
      expect(sql2).toContain('SET validated')
      expect(sql2).toContain('cell_validators')
      expect(sql2).toContain('projected_from')
      expect(args2[0]).toBe('proj-1')  // project_id for subquery
      expect(args2[1]).toBe('file-a')  // file_id for subquery
      expect(args2[2]).toBe('cell-1')  // cell_id for subquery
      expect(args2[3]).toBe('evt-commit-id') // legacy fallback edit id
      expect(args2[4]).toBe('file-a')  // file_id for WHERE
      expect(args2[5]).toBe('cell-1')  // cell_id for WHERE
    })

    it('throws when fileId is missing', () => {
      const { db } = makeD1Stub()
      expect(() =>
        buildEventProjectionStmts(
          db,
          makeEvent('cell.validate', { editEventId: 'e1' }, { fileId: null }),
          [],
        )
      ).toThrow(/fileId/)
    })

    it('throws when cellId is missing', () => {
      const { db } = makeD1Stub()
      expect(() =>
        buildEventProjectionStmts(
          db,
          makeEvent('cell.validate', { editEventId: 'e1' }, { cellId: null }),
          [],
        )
      ).toThrow(/cellId/)
    })
  })

  describe('cell.unvalidate', () => {
    it('produces TWO statements: cell_validators UPSERT with is_active=0 + cells.validated recompute', () => {
      const { db, recorded } = makeD1Stub()
      const stmts: D1PreparedStatement[] = []

      buildEventProjectionStmts(
        db,
        makeEvent('cell.unvalidate', { editEventId: 'evt-commit-id' }),
        stmts,
      )

      expect(stmts).toHaveLength(2)
      expect(recorded).toHaveLength(2)

      const { sql, args } = recorded[0]
      expect(sql).toContain('INSERT INTO cell_validators')
      // is_active=0 appears literally in the SQL (not as a bind param)
      expect(sql).toContain(', 0, ?)')
      expect(args[0]).toBe('proj-1')
      expect(args[3]).toBe('evt-commit-id')
      expect(args[5]).toBe(2000)

      // Second statement: recompute cells.validated
      const { sql: sql2, args: args2 } = recorded[1]
      expect(sql2).toContain('UPDATE cells')
      expect(sql2).toContain('SET validated')
      expect(sql2).toContain('projected_from')
      expect(args2[3]).toBe('evt-commit-id') // legacy fallback edit id
      expect(args2[4]).toBe('file-a')  // file_id for WHERE
      expect(args2[5]).toBe('cell-1')  // cell_id for WHERE
    })

    it('throws when fileId is missing', () => {
      const { db } = makeD1Stub()
      expect(() =>
        buildEventProjectionStmts(
          db,
          makeEvent('cell.unvalidate', { editEventId: 'e1' }, { fileId: null }),
          [],
        )
      ).toThrow(/fileId/)
    })

    it('throws when cellId is missing', () => {
      const { db } = makeD1Stub()
      expect(() =>
        buildEventProjectionStmts(
          db,
          makeEvent('cell.unvalidate', { editEventId: 'e1' }, { cellId: null }),
          [],
        )
      ).toThrow(/cellId/)
    })
  })

  describe('cell.metadata.set', () => {
    it('produces NO statements (Phase 0 no-op)', () => {
      // cell.metadata.set is deferred until Phase 4 when the cells table
      // gains dedicated columns for these fields. For now it's a documented
      // no-op so replay doesn't fail on metadata events in the log.
      const { db } = makeD1Stub()
      const stmts: D1PreparedStatement[] = []

      buildEventProjectionStmts(
        db,
        makeEvent('cell.metadata.set', { field: 'cellLabel', value: 'v1' }),
        stmts,
      )

      expect(stmts).toHaveLength(0)
    })
  })

  describe('thread.add / thread.resolve', () => {
    it('thread.add produces NO statements (Phase 0 no-op)', () => {
      const { db } = makeD1Stub()
      const stmts: D1PreparedStatement[] = []

      buildEventProjectionStmts(
        db,
        makeEvent('thread.add', { threadId: 't1', content: 'hello' }),
        stmts,
      )

      expect(stmts).toHaveLength(0)
    })

    it('thread.resolve produces NO statements (Phase 0 no-op)', () => {
      const { db } = makeD1Stub()
      const stmts: D1PreparedStatement[] = []

      buildEventProjectionStmts(
        db,
        makeEvent('thread.resolve', { threadId: 't1' }),
        stmts,
      )

      expect(stmts).toHaveLength(0)
    })
  })

  describe('unknown kind', () => {
    it('throws an error for an unrecognised event kind', () => {
      const { db } = makeD1Stub()
      expect(() =>
        buildEventProjectionStmts(
          db,
          // @ts-expect-error intentionally passing unknown kind
          makeEvent('cell.unknown.future', {}),
          [],
        )
      ).toThrow(/unknown event kind/)
    })
  })
})
