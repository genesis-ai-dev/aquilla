// Tests for buildEventProjectionStmts.
//
// Validates the SQL + bindings emitted for each event kind. Uses a tiny
// recording DB stub that captures (sql, args) pairs from prepare().bind().

import { describe, it, expect } from 'vitest'
import {
  buildEventProjectionStmts,
  contentHash,
  type PersistedEvent,
} from '../events/event-projection'
import type { EventKind } from '../events/types'
import { makeTestDb } from './helpers/pg-test-db'

interface RecordedStmt {
  sql: string
  args: unknown[]
}

function makeD1Stub() {
  const recorded: RecordedStmt[] = []

  function makePrepared(sql: string): AquillaStatement {
    const stmt = {
      bind(...args: unknown[]): AquillaStatement {
        recorded.push({ sql: sql.replace(/\s+/g, ' ').trim(), args })
        return this as unknown as AquillaStatement
      },
      first: () => Promise.reject(new Error('stub: first() not implemented')),
      run: () => Promise.reject(new Error('stub: run() not implemented')),
      all: () => Promise.reject(new Error('stub: all() not implemented')),
      raw: () => Promise.reject(new Error('stub: raw() not implemented')),
    } as unknown as AquillaStatement
    return stmt
  }

  const db = {
    prepare(sql: string) { return makePrepared(sql) },
    batch: () => Promise.resolve([]),
    dump: () => Promise.resolve(new ArrayBuffer(0)),
    exec: () => Promise.resolve({ count: 0, duration: 0 }),
  } as unknown as AquillaDb

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
    const stmts: AquillaStatement[] = []

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

    // FTS maintenance adds 2 statements (delete + insert) around the cells
    // DML, and the files-counter recompute adds 1 more.
    expect(stmts).toHaveLength(2)
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts') && !r.sql.includes('WHERE false'))
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
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('target.cell.create', {
        cellId: 'cell-1',
        value: 'hello',
        anchorCellId: 'cell-0',
      }),
      stmts,
    )
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts') && !r.sql.includes('WHERE false'))
    const { args } = cellsStmts[0]
    expect(args[3]).toBe('target')
    expect(args[8]).toBe('cell-0')   // anchor_cell_id
    expect(args[9]).toBe('evt-test-id') // event_id
  })
})

describe('buildEventProjectionStmts — target.cell.commit', () => {
  it('UPSERTs value, event_id, and source_event_id (first commit creates the target row)', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('target.cell.commit', {
        value: 'new text',
        valueHtml: '<p>new text</p>',
        sourceEventId: 'src-event-99',
      }),
      stmts,
    )
    // FTS maintenance adds 2 statements (delete + insert) around the cells
    // DML, and the files-counter recompute adds 1 more.
    expect(stmts).toHaveLength(2)
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts') && !r.sql.includes('WHERE false'))
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
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('target.cell.commit', { value: 'x' }),
      stmts,
    )
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts') && !r.sql.includes('WHERE false'))
    expect(cellsStmts[0].args[6]).toBe(null)
  })
})

describe('buildEventProjectionStmts — source.cell.commit', () => {
  it('UPDATEs value + event_id without touching source_event_id', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.commit', { value: 'updated source' }),
      stmts,
    )
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts') && !r.sql.includes('WHERE false'))
    const { sql } = cellsStmts[0]
    expect(sql).toContain('UPDATE cells SET')
    expect(sql).not.toContain('source_event_id =')
  })
})

describe('buildEventProjectionStmts — *.cell.delete', () => {
  it('emits a DELETE FROM cells scoped to the event side', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(db, makeEvent('target.cell.delete', {}), stmts)
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts') && !r.sql.includes('WHERE false'))
    expect(cellsStmts[0].sql).toContain('DELETE FROM cells')
    expect(cellsStmts[0].sql).toContain('side = ?')
    expect(cellsStmts[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'target'])
  })

  it('source.cell.delete binds side=source', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(db, makeEvent('source.cell.delete', {}), stmts)
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts') && !r.sql.includes('WHERE false'))
    expect(cellsStmts[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'source'])
  })
})

describe('buildEventProjectionStmts — *.cell.reorder', () => {
  it('UPDATEs anchor_cell_id and event_id, scoped to side', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
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
    const stmts: AquillaStatement[] = []
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
      const stmts: AquillaStatement[] = []
      buildEventProjectionStmts(db, makeEvent(kind, payload), stmts)

      // First non-FTS statement is the cells mutation for these kinds.
      const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts') && !r.sql.includes('WHERE false'))
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
  it('cell.validate emits validator UPSERT (INSERT) + ai_drafted clear + cells.validated recompute', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('cell.validate', { editEventId: 'evt-commit-id' }),
      stmts,
    )
    // FRO-292: validator UPSERT + ai_drafted clear + cells.validated recompute
    // + endorsement_count recompute + files counters recompute.
    expect(stmts).toHaveLength(5)
    expect(recorded[0].sql).toContain('INSERT INTO cell_validators')
    // 0012: columns are (project_id, file_id, cell_id, event_id, username, decided_ts) — no is_active
    expect(recorded[0].sql).toContain('event_id')
    expect(recorded[0].sql).not.toContain('is_active')
    // FRO-292: ai_drafted cleared before the validated recompute so the
    // file counter reflects the final state correctly.
    expect(recorded[1].sql).toContain('SET ai_drafted = 0')
    expect(recorded[2].sql).toContain('UPDATE cells')
    expect(recorded[2].sql).toContain('SET validated')
    // Recompute references event_id (not edit_event_id) per 0012 schema
    expect(recorded[2].sql).toContain('event_id = cells.event_id')
    // AD-14 pass 1: endorsement_count recompute against current chain head
    expect(recorded[3].sql).toContain('SET endorsement_count')
    expect(recorded[3].sql).toContain('cells.event_id')
    // approved_count moves on validate, so files counters are recomputed.
    expect(recorded[4].sql).toContain('UPDATE files SET cell_count')
    expect(recorded[4].sql).toContain('approved_count')
  })

  it('cell.unvalidate emits DELETE (not UPSERT) + cells.validated recompute + endorsement_count recompute', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('cell.unvalidate', { editEventId: 'evt-commit-id' }),
      stmts,
    )
    // DELETE stmt + UPDATE cells.validated recompute + UPDATE
    // cells.endorsement_count recompute + files counters recompute.
    expect(stmts).toHaveLength(4)
    expect(recorded[0].sql).toContain('DELETE FROM cell_validators')
    expect(recorded[1].sql).toContain('UPDATE cells')
    expect(recorded[1].sql).toContain('SET validated')
    expect(recorded[2].sql).toContain('SET endorsement_count')
    expect(recorded[3].sql).toContain('UPDATE files SET cell_count')
  })
})

describe('buildEventProjectionStmts — cell.waive / cell.unwaive', () => {
  it('cell.waive emits a single cell_waivers UPSERT (no cells/files recompute)', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(
      db,
      makeEvent('cell.waive', { ruleId: 'no-double-space', reason: 'intentional' }),
      stmts,
    )
    // Waivers don't move the chain head or counters — just the one upsert.
    expect(stmts).toHaveLength(1)
    expect(recorded[0].sql).toContain('INSERT INTO cell_waivers')
    expect(recorded[0].sql).toContain('rule_id')
    expect(recorded[0].sql).toContain('ON CONFLICT')
    // Bind order: project, file, cell, ruleId, reason, author, serverTs.
    expect(recorded[0].args).toEqual([
      'proj-1', 'file-a', 'cell-1', 'no-double-space', 'intentional', 'alice', 2000,
    ])
    expect(touches).toEqual(['cell_waivers'])
  })

  it('cell.waive binds null reason when omitted', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(db, makeEvent('cell.waive', { ruleId: 'rule-x' }), stmts)
    expect(recorded[0].args[4]).toBeNull()
  })

  it('cell.unwaive emits a DELETE keyed by rule_id', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(
      db,
      makeEvent('cell.unwaive', { ruleId: 'no-double-space' }),
      stmts,
    )
    expect(stmts).toHaveLength(1)
    expect(recorded[0].sql).toContain('DELETE FROM cell_waivers')
    expect(recorded[0].sql).toContain('rule_id = ?')
    expect(recorded[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'no-double-space'])
    expect(touches).toEqual(['cell_waivers'])
  })

  it('throws when fileId or cellId is missing', () => {
    const { db } = makeD1Stub()
    expect(() =>
      buildEventProjectionStmts(
        db,
        makeEvent('cell.waive', { ruleId: 'r' }, { cellId: null }),
        [],
      ),
    ).toThrow(/missing fileId or cellId/)
  })
})

describe('buildEventProjectionStmts — file.create', () => {
  it('emits an INSERT INTO files row', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
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

// ── Integration: FTS5 SELECT-form handlers in in-memory-db ───────────────────────
//
// These tests run real D1PreparedStatements through the InMemoryDb (via
// db.batch) to verify the SELECT-form ftsInsertStmt / ftsDeleteStmt SQL
// patterns are correctly handled by the fake.  This is the integration test
// that justifies Part A of the test infrastructure work.

describe('FTS5 integration via InMemoryDb — SELECT-form insert/delete', () => {
  it('source.cell.create populates cells_fts via SELECT-form insert', async () => {
    const { db, snapshot } = await makeTestDb()

    // Step 1: process a source.cell.create event.
    const createStmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.create', {
        cellId: 'cell-1',
        value: 'In the beginning',
        anchorCellId: null,
      }),
      createStmts,
    )
    await db.batch(createStmts)

    const tables = await snapshot()
    // The cells row must exist.
    expect(tables.cells).toHaveLength(1)
    expect(tables.cells[0].value).toBe('In the beginning')
    // FTS: the generated value_tsv matches a search for an indexed word.
    const fts = await db
      .prepare("SELECT cell_id FROM cells WHERE value_tsv @@ plainto_tsquery('simple', ?)")
      .bind('beginning')
      .all()
    expect(fts.results).toHaveLength(1)
  })

  it('source.cell.commit updates the cells_fts value', async () => {
    const { db, snapshot } = await makeTestDb()

    // First create the cell.
    const createStmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.create', {
        cellId: 'cell-1',
        value: 'In the beginning',
        anchorCellId: null,
      }),
      createStmts,
    )
    await db.batch(createStmts)

    // Then commit a new value.
    const commitStmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.commit', {
        value: 'In the beginning God created',
      }, { id: 'evt-commit', parentId: 'evt-test-id' }),
      commitStmts,
    )
    await db.batch(commitStmts)

    const tables = await snapshot()
    // cells should have the updated value.
    expect(tables.cells[0].value).toBe('In the beginning God created')
    // FTS reflects the new value: the added word 'created' now matches.
    const fts = await db
      .prepare("SELECT cell_id FROM cells WHERE value_tsv @@ plainto_tsquery('simple', ?)")
      .bind('created')
      .all()
    expect(fts.results).toHaveLength(1)
  })

  it('source.cell.delete removes the cells_fts entry', async () => {
    const { db, snapshot } = await makeTestDb()

    // Create then delete.
    const createStmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.create', {
        cellId: 'cell-1',
        value: 'Verse text',
        anchorCellId: null,
      }),
      createStmts,
    )
    await db.batch(createStmts)

    expect(
      (await db.prepare("SELECT cell_id FROM cells WHERE value_tsv @@ plainto_tsquery('simple', ?)").bind('Verse').all()).results,
    ).toHaveLength(1)

    const deleteStmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.delete', {}),
      deleteStmts,
    )
    await db.batch(deleteStmts)

    const tables = await snapshot()
    // cells row is gone.
    expect(tables.cells).toHaveLength(0)
    // FTS entry gone too (no matching cells row).
    const fts = await db
      .prepare("SELECT cell_id FROM cells WHERE value_tsv @@ plainto_tsquery('simple', ?)")
      .bind('Verse')
      .all()
    expect(fts.results).toHaveLength(0)
  })
})

describe('files counter projection via InMemoryDb', () => {
  // Seed a files row so the recompute UPDATE has a target. The bug was that
  // this row's cell_count sat at 0 forever because the cell projection never
  // maintained it — these tests pin the maintenance.
  async function seedFile() {
    return makeTestDb({
      files: [{ id: 'file-a', project_id: 'proj-1', name: 'Doc', cell_count: 0, approved_count: 0, word_count: 0, last_edit_at: null }],
    })
  }

  it('source.cell.create bumps cell_count and last_edit_at on the files row', async () => {
    const { db, snapshot } = await seedFile()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.create', { cellId: 'cell-1', value: 'In the beginning', anchorCellId: null }),
      stmts,
    )
    await db.batch(stmts)

    const file = (await snapshot()).files[0]
    expect(file.cell_count).toBe(1)
    expect(file.last_edit_at).toBe(2000) // serverTs from makeEvent
  })

  it('counts distinct cell positions, not source+target rows', async () => {
    const { db, snapshot } = await seedFile()
    // Source cell.
    const s: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.create', { cellId: 'cell-1', value: 'logos', anchorCellId: null }),
      s,
    )
    await db.batch(s)
    // Target translation of the SAME cell position (shares cell_id).
    const t: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('target.cell.commit', { value: 'word' }, { id: 'evt-t', cellId: 'cell-1' }),
      t,
    )
    await db.batch(t)

    const file = (await snapshot()).files[0]
    // One position, two sides → cell_count is 1, not 2.
    expect(file.cell_count).toBe(1)
    // word_count is the target-side words only.
    expect(file.word_count).toBe(1)
  })

  it('deleting the last cell returns cell_count to 0', async () => {
    const { db, snapshot } = await seedFile()
    const c: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.create', { cellId: 'cell-1', value: 'x', anchorCellId: null }),
      c,
    )
    await db.batch(c)
    expect((await snapshot()).files[0].cell_count).toBe(1)

    const d: AquillaStatement[] = []
    buildEventProjectionStmts(db, makeEvent('source.cell.delete', {}), d)
    await db.batch(d)

    const file = (await snapshot()).files[0]
    expect(file.cell_count).toBe(0)
    expect(file.last_edit_at).toBeNull()
  })

  it('reports files as a dirty table so clients refetch the listing', () => {
    const { db } = makeD1Stub()
    const touches = buildEventProjectionStmts(
      db,
      makeEvent('source.cell.create', { cellId: 'cell-1', value: 'x', anchorCellId: null }),
      [],
    )
    expect(touches).toContain('files')
  })
})
