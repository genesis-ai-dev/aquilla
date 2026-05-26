// Tests for buildEventProjectionStmts.
//
// Validates the SQL + bindings emitted for each event kind. Uses a tiny
// recording D1 stub that captures (sql, args) pairs from prepare().bind().

import { describe, it, expect } from 'vitest'
import {
  buildEventProjectionStmts,
  contentHash,
  type PersistedEvent,
} from '../events/event-projection'
import type { EventKind } from '../events/types'

interface RecordedStmt {
  sql: string
  args: unknown[]
}

function makeD1Stub() {
  const recorded: RecordedStmt[] = []

  function makePrepared(sql: string): D1PreparedStatement {
    const stmt = {
      bind(...args: unknown[]): D1PreparedStatement {
        recorded.push({ sql: sql.replace(/\s+/g, ' ').trim(), args })
        return this as unknown as D1PreparedStatement
      },
      first: () => Promise.reject(new Error('stub: first() not implemented')),
      run: () => Promise.reject(new Error('stub: run() not implemented')),
      all: () => Promise.reject(new Error('stub: all() not implemented')),
      raw: () => Promise.reject(new Error('stub: raw() not implemented')),
    } as unknown as D1PreparedStatement
    return stmt
  }

  const db = {
    prepare(sql: string) { return makePrepared(sql) },
    batch: () => Promise.resolve([]),
    dump: () => Promise.resolve(new ArrayBuffer(0)),
    exec: () => Promise.resolve({ count: 0, duration: 0 }),
  } as unknown as D1Database

  return { db, recorded }
}

function makeEvent<K extends EventKind>(
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
    parentId: null,
    kind,
    author: 'alice',
    payload,
    clientTs: 1000,
    serverTs: 2000,
    serverSeq: 5,
    ...overrides,
  } as PersistedEvent<K>
}

describe('contentHash', () => {
  it('returns an 8-char hex string', () => {
    expect(contentHash('hello')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is stable', () => {
    expect(contentHash('Genesis 1:1')).toBe(contentHash('Genesis 1:1'))
  })

  it('differs for different text', () => {
    expect(contentHash('abc')).not.toBe(contentHash('abd'))
  })
})

describe('buildEventProjectionStmts — source.cell.create', () => {
  it('emits an INSERT INTO cells with side=source and event_id=this event', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []

    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.create', {
        cellId: 'cell-1',
        anchorCellId: null,
        value: 'In the beginning',
        valueHtml: '<p>In the beginning</p>',
        type: 'verse',
        canonicalRef: 'GEN 1:1',
      }),
      stmts,
    )

    // FTS maintenance adds 2 extra statements (delete + insert) around the cells DML.
    expect(stmts).toHaveLength(3)
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts'))
    const { sql, args } = cellsStmts[0]
    expect(sql).toContain('INSERT INTO cells')
    expect(sql).toContain('ON CONFLICT(project_id, file_id, cell_id, side)')
    // 0=project_id, 1=file_id, 2=cell_id, 3=side, 4=value, 5=value_html,
    // 6=type, 7=canonical_ref, 8=anchor_cell_id, 9=event_id,
    // 10=last_editor, 11=last_edit_at, 12=word_count, 13=content_hash
    expect(args[0]).toBe('proj-1')
    expect(args[1]).toBe('file-a')
    expect(args[2]).toBe('cell-1')
    expect(args[3]).toBe('source')
    expect(args[4]).toBe('In the beginning')
    expect(args[6]).toBe('verse')
    expect(args[7]).toBe('GEN 1:1')
    expect(args[9]).toBe('evt-test-id')
  })
})

describe('buildEventProjectionStmts — target.cell.create', () => {
  it('emits an INSERT INTO cells with side=target', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('target.cell.create', {
        cellId: 'cell-1',
        value: 'hello',
        anchorCellId: 'cell-0',
      }),
      stmts,
    )
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts'))
    const { args } = cellsStmts[0]
    expect(args[3]).toBe('target')
    expect(args[8]).toBe('cell-0')   // anchor_cell_id
    expect(args[9]).toBe('evt-test-id') // event_id
  })
})

describe('buildEventProjectionStmts — target.cell.commit', () => {
  it('UPSERTs value, event_id, and source_event_id (first commit creates the target row)', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('target.cell.commit', {
        value: 'new text',
        valueHtml: '<p>new text</p>',
        sourceEventId: 'src-event-99',
      }),
      stmts,
    )
    // FTS maintenance adds 2 extra statements (delete + insert) around the cells DML.
    expect(stmts).toHaveLength(3)
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts'))
    const { sql, args } = cellsStmts[0]
    // The client never emits target.cell.create, so the commit is an UPSERT:
    // INSERT the target row on first translation, ON CONFLICT UPDATE after.
    expect(sql).toContain('INSERT INTO cells')
    expect(sql).toContain('ON CONFLICT(project_id, file_id, cell_id, side) DO UPDATE SET')
    expect(sql).toContain('event_id = excluded.event_id')
    expect(sql).toContain('source_event_id = excluded.source_event_id')
    // bind order (mirrors the INSERT column list):
    // 0=project_id, 1=file_id, 2=cell_id, 3=value, 4=value_html,
    // 5=event_id, 6=source_event_id, 7=last_editor, 8=last_edit_at,
    // 9=word_count, 10=content_hash
    expect(args[0]).toBe('proj-1')
    expect(args[2]).toBe('cell-1')
    expect(args[3]).toBe('new text')
    expect(args[5]).toBe('evt-test-id')
    expect(args[6]).toBe('src-event-99')
  })

  it('writes NULL source_event_id when omitted', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('target.cell.commit', { value: 'x' }),
      stmts,
    )
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts'))
    expect(cellsStmts[0].args[6]).toBe(null)
  })
})

describe('buildEventProjectionStmts — source.cell.commit', () => {
  it('UPDATEs value + event_id without touching source_event_id', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.commit', { value: 'updated source' }),
      stmts,
    )
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts'))
    const { sql } = cellsStmts[0]
    expect(sql).toContain('UPDATE cells SET')
    expect(sql).not.toContain('source_event_id =')
  })
})

describe('buildEventProjectionStmts — *.cell.delete', () => {
  it('emits a DELETE FROM cells scoped to the event side', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(db, makeEvent('target.cell.delete', {}), stmts)
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts'))
    expect(cellsStmts[0].sql).toContain('DELETE FROM cells')
    expect(cellsStmts[0].sql).toContain('side = ?')
    expect(cellsStmts[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'target'])
  })

  it('source.cell.delete binds side=source', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(db, makeEvent('source.cell.delete', {}), stmts)
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts'))
    expect(cellsStmts[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'source'])
  })
})

describe('buildEventProjectionStmts — *.cell.reorder', () => {
  it('UPDATEs anchor_cell_id and event_id, scoped to side', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('target.cell.reorder', { anchorCellId: 'cell-7' }),
      stmts,
    )
    expect(recorded[0].sql).toContain('UPDATE cells SET anchor_cell_id')
    expect(recorded[0].sql).toContain('side = ?')
    expect(recorded[0].args[0]).toBe('cell-7')
    expect(recorded[0].args[1]).toBe('evt-test-id') // event_id
    // Last positional arg is the bound `side`.
    expect(recorded[0].args[recorded[0].args.length - 1]).toBe('target')
  })

  it('source.cell.reorder binds side=source', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.reorder', { anchorCellId: 'cell-9' }),
      stmts,
    )
    expect(recorded[0].args[recorded[0].args.length - 1]).toBe('source')
  })
})

// Regression test for the bug where editing a target cell overwrote the
// source cell. Cells PK is (project_id, file_id, cell_id, side), so every
// mutation MUST scope its WHERE clause by `side`, otherwise a target-side
// event hits the source-side row of the same pair (and vice versa).
describe('buildEventProjectionStmts — side scoping (regression: target edits must not overwrite source)', () => {
  const sideAffectingKinds = [
    { kind: 'target.cell.commit', payload: { value: 'translated' }, expectedSide: 'target' },
    { kind: 'source.cell.commit', payload: { value: 'updated source' }, expectedSide: 'source' },
    { kind: 'target.cell.delete', payload: {}, expectedSide: 'target' },
    { kind: 'source.cell.delete', payload: {}, expectedSide: 'source' },
    { kind: 'target.cell.reorder', payload: { anchorCellId: 'a' }, expectedSide: 'target' },
    { kind: 'source.cell.reorder', payload: { anchorCellId: 'a' }, expectedSide: 'source' },
  ] as const

  for (const { kind, payload, expectedSide } of sideAffectingKinds) {
    it(`${kind} scopes its WHERE clause to side='${expectedSide}'`, () => {
      const { db, recorded } = makeD1Stub()
      const stmts: D1PreparedStatement[] = []
      buildEventProjectionStmts(db, makeEvent(kind, payload), stmts)

      // First non-FTS statement is the cells mutation for these kinds.
      const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts'))
      const sql = cellsStmts[0].sql
      // Three accepted forms, all of which keep the mutation scoped to one side:
      //  1. a literal `side = 'target'` / `side = 'source'` WHERE clause
      //     (source.cell.commit UPDATE),
      //  2. the side literal in an UPSERT's VALUES list (target.cell.commit),
      //  3. a parametrised `side = ?` with the matching value in args
      //     (deletes, reorders).
      const litMatch = sql.match(/side\s*=\s*'(source|target)'/)
      const valuesMatch = sql.match(/VALUES\s*\([^)]*'(source|target)'/)
      if (litMatch) {
        expect(litMatch[1]).toBe(expectedSide)
      } else if (valuesMatch) {
        expect(valuesMatch[1]).toBe(expectedSide)
        const opposite = expectedSide === 'target' ? 'source' : 'target'
        expect(sql).not.toContain(`'${opposite}'`)
      } else {
        expect(sql).toContain('side = ?')
        expect(cellsStmts[0].args).toContain(expectedSide)
        // Make sure we didn't accidentally bind the OTHER side too.
        const opposite = expectedSide === 'target' ? 'source' : 'target'
        expect(cellsStmts[0].args).not.toContain(opposite)
      }
    })
  }
})

describe('buildEventProjectionStmts — cell.validate / cell.unvalidate', () => {
  it('cell.validate emits validator UPSERT (INSERT) + cells.validated recompute', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('cell.validate', { editEventId: 'evt-commit-id' }),
      stmts,
    )
    expect(stmts).toHaveLength(2)
    expect(recorded[0].sql).toContain('INSERT INTO cell_validators')
    // 0012: columns are (project_id, file_id, cell_id, event_id, username, decided_ts) — no is_active
    expect(recorded[0].sql).toContain('event_id')
    expect(recorded[0].sql).not.toContain('is_active')
    expect(recorded[1].sql).toContain('UPDATE cells')
    expect(recorded[1].sql).toContain('SET validated')
    // Recompute references event_id (not edit_event_id) per 0012 schema
    expect(recorded[1].sql).toContain('event_id = cells.event_id')
  })

  it('cell.unvalidate emits DELETE (not UPSERT) + cells.validated recompute', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('cell.unvalidate', { editEventId: 'evt-commit-id' }),
      stmts,
    )
    // DELETE stmt + UPDATE cells.validated recompute
    expect(stmts).toHaveLength(2)
    expect(recorded[0].sql).toContain('DELETE FROM cell_validators')
    expect(recorded[1].sql).toContain('UPDATE cells')
    expect(recorded[1].sql).toContain('SET validated')
  })
})

describe('buildEventProjectionStmts — file.create', () => {
  it('emits an INSERT INTO files row', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('file.create', { name: 'Genesis', fileType: 'codex', sourceLanguage: 'en' }, { cellId: null }),
      stmts,
    )
    expect(recorded[0].sql).toContain('INSERT INTO files')
    expect(recorded[0].args[0]).toBe('file-a')
    expect(recorded[0].args[2]).toBe('Genesis')
  })
})

describe('buildEventProjectionStmts — error paths', () => {
  it('throws when *.cell.commit has no fileId', () => {
    const { db } = makeD1Stub()
    expect(() =>
      buildEventProjectionStmts(
        db,
        makeEvent('target.cell.commit', { value: 'x' }, { fileId: null }),
        [],
      ),
    ).toThrow(/fileId/)
  })

  it('throws on unknown event kind', () => {
    const { db } = makeD1Stub()
    expect(() =>
      buildEventProjectionStmts(
        db,
        // @ts-expect-error intentionally bad kind
        makeEvent('cell.future.unknown', {}),
        [],
      ),
    ).toThrow(/unknown event kind/)
  })
})
