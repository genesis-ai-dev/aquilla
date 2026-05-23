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

    expect(stmts).toHaveLength(1)
    const { sql, args } = recorded[0]
    expect(sql).toContain('INSERT INTO cells')
    expect(sql).toContain('ON CONFLICT(project_id, file_id, cell_id)')
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
    const { args } = recorded[0]
    expect(args[3]).toBe('target')
    expect(args[8]).toBe('cell-0')   // anchor_cell_id
    expect(args[9]).toBe('evt-test-id') // event_id
  })
})

describe('buildEventProjectionStmts — target.cell.commit', () => {
  it('UPDATEs value, event_id, and source_event_id', () => {
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
    expect(stmts).toHaveLength(1)
    const { sql, args } = recorded[0]
    expect(sql).toContain('UPDATE cells SET')
    expect(sql).toContain('event_id = ?')
    expect(sql).toContain('source_event_id = ?')
    // 0=value, 1=value_html, 2=event_id, 3=source_event_id,
    // 4=last_editor, 5=last_edit_at, 6=word_count, 7=content_hash,
    // 8=project_id, 9=file_id, 10=cell_id
    expect(args[0]).toBe('new text')
    expect(args[2]).toBe('evt-test-id')
    expect(args[3]).toBe('src-event-99')
    expect(args[8]).toBe('proj-1')
    expect(args[10]).toBe('cell-1')
  })

  it('writes NULL source_event_id when omitted', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('target.cell.commit', { value: 'x' }),
      stmts,
    )
    expect(recorded[0].args[3]).toBe(null)
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
    const { sql } = recorded[0]
    expect(sql).toContain('UPDATE cells SET')
    expect(sql).not.toContain('source_event_id =')
  })
})

describe('buildEventProjectionStmts — *.cell.delete', () => {
  it('emits a DELETE FROM cells statement', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(db, makeEvent('target.cell.delete', {}), stmts)
    expect(recorded[0].sql).toContain('DELETE FROM cells')
    expect(recorded[0].args).toEqual(['proj-1', 'file-a', 'cell-1'])
  })
})

describe('buildEventProjectionStmts — *.cell.reorder', () => {
  it('UPDATEs anchor_cell_id and event_id', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('target.cell.reorder', { anchorCellId: 'cell-7' }),
      stmts,
    )
    expect(recorded[0].sql).toContain('UPDATE cells SET anchor_cell_id')
    expect(recorded[0].args[0]).toBe('cell-7')
    expect(recorded[0].args[1]).toBe('evt-test-id') // event_id
  })
})

describe('buildEventProjectionStmts — cell.validate / cell.unvalidate', () => {
  it('cell.validate emits validator UPSERT + cells.validated recompute (0012: event-anchored, no is_active)', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('cell.validate', { editEventId: 'evt-commit-id' }),
      stmts,
    )
    expect(stmts).toHaveLength(2)
    expect(recorded[0].sql).toContain('INSERT INTO cell_validators')
    expect(recorded[0].sql).not.toContain('is_active')
    // Bind: 0=project_id,1=file_id,2=cell_id,3=event_id,4=username,5=decided_ts
    expect(recorded[0].args[3]).toBe('evt-commit-id')
    expect(recorded[1].sql).toContain('UPDATE cells')
    expect(recorded[1].sql).toContain('SET validated')
    expect(recorded[1].sql).toContain('event_id = cells.event_id')
    expect(recorded[1].sql).not.toContain('is_active')
  })

  it('cell.unvalidate DELETEs the (cell, validator) row + recompute (0012: DELETE-on-unvalidate)', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('cell.unvalidate', { editEventId: 'evt-commit-id' }),
      stmts,
    )
    expect(stmts).toHaveLength(2)
    expect(recorded[0].sql).toContain('DELETE FROM cell_validators')
    expect(recorded[0].sql).toContain('username = ?')
    // Bind: 0=project_id,1=file_id,2=cell_id,3=username
    expect(recorded[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'alice'])
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

  it('persists role/kind/book_code as columns, event_id chain head, and provenance into meta JSON (0012)', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent(
        'file.create',
        {
          name: 'Genesis',
          role: 'source',
          kind: 'usfm',
          bookCode: 'GEN',
          r2Key: 'projects/p/files/f/original.usfm',
          importFormat: 'usfm',
          parserVersion: 'usfm-2026.04',
          sourceLanguage: 'en',
        },
        { cellId: null, id: 'evt-file-1' },
      ),
      stmts,
    )
    // 0012 bind order: 0=id, 1=project_id, 2=name, 3=role, 4=kind,
    //   5=book_code, 6=source_file_id, 7=anchor_file_id, 8=event_id,
    //   9=created_by, 10=meta (JSON).
    const args = recorded[0].args
    expect(recorded[0].sql).not.toContain('file_type')
    expect(args[3]).toBe('source')        // role
    expect(args[4]).toBe('usfm')          // kind
    expect(args[5]).toBe('GEN')           // book_code
    expect(args[8]).toBe('evt-file-1')    // event_id chain head
    const meta = JSON.parse(args[10] as string)
    expect(meta.r2_key).toBe('projects/p/files/f/original.usfm')
    expect(meta.import_format).toBe('usfm')
    expect(meta.parser_version).toBe('usfm-2026.04')
    expect(meta.source_language).toBe('en')
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
