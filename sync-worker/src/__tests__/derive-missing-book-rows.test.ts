// AQU-1278: migration 0095 — book rows derived from the chapter rows a file
// already has, for files projected before book rows existed.
//
// The one claim that matters: what the derivation writes is byte-for-byte what
// the projection would have written. So every test here runs the REAL
// projection first, and the derivation is judged against its output.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTestDb } from './helpers/pg-test-db'
import { fullProgressRecomputeStmts } from '../events/progress-projection'

const MIGRATION = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../db/postgres/migrations/0095_derive_missing_book_rows.sql',
  ),
  'utf8',
)

const PROJECT = 'project-derive'

function source(fileId: string, cellId: string, canonicalRef: string | null, over: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT, file_id: fileId, cell_id: cellId, side: 'source', type: 'verse',
    value: `source ${cellId}`, canonical_ref: canonicalRef, event_id: `source-${cellId}`,
    last_editor: 'alice', last_edit_at: 1, validated: 0, endorsement_count: 0, word_count: 2,
    ...over,
  }
}

function target(fileId: string, cellId: string, value: string, endorsements: number, lane = '') {
  return {
    project_id: PROJECT, file_id: fileId, cell_id: cellId, side: 'target', target_lang: lane,
    value, canonical_ref: null, event_id: `target-${cellId}-${lane}`,
    last_editor: 'alice', last_edit_at: 2 + endorsements, validated: endorsements >= 2 ? 1 : 0,
    endorsement_count: endorsements, word_count: value ? 1 : 0,
  }
}

function file(id: string) {
  return { id, project_id: PROJECT, name: id, event_id: `file-${id}` }
}

type Row = Record<string, unknown>
const key = (r: Row) => `${r.file_id}|${r.target_lang}|${r.section_key}`
const byKey = (rows: Row[]) =>
  Object.fromEntries(rows.map((r) => [key(r), r])) as Record<string, Row>

describe('0095 derives the book rows an old projection never wrote', () => {
  /**
   * A two-book Scripture file with the shapes that make a book row
   * non-trivial: a heading (structural), an unfilled cell, endorsements in
   * two buckets, a second lane, and a recorded take.
   */
  async function bible() {
    const t = await makeTestDb({
      files: [file('bible')],
      project_settings: [{ project_id: PROJECT, settings: JSON.stringify({ validationCount: 2 }), version: 1 }],
      events: [{
        id: 'ev-9', schema_version: 1, project_id: PROJECT, file_id: 'bible',
        cell_id: 'g1', parent_id: null, kind: 'target.cell.commit', author: 'alice',
        payload: '{}', client_ts: 9, server_ts: 9, server_seq: 9,
      }],
      cells: [
        source('bible', 'g0', 'GEN 1:0', { type: 'heading' }), target('bible', 'g0', 'Genesis', 2),
        source('bible', 'g1', 'GEN 1:1'), target('bible', 'g1', 'uno', 2), target('bible', 'g1', 'un', 1, 'fr'),
        source('bible', 'g2', 'GEN 1:2'), target('bible', 'g2', '', 0),
        source('bible', 'g3', 'GEN 2:1'), target('bible', 'g3', 'tres', 1),
        source('bible', 'e1', 'EXO 1:1'), target('bible', 'e1', 'cuatro', 2),
      ],
      cell_audio: [{
        project_id: PROJECT, file_id: 'bible', cell_id: 'g1', audio_id: 'take-g1',
        slot: 'take', url: 'local://g1.webm', selected: 1, deleted: 0, approved: 1,
        event_id: 'aev-g1', created_ts: 3,
      }],
    })
    await t.db.batch(fullProgressRecomputeStmts(t.db, PROJECT, 'bible', 500))
    return t
  }

  const bookRows = async (t: Awaited<ReturnType<typeof makeTestDb>>) =>
    (await t.rows<Row>('file_section_progress')).filter((r) => r.scope === 'book')

  it('writes exactly what the projection wrote, column for column, in every lane', async () => {
    const t = await bible()
    const projected = await bookRows(t)
    // Two books × two lanes, and the fixture exercised what it meant to.
    expect(projected.map(key).sort()).toEqual(
      ['bible||EXO', 'bible||GEN', 'bible|fr|EXO', 'bible|fr|GEN'].sort(),
    )
    const gen = byKey(projected)['bible||GEN']
    expect(gen).toMatchObject({ total_count: 4, filled_count: 3, structural_count: 1, audio_count: 1 })
    expect(Object.keys(gen.validator_histogram as object).length).toBeGreaterThan(1)

    // The old-projection shape: chapters present, books absent.
    await t.pg.exec(`DELETE FROM file_section_progress WHERE scope = 'book'`)
    expect(await bookRows(t)).toEqual([])

    await t.pg.exec(MIGRATION)

    // AQU-490: the two audio histograms are deliberately NOT part of this
    // parity claim, and cannot be. 0096 adds those columns and runs AFTER this
    // migration, so the statement below has no such columns to select when it
    // actually executes; they take their '{}' default and the progress
    // backfill computes them, which is the discipline 0096's header states —
    // an aggregate the projection already knows how to derive never gets a
    // second, hand-written definition in SQL.
    const derivable = (row: Row) => {
      const { audio_validator_histogram: _a, structural_audio_validator_histogram: _s, ...rest } = row
      return rest
    }
    const derived = await bookRows(t)
    expect(byKey(derived.map(derivable))).toEqual(byKey(projected.map(derivable)))

    // And the part that is left undone is left undone honestly: empty, not
    // wrong. A stale non-empty histogram here would read as "nobody has
    // validated any of this" on a book that is fully signed off.
    for (const row of derived) {
      expect(row.audio_validator_histogram).toEqual({})
      expect(row.structural_audio_validator_histogram).toEqual({})
    }

    // The backfill closes the gap: one recompute and the rows match in full.
    await t.db.batch(fullProgressRecomputeStmts(t.db, PROJECT, 'bible', 500))
    expect(byKey(await bookRows(t))).toEqual(byKey(projected))
  })

  it('is idempotent, and leaves a file that already has book rows alone', async () => {
    const t = await bible()
    const before = byKey(await bookRows(t))
    await t.pg.exec(MIGRATION)
    await t.pg.exec(MIGRATION)
    expect(byKey(await bookRows(t))).toEqual(before)
  })

  it('honours the projection’s gate: no verse-shaped reference, no book rows', async () => {
    // The projection refuses book rows for a file whose references are
    // chapter- or code-only ("GEN", "GEN 1") — a document with two-token
    // headings must not sprout books. Its chapter rows still exist, so a
    // derivation that only looked at section keys would invent book rows the
    // next recompute would then delete and not replace.
    const t = await makeTestDb({
      files: [file('codes'), file('media')],
      project_settings: [{ project_id: PROJECT, settings: JSON.stringify({ validationCount: 1 }), version: 1 }],
      cells: [
        source('codes', 'a1', 'GEN'), target('codes', 'a1', 'x', 1),
        source('codes', 'a2', 'LUK'), target('codes', 'a2', 'y', 1),
        source('media', 'm1', null, { start_ms: 1000 }), target('media', 'm1', 'z', 1),
      ],
    })
    await t.db.batch(fullProgressRecomputeStmts(t.db, PROJECT, 'codes', 500))
    await t.db.batch(fullProgressRecomputeStmts(t.db, PROJECT, 'media', 500))
    const sections = (await t.rows<Row>('file_section_progress')).filter((r) => r.scope === 'section')
    expect(sections.map((r) => r.section_key).sort()).toEqual(['GEN', 'LUK', 't:000000000000'])
    expect(await bookRows(t)).toEqual([])

    await t.pg.exec(MIGRATION)

    expect(await bookRows(t)).toEqual([])
  })

  it('skips a tombstoned file', async () => {
    const t = await bible()
    const projected = await bookRows(t)
    await t.pg.exec(`DELETE FROM file_section_progress WHERE scope = 'book'`)
    await t.pg.exec(`UPDATE files SET deleted_at = 1 WHERE id = 'bible'`)
    await t.pg.exec(MIGRATION)
    expect(await bookRows(t)).toEqual([])
    expect(projected.length).toBe(4)
  })
})
