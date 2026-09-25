// Tests for buildEventProjectionStmts.
//
// Validates the SQL + bindings emitted for each event kind. Uses a tiny
// recording DB stub that captures (sql, args) pairs from prepare().bind().

import { describe, it, expect } from 'vitest'
import {
  buildEventProjectionStmts,
  contentHash,
  isChainMutatingKind,
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

    // Cell UPSERT plus the file-counter recompute share the projection batch.
    expect(stmts).toHaveLength(2)
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts') && !r.sql.includes('WHERE false'))
    const { sql, args } = cellsStmts[0]
    expect(sql).toContain('INSERT INTO cells')
    expect(sql).toContain('ON CONFLICT(project_id, file_id, cell_id, lane_id)')
    // 0=project_id, 1=file_id, 2=cell_id, 3=side, 4=target_lang, 5=value,
    // 6=value_html, 7=type, 8=canonical_ref, 9=anchor_cell_id, 10=event_id,
    // 11=last_editor, 12=last_edit_at, 13=word_count, 14=content_hash
    expect(args[0]).toBe('proj-1')
    expect(args[1]).toBe('file-a')
    expect(args[2]).toBe('cell-1')
    expect(args[3]).toBe('source')
    expect(args[4]).toBe('') // AQU-538: source rows always on the default lane
    expect(args[5]).toBe('In the beginning')
    expect(args[7]).toBe('verse')
    expect(args[8]).toBe('GEN 1:1')
    expect(args[10]).toBe('evt-test-id')
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
    expect(args[4]).toBe('')            // target_lang: default lane
    expect(args[9]).toBe('cell-0')      // anchor_cell_id
    expect(args[10]).toBe('evt-test-id') // event_id
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
    // Cell UPSERT, durable contextual-draft reconciliation, then the file
    // counter recompute all share the caller's atomic projection batch.
    expect(stmts).toHaveLength(3)
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts') && !r.sql.includes('WHERE false'))
    const { sql, args } = cellsStmts[0]
    // The client never emits target.cell.create, so the commit is an UPSERT:
    // INSERT the target row on first translation, ON CONFLICT UPDATE after.
    expect(sql).toContain('INSERT INTO cells')
    expect(sql).toContain('ON CONFLICT(project_id, file_id, cell_id, lane_id) DO UPDATE SET')
    expect(sql).toContain('event_id = excluded.event_id')
    expect(sql).toContain('source_event_id = excluded.source_event_id')
    // bind order (mirrors the INSERT column list):
    // 0=project_id, 1=file_id, 2=cell_id, 3=target_lang, 4=value,
    // 5=value_html, 6=event_id, 7=source_event_id, 8=last_editor,
    // 9=last_edit_at, 10=word_count, 11=content_hash
    expect(args[0]).toBe('proj-1')
    expect(args[2]).toBe('cell-1')
    expect(args[3]).toBe('') // AQU-538: default lane when targetLang absent
    expect(args[4]).toBe('new text')
    expect(args[6]).toBe('evt-test-id')
    expect(args[7]).toBe('src-event-99')
    const reconciliation = recorded.find(r => r.sql.includes('UPDATE contextual_drafts AS draft'))
    expect(reconciliation?.sql).toContain("draft.status = 'proposed'")
    expect(reconciliation?.sql).toContain('projected.event_id = ?')
    expect(reconciliation?.sql).toContain('INSERT INTO contextual_run_events')
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
    expect(cellsStmts[0].args[7]).toBe(null)
  })

  it('projects AI provenance and clears it on a human commit', () => {
    const { db, recorded } = makeD1Stub()
    const provenance = {
      model: 'gpt-5.6-luna',
      provider: 'frontier',
      promptVersion: 'translation-draft-v2',
      exampleIds: ['e1'],
      generatedAt: 123,
      mode: 'read' as const,
      projectState: {
        sourceLanguage: 'en', targetLanguage: 'es', approvedExampleCount: 1,
        evidenceCoverage: 0.5, evidenceWeight: 0.2,
      },
    }
    buildEventProjectionStmts(
      db,
      makeEvent('target.cell.commit', {
        value: 'draft', ai_suggestion: true, ai_draft: provenance,
      }),
      [],
    )
    const aiStmt = recorded.find((row) => row.sql.includes('INSERT INTO cells'))!
    expect(aiStmt.sql).toContain('ai_draft')
    expect(aiStmt.args[12]).toBe(1)
    expect(JSON.parse(String(aiStmt.args[13]))).toEqual(provenance)

    const human = makeD1Stub()
    buildEventProjectionStmts(
      human.db,
      makeEvent('target.cell.commit', { value: 'human edit' }),
      [],
    )
    const humanStmt = human.recorded.find((row) => row.sql.includes('INSERT INTO cells'))!
    expect(humanStmt.args[12]).toBe(0)
    expect(humanStmt.args[13]).toBeNull()
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

  // AQU-847: an imported media section's `value` is the import FILENAME, so a
  // source edit on one corrects its TRANSCRIPT instead. Before this, the
  // payload had nowhere to put that and the correction was silently dropped.
  it('lands a media section correction on `transcription`, scoped to the source row', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.commit', { value: 'episode.mp3', transcription: 'corrected transcript' }),
      stmts,
    )
    const cellsStmts = recorded.filter(r => !r.sql.includes('cells_fts') && !r.sql.includes('WHERE false'))
    const transcriptStmt = cellsStmts.find(r => r.sql.includes('transcription = ?'))
    expect(transcriptStmt).toBeDefined()
    expect(transcriptStmt!.sql).toContain("side = 'source'")
    expect(transcriptStmt!.args[0]).toBe('corrected transcript')
    // The filename `value` is resent unchanged — provenance survives the edit.
    expect(cellsStmts[0].args[0]).toBe('episode.mp3')
  })

  it('an empty-string correction clears the transcript (it is not treated as absent)', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.commit', { value: 'episode.mp3', transcription: '' }),
      stmts,
    )
    const transcriptStmt = recorded.find(r => r.sql.includes('transcription = ?'))
    expect(transcriptStmt).toBeDefined()
    expect(transcriptStmt!.args[0]).toBe('')
  })

  it('an ordinary text-cell commit writes NO transcription statement', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.commit', { value: 'updated source' }),
      stmts,
    )
    expect(recorded.some(r => r.sql.includes('transcription = ?'))).toBe(false)
  })
})

describe('buildEventProjectionStmts — source.cell.metadata.patch', () => {
  it('merges v2 metadata and canonical HTML without advancing the source text chain', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent(
        'source.cell.metadata.patch',
        {
          version: 1,
          metadata: { idml: { version: 2, slotCount: 1 } },
          valueHtml: '<p data-idml-version="2"></p>',
          targetHtml: '<p data-idml-version="2">target</p>',
        },
        { schemaVersion: 2 },
      ),
      stmts,
    )
    expect(stmts).toHaveLength(2)
    expect(recorded[0].sql).toContain("COALESCE(metadata, '{}'::jsonb) ||")
    expect(recorded[0].sql).toContain("side = 'source'")
    expect(recorded[0].sql).not.toContain('event_id')
    expect(recorded[0].args).toEqual([
      JSON.stringify({ idml: { version: 2, slotCount: 1 } }),
      '<p data-idml-version="2"></p>',
      '<p data-idml-version="2"></p>',
      'proj-1',
      'file-a',
      'cell-1',
    ])
    expect(recorded[1].sql).toContain("side = 'target'")
  })

  it('rejects unversioned metadata patches instead of guessing', () => {
    const { db } = makeD1Stub()
    expect(() => buildEventProjectionStmts(
      db,
      makeEvent('source.cell.metadata.patch', { version: 1, metadata: {} }),
      [],
    )).toThrow(/schemaVersion 2/)
  })
})

describe('buildEventProjectionStmts — *.cell.delete', () => {
  it('emits a DELETE FROM cells scoped to the event side', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(db, makeEvent('target.cell.delete', {}), stmts)
    // AQU-1068 review round: the cells DELETE is emitted LAST, after the
    // dependent cleanup that tests its head — so select it, don't index it.
    const cellsStmts = recorded.filter(r => r.sql.startsWith('DELETE FROM cells'))
    expect(cellsStmts[0].sql).toContain('DELETE FROM cells')
    expect(cellsStmts[0].sql).toContain('side = ?')
    // AQU-538: trailing bind is the target lane ('' = default).
    expect(cellsStmts[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'target', ''])
  })

  it('source.cell.delete binds side=source', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(db, makeEvent('source.cell.delete', {}), stmts)
    // Two now: the cascade's lane rows (literal side = 'target') and the
    // source row itself (parameterised side = ?).
    const cellsStmts = recorded.filter(r => r.sql.startsWith('DELETE FROM cells') && !r.sql.includes("side = 'target'"))
    // AQU-538: source rows always live on the default lane ('').
    expect(cellsStmts[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'source', ''])
  })

  it('target.cell.delete with targetLang deletes only that lane', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(db, makeEvent('target.cell.delete', { targetLang: 'fr' }), stmts)
    const cellsStmts = recorded.filter(r => r.sql.startsWith('DELETE FROM cells'))
    expect(cellsStmts[0].sql).toContain('target_lang = ?')
    expect(cellsStmts[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'target', 'fr'])
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
    // AQU-538: last two positional args are the bound `side` and lane.
    expect(recorded[0].args[recorded[0].args.length - 2]).toBe('target')
    expect(recorded[0].args[recorded[0].args.length - 1]).toBe('')
  })

  it('source.cell.reorder binds side=source', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('source.cell.reorder', { anchorCellId: 'cell-9' }),
      stmts,
    )
    expect(recorded[0].args[recorded[0].args.length - 2]).toBe('source')
    expect(recorded[0].args[recorded[0].args.length - 1]).toBe('')
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

      // The cells mutation, wherever it sits. AQU-1068's dependent cleanup
      // runs BEFORE the delete (it tests the row's head), so this can no
      // longer be "the first non-FTS statement".
      const cellsStmts = recorded.filter(r =>
        /^(DELETE FROM|UPDATE|INSERT INTO) cells\b/.test(r.sql)
        && !r.sql.includes('cells_fts') && !r.sql.includes('WHERE false')
        // AQU-1068: a source delete also drops the cell's lane rows as part of
        // its cascade. That statement is deliberately side-literal 'target';
        // the event's OWN side-scoped mutation is the parameterised one.
        && !(r.sql.startsWith('DELETE FROM cells') && r.sql.includes("side = 'target'")))
      const sql = cellsStmts[0].sql
      // Three accepted forms, all of which keep the mutation scoped to one side:
      //  1. a literal `side = 'target'` / `side = 'source'` WHERE clause
      //     (source.cell.commit UPDATE),
      //  2. the side literal in an UPSERT's row source — `VALUES (...)` or the
      //     `SELECT ...` form used for chain-claim gating (target.cell.commit),
      //  3. a parametrised `side = ?` with the matching value in args
      //     (deletes, reorders).
      const litMatch = sql.match(/side\s*=\s*'(source|target)'/)
      const valuesMatch = sql.match(/(?:VALUES\s*\(|\)\s*SELECT\s)[^)]*'(source|target)'/)
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
    // AQU-292: validator UPSERT + ai_drafted clear + cells.validated recompute
    // + endorsement_count recompute + files counters recompute.
    expect(stmts).toHaveLength(5)
    expect(recorded[0].sql).toContain('INSERT INTO cell_validators')
    // 0012: columns are (project_id, file_id, cell_id, event_id, username, decided_ts) — no is_active
    expect(recorded[0].sql).toContain('event_id')
    expect(recorded[0].sql).not.toContain('is_active')
    // AQU-292: ai_drafted cleared before the validated recompute so the
    // file counter reflects the final state correctly.
    expect(recorded[1].sql).toContain('SET ai_drafted = 0')
    expect(recorded[1].sql).toContain('ai_draft = NULL')
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

// AQU-508 shipped these two kinds as a boolean stamp on cell_audio
// (approved / approved_by / approved_ts). No client ever emitted them, and a
// boolean could not express "this project requires two reviewers" — so AQU-490
// replaced the stamp with per-validator rows counted against the project's
// threshold at READ time, the same shape text has used since FRO-279.
//
// The statement shapes are pinned here; the data outcomes (idempotence, the
// out-of-order guard, trim discarding votes, fill-only authorship) live in
// audio-validators-projection.test.ts against real Postgres.
describe('buildEventProjectionStmts — cell.audio.validate / cell.audio.unvalidate (AQU-490)', () => {
  it('cell.audio.validate inserts a validator row and re-derives the take’s count', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(
      db,
      makeEvent('cell.audio.validate', { audioId: 'a1' }),
      stmts,
    )
    // Both tables, or a client invalidates the names and not the count.
    expect(touches).toEqual(['cell_audio', 'cell_audio_validators'])
    expect(stmts).toHaveLength(2)
    expect(recorded[0].sql).toContain('INSERT INTO cell_audio_validators')
    expect(recorded[0].sql).toContain('ON CONFLICT')
    expect(recorded[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'a1', 'alice', 2000])
    expect(recorded[1].sql).toContain('SET validator_count')
  })

  it('cell.audio.unvalidate deletes the author’s own row by default', () => {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('cell.audio.unvalidate', { audioId: 'a1' }),
      stmts,
    )
    expect(stmts).toHaveLength(2)
    expect(recorded[0].sql).toContain('DELETE FROM cell_audio_validators')
    expect(recorded[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'a1', 'alice'])
    expect(recorded[1].sql).toContain('SET validator_count')
  })

  it('is not chain-mutating', () => {
    expect(isChainMutatingKind('cell.audio.validate')).toBe(false)
    expect(isChainMutatingKind('cell.audio.unvalidate')).toBe(false)
  })

  // The retirement, pinned. `approved` stays in the schema until a contract
  // migration can drop it, and nothing may start writing it again: a stamp
  // survives a threshold change and a projection rebuild replays at the
  // default, so the column would assert the wrong answer at the wrong moment.
  it('round-trips against real Postgres and leaves the retired approved stamp alone', async () => {
    const { db, rows } = await makeTestDb({
      cell_audio: [
        {
          project_id: 'proj-1', file_id: 'file-a', cell_id: 'cell-1', audio_id: 'a1',
          slot: 'recording', url: 'frontier-audio://a1.wav', selected: 1, deleted: 0,
          event_id: 'ae1', created_ts: 1,
        },
      ],
    })

    const validateStmts: AquillaStatement[] = []
    buildEventProjectionStmts(db, makeEvent('cell.audio.validate', { audioId: 'a1' }), validateStmts)
    await db.batch(validateStmts)
    let audio = await rows<{ validator_count: number; approved: number; approved_by: string | null }>('cell_audio')
    expect(audio[0].validator_count).toBe(1)
    expect(audio[0].approved).toBe(0)
    expect(audio[0].approved_by).toBeNull()
    expect(await rows('cell_audio_validators')).toHaveLength(1)

    const clearStmts: AquillaStatement[] = []
    buildEventProjectionStmts(db, makeEvent('cell.audio.unvalidate', { audioId: 'a1' }), clearStmts)
    await db.batch(clearStmts)
    audio = await rows('cell_audio')
    expect(audio[0].validator_count).toBe(0)
    expect(await rows('cell_audio_validators')).toHaveLength(0)
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
      makeEvent('file.create', {
        name: 'Genesis',
        fileType: 'codex',
        sourceLanguage: 'en',
        importManifest: { version: 1, profileId: 'builtin:usfm-lossless' },
      }, { cellId: null }),
      stmts,
    )
    expect(recorded[0].sql).toContain('INSERT INTO files')
    expect(recorded[0].args[0]).toBe('file-a')
    expect(recorded[0].args[2]).toBe('Genesis')
    expect(JSON.parse(recorded[0].args.at(-1) as string)).toEqual({
      sourceLanguage: 'en',
      aquillaImport: { version: 1, profileId: 'builtin:usfm-lossless' },
    })
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

// ── ARCH-4: the single chain-mutating predicate ───────────────────────────

describe('isChainMutatingKind', () => {
  // WHY: route.ts used to keep a parallel 17-kind deny-list; a new kind
  // missing from it was treated as chain-mutating by default and silently
  // dropped as a "stale sibling". This table pins the classification of
  // every existing kind so the collapsed predicate can never drift from the
  // behavior the deny-list encoded. Adding an EventKind without extending
  // this map fails the test — forcing an explicit classification decision.
  const EXPECTED: Record<EventKind, boolean> = {
    'source.cell.create': true,
    'source.cell.commit': true,
    'source.cell.delete': true,
    'source.cell.reorder': true,
    'source.cell.metadata.patch': false,
    // AQU-931: anchor-only repair — must NOT arbitrate (a parent-null event
    // would lose the genesis slot to the cell's own create on rebuild).
    'source.cell.reanchor': false,
    'target.cell.create': true,
    'target.cell.commit': true,
    'target.cell.delete': true,
    'target.cell.reorder': true,
    'cell.validate': false,
    'cell.unvalidate': false,
    'cell.waive': false,
    'cell.unwaive': false,
    'cell.audio.attach': false,
    'cell.audio.select': false,
    'cell.audio.remove': false,
    // AQU-508: audio validation is non-chain-mutating (only flips cell_audio.approved).
    'cell.audio.validate': false,
    'cell.audio.unvalidate': false,
    'file.create': false,
    'file.rename': false,
    'file.delete': false,
    'file.restore': false,
    'comment.create': false,
    'comment.edit': false,
    'comment.delete': false,
    'comment.resolve': false,
    // Terminology concepts are project-scoped and touch no cell chain.
    'term.create': false,
    'term.update': false,
    'term.delete': false,
    'term.approve': false,
    'term.reject': false,
    'cell.backtranslation.set': false,
    'assignment.create': false,
    'assignment.reassign': false,
    'assignment.unassign': false,
    'project.link-source': false,
    'cast.assign': false,
    'cell.retime': false,
    'cell.audio.rename': false,
    'cell.audio.trim': false,
    'cell.audio.place': false,
    // A link says which subtitle a heard line performs; it never moves the
    // cell's own text chain.
    'cell.link.set': false,
    'cell.audio.measure': false,
    'cell.lane.retime': false,
    'file.video.set': false,
    'file.timing.set': false,
    'file.corpus.set': false,
    'file.track.set': false,
    // AQU-476: mirror events replicate an ordering the upstream already
    // arbitrated — see CHAIN_MUTATING_KINDS's doc comment.
    'source.cell.mirror': false,
    'file.mirror': false,
    'link.cursor.advance': false,
    // AQU-478: repin is non-chain-mutating — it does not compete for the
    // chain slot (guarded instead by expectedTargetEventId in the SQL).
    'target.cell.repin': false,
  }

  it('classifies every EventKind exactly as the old route deny-list did', () => {
    for (const [kind, chainMutating] of Object.entries(EXPECTED)) {
      expect(isChainMutatingKind(kind), kind).toBe(chainMutating)
    }
  })
})

// ---------------------------------------------------------------------------
// AQU-1068 — a removed cell takes its dependents with it
// ---------------------------------------------------------------------------

describe('source.cell.delete — dependent cleanup', () => {
  // Nothing in the schema references `cells`, so nothing cascades on its own.
  // Until AQU-1068 that did not matter: only an EMPTY line a person had added
  // by hand could be removed. Removing an imported cell is the new capability,
  // and an imported cell is exactly the one carrying validations, takes,
  // pairings and comments.
  //
  // This lives in the PROJECTION rather than the route because projection
  // tables are rebuilt by replaying the event log, and a rebuild wipes only
  // `cells`, `cell_validators` and `file_section_progress` — cleanup done
  // anywhere else would never be re-applied.

  function deleteStmts(kind: 'source.cell.delete' | 'target.cell.delete', payload: unknown = {}) {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(db, makeEvent(kind, payload), stmts)
    return recorded
  }

  const sqlFor = (recorded: RecordedStmt[], table: string) =>
    recorded.filter((r) => r.sql.includes(table))

  /**
   * The same cleanup for a delete that carries a PARENT — i.e. every removal
   * the app itself makes (`handleRemoveLine` sends `parentId: plan.eventId`).
   * A parent is what puts a `chainGate` on the projection, and the gate is
   * where this cascade and dev's AQU-1154 head compare-and-swap collided.
   */
  function gatedDeleteStmts(kind: 'source.cell.delete' | 'target.cell.delete', payload: unknown = {}) {
    const { db, recorded } = makeD1Stub()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent(kind, payload, { parentId: 'evt-parent' }),
      stmts,
      { chainGate: { projectId: 'proj-1', fileId: 'file-a', cellId: 'cell-1', parentKey: 'evt-parent' } },
    )
    return recorded
  }

  // AQU-1068 review round. THE BUG THIS CATCHES BROKE REMOVAL OUTRIGHT.
  //
  // The gate is two predicates: a `chain_claims` EXISTS, which is a
  // self-contained subquery, and a head compare-and-swap that names a `cells`
  // column. Pasting the pair onto the dependent-cleanup statements — which run
  // against cell_validators, cell_audio, cell_links, comments, cell_waivers,
  // cell_backtranslations and cell_word_morph — produced SQL referring to a
  // table not in its own FROM clause. Postgres rejects that outright, the
  // transaction fails, and the removal is lost with a 500.
  //
  // It reached a build Matthew tested and survived the whole suite, because
  // every other case here builds a PARENT-LESS event: no parent, no gate, both
  // fragments empty, collision invisible. That is the hole these two close.
  it('never names a cells column in a statement that is not against cells', () => {
    const offenders = gatedDeleteStmts('source.cell.delete')
      .filter((r) => r.sql.includes('cells.') && !/^(DELETE FROM|UPDATE|INSERT INTO) cells\b/.test(r.sql))
      .map((r) => r.sql.slice(0, 60))
    expect(offenders).toEqual([])
  })

  it('still gates every dependent statement on the claim AND the head', () => {
    // Losing the gate would be the opposite bug: a delete that lost its chain
    // slot stripping the surviving cell of everything hanging off it.
    // The cells DELETE plus the seven dependent statements — not the file
    // counters recompute, which is a whole-file aggregate and never gated.
    const gated = gatedDeleteStmts('source.cell.delete')
      .filter((r) => /^(DELETE FROM|UPDATE) (cells|cell_|comments)/.test(r.sql))
    expect(gated.length).toBeGreaterThan(1)
    for (const stmt of gated) {
      expect(stmt.sql).toContain('FROM chain_claims')
      // The head check, as a column on `cells` for the cells write itself and
      // as a subquery for everything else.
      expect(stmt.sql).toMatch(/cells\.event_id = \?|FROM cells WHERE/)
    }
  })

  it('runs the dependent cleanup BEFORE the cells row is deleted', () => {
    // The dependents test the head with a subquery, so they have to ask while
    // the row is still there. Batch order is the guarantee.
    const sqls = gatedDeleteStmts('source.cell.delete').map((r) => r.sql)
    const sourceDelete = sqls.findIndex((sql) => sql.startsWith('DELETE FROM cells') && !sql.includes("side = 'target'"))
    const lastDependent = sqls
      .map((sql) => /^(DELETE FROM|UPDATE) (cell_|comments)/.test(sql)
        || (sql.startsWith('DELETE FROM cells') && sql.includes("side = 'target'")))
      .lastIndexOf(true)
    expect(sourceDelete).toBeGreaterThan(lastDependent)
  })

  it("a target delete's cleanup tests the TARGET row's head, not the source's", () => {
    // The gate must follow the row the accompanying write targets, or a lane
    // delete would be gated on a row it is not touching.
    const validators = gatedDeleteStmts('target.cell.delete', { targetLang: 'fr' })
      .filter((r) => r.sql.includes('cell_validators'))
    expect(validators).toHaveLength(1)
    expect(validators[0].args).toContain('target')
    expect(validators[0].args).toContain('fr')
  })

  // AQU-1068 review round: the translations are the SOURCE delete's business.
  //
  // The client used to batch a parent-less `target.cell.delete` per lane beside
  // this event. Those applied unconditionally while this one still had to win
  // its chain slot, so a stale removal took the translations and left the cell
  // — and `target.cell.delete` floors at CONTRIBUTOR outside `cellEditingFloor`,
  // which made removal impossible for the tiers below it.
  it('takes every lane of translations with the source row', () => {
    const rows = sqlFor(deleteStmts('source.cell.delete'), 'DELETE FROM cells')
    const targets = rows.filter((r) => r.sql.includes("side = 'target'"))
    expect(targets).toHaveLength(1)
    // Bound by cell only — no target_lang term, so every lane goes.
    expect(targets[0].sql).not.toContain('target_lang')
    expect(targets[0].args).toEqual(['proj-1', 'file-a', 'cell-1'])
  })

  it('gates that translation delete exactly like the source row it follows', () => {
    const targets = gatedDeleteStmts('source.cell.delete')
      .filter((r) => r.sql.startsWith('DELETE FROM cells') && r.sql.includes("side = 'target'"))
    expect(targets).toHaveLength(1)
    expect(targets[0].sql).toContain('FROM chain_claims')
    expect(targets[0].sql).toContain('FROM cells WHERE')
  })

  it('a LANE delete still removes only its own lane', () => {
    // The per-lane path is untouched: clearing one translation is not the same
    // act as removing the cell.
    const rows = sqlFor(deleteStmts('target.cell.delete', { targetLang: 'fr' }), 'DELETE FROM cells')
    expect(rows).toHaveLength(1)
    expect(rows[0].sql).toContain('target_lang = ?')
    expect(rows[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'target', 'fr'])
  })

  it('clears every lane of validators for the cell', () => {
    const rows = sqlFor(deleteStmts('source.cell.delete'), 'cell_validators')
    expect(rows).toHaveLength(1)
    expect(rows[0].sql).toContain('DELETE FROM cell_validators')
    // No target_lang term: the whole cell is going, so every lane goes.
    expect(rows[0].sql).not.toContain('target_lang')
    expect(rows[0].args).toEqual(['proj-1', 'file-a', 'cell-1'])
  })

  it('soft-deletes takes rather than dropping the rows', () => {
    // Same shape cell.audio.remove uses. The R2 bytes outlive the row either
    // way, and keeping it keeps the object key discoverable for a sweep.
    const rows = sqlFor(deleteStmts('source.cell.delete'), 'cell_audio')
    expect(rows).toHaveLength(1)
    expect(rows[0].sql).toContain('UPDATE cell_audio SET deleted = 1, selected = 0')
    expect(rows[0].sql).not.toContain('DELETE FROM cell_audio')
  })

  it('tombstones pairings at either end of the link, never deleting them', () => {
    const rows = sqlFor(deleteStmts('source.cell.delete'), 'cell_links')
    expect(rows).toHaveLength(1)
    expect(rows[0].sql).toContain('UPDATE cell_links SET linked = 0')
    expect(rows[0].sql).toContain('from_cell_id = ?')
    expect(rows[0].sql).toContain('to_cell_id = ?')
    expect(rows[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'file-a', 'cell-1'])
  })

  it('soft-deletes the cell-scoped comments the way comment.delete does', () => {
    const rows = sqlFor(deleteStmts('source.cell.delete'), 'UPDATE comments')
    expect(rows).toHaveLength(1)
    expect(rows[0].sql).toContain("SET body = '', deleted_at = ?")
    expect(rows[0].sql).toContain("scope_kind = 'cell'")
    expect(rows[0].sql).toContain('deleted_at IS NULL')
  })

  it('drops waivers, back-translations and morph rows', () => {
    const recorded = deleteStmts('source.cell.delete')
    for (const table of ['cell_waivers', 'cell_backtranslations', 'cell_word_morph']) {
      const rows = sqlFor(recorded, table)
      expect(rows, table).toHaveLength(1)
      expect(rows[0].sql, table).toContain(`DELETE FROM ${table}`)
      expect(rows[0].args, table).toEqual(['proj-1', 'file-a', 'cell-1'])
    }
  })

  it('reports every table it touched, so clients invalidate all of them', () => {
    // The realtime validator rejects a projection.dirty message WHOLE when one
    // of its tables is unrecognised — so an unreported (or unregistered) table
    // would take the `cells` invalidation down with it, and a collaborator
    // would keep seeing the removed row until they reloaded.
    const { db } = makeD1Stub()
    const touched = buildEventProjectionStmts(db, makeEvent('source.cell.delete', {}), [])
    expect(touched).toEqual(
      expect.arrayContaining([
        'cells', 'files', 'cell_validators', 'cell_audio', 'cell_links',
        'comments', 'cell_waivers', 'cell_backtranslations', 'cell_word_morph',
      ]),
    )
  })

  it('a TARGET delete clears only its own lane, and touches nothing else', () => {
    const recorded = deleteStmts('target.cell.delete', { targetLang: 'fr' })
    const validators = sqlFor(recorded, 'cell_validators')
    expect(validators).toHaveLength(1)
    expect(validators[0].sql).toContain('target_lang = ?')
    expect(validators[0].args).toEqual(['proj-1', 'file-a', 'cell-1', 'fr'])
    // The cell itself survives a lane delete, so its takes, pairings and
    // comments must all survive with it.
    for (const table of ['cell_audio', 'cell_links', 'UPDATE comments', 'cell_waivers', 'cell_word_morph']) {
      expect(sqlFor(recorded, table), table).toHaveLength(0)
    }
  })

  it('gates every dependent write on the chain claim, like the cells write', () => {
    // A delete that LOST its chain slot must not strip the surviving cell of
    // its dependents.
    const { db, recorded } = makeD1Stub()
    buildEventProjectionStmts(db, makeEvent('source.cell.delete', {}), [], {
      chainGate: {
        projectId: 'proj-1', fileId: 'file-a', cellId: 'cell-1', parentKey: '<null>',
      },
    })
    const dependents = recorded.filter((r) =>
      /cell_validators|cell_audio|cell_links|UPDATE comments|cell_waivers|cell_backtranslations|cell_word_morph/.test(r.sql),
    )
    expect(dependents.length).toBeGreaterThan(0)
    for (const r of dependents) expect(r.sql, r.sql).toContain('chain_claims')
  })
})
