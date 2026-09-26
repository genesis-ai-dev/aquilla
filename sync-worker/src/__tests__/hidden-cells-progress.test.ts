// AQU-1424 — a parked cell is not work, on the server that counts it.
//
// "Hide cell" (AQU-1422) parks a cell without deleting anything. This slice is
// the other half of that promise: `cells.hidden_at IS NULL` is the ONE predicate
// that takes a parked cell out of every number and every automatic selection.
// These tests pin the three server surfaces that own those numbers — the
// progress projection, the `files` counters, and full-text search — plus the
// regression that matters most to everyone else: a file with nothing hidden
// reports exactly what it reported before.

import { describe, expect, it } from 'vitest'
import { makeTestDb } from './helpers/pg-test-db'
import {
  fileProgressRecomputeStmt,
  fullProgressRecomputeStmts,
} from '../events/progress-projection'
import { fileCountersRecomputeStmt } from '../events/event-projection'
import {
  makeVerifiedProjectId,
  queryScopedSearch,
  queryScopedExact,
} from '../events/scoped-search'
import { readFirstOpenCell } from '../events/progress-read-route'
import type { SyncTokenClaims } from '../auth'

const PROJECT = 'project-hidden'
const FILE = 'file-hidden'

function source(cellId: string, canonicalRef: string, opts: { hidden?: boolean; type?: string | null } = {}) {
  return {
    project_id: PROJECT, file_id: FILE, cell_id: cellId, side: 'source',
    target_lang: '', type: opts.type ?? 'verse',
    value: `source ${cellId}`, canonical_ref: canonicalRef, event_id: `source-${cellId}`,
    last_editor: 'alice', last_edit_at: 1, validated: 0, endorsement_count: 0, word_count: 2,
    // NULL means visible, which is what every pre-0112 row reads as.
    hidden_at: opts.hidden ? 1_700_000_000_000 : null,
  }
}

function target(cellId: string, value: string) {
  return {
    project_id: PROJECT, file_id: FILE, cell_id: cellId, side: 'target',
    target_lang: '', value, canonical_ref: null, event_id: `target-${cellId}`,
    last_editor: 'alice', last_edit_at: 2, validated: 0,
    endorsement_count: 0, word_count: value ? 1 : 0,
  }
}

/** Ten cells in GEN 1, nine translated. `c10` is the untranslated one, and is
 *  the cell these tests park. */
function tenCells(opts: { hideC10?: boolean } = {}) {
  const rows: Array<Record<string, unknown>> = []
  for (let n = 1; n <= 10; n++) {
    const id = `c${n}`
    const last = n === 10
    rows.push(source(id, `GEN 1:${n}`, last ? { hidden: opts.hideC10 } : {}))
    rows.push(target(id, last ? '' : `draft ${n}`))
  }
  return rows
}

async function fixture(cells: Array<Record<string, unknown>>) {
  return makeTestDb({
    files: [{ id: FILE, project_id: PROJECT, name: 'Genesis', event_id: 'file-event' }],
    cells,
  })
}

interface ProgressRow {
  scope: string
  section_key: string
  total_count: number
  filled_count: number
}

async function fileRow(db: Awaited<ReturnType<typeof fixture>>): Promise<ProgressRow | undefined> {
  const all = await db.rows<ProgressRow>('file_section_progress')
  return all.find((row) => row.scope === 'file')
}

describe('AQU-1424 — hidden cells leave the progress projection', () => {
  it('drops a parked cell from both the numerator and the denominator', async () => {
    const visible = await fixture(tenCells())
    await visible.db.batch(fullProgressRecomputeStmts(visible.db, PROJECT, FILE, 100))
    expect(await fileRow(visible)).toMatchObject({ total_count: 10, filled_count: 9 })

    const hidden = await fixture(tenCells({ hideC10: true }))
    await hidden.db.batch(fullProgressRecomputeStmts(hidden.db, PROJECT, FILE, 100))
    // 9 of 9 — "hiding the untranslated cell shows 100%".
    expect(await fileRow(hidden)).toMatchObject({ total_count: 9, filled_count: 9 })
  })

  it('makes the section and book rows agree with the file figure', async () => {
    const hidden = await fixture(tenCells({ hideC10: true }))
    await hidden.db.batch(fullProgressRecomputeStmts(hidden.db, PROJECT, FILE, 100))
    const all = await hidden.rows<ProgressRow>('file_section_progress')
    expect(all.find((r) => r.scope === 'section' && r.section_key === 'GEN 1'))
      .toMatchObject({ total_count: 9, filled_count: 9 })
    expect(all.find((r) => r.scope === 'book'))
      .toMatchObject({ section_key: 'GEN', total_count: 9, filled_count: 9 })
  })

  it('prunes a section the hide empties rather than leaving it at a stale count', async () => {
    // GEN 2 has exactly one cell. Park it and the chapter is not a unit of work
    // any more, so its row must go — a surviving row would sit at whatever count
    // it last held, and no later recompute would revisit it.
    const t = await fixture([
      source('c1', 'GEN 1:1'), target('c1', 'uno'),
      source('c2', 'GEN 2:1'), target('c2', 'dos'),
    ])
    await t.db.batch(fullProgressRecomputeStmts(t.db, PROJECT, FILE, 100))
    expect((await t.rows<ProgressRow>('file_section_progress'))
      .some((r) => r.section_key === 'GEN 2')).toBe(true)

    await t.pg.query(
      `UPDATE cells SET hidden_at = 1 WHERE project_id = $1 AND file_id = $2
         AND cell_id = 'c2' AND side = 'source'`,
      [PROJECT, FILE],
    )
    await t.db.batch(fullProgressRecomputeStmts(t.db, PROJECT, FILE, 101))
    expect((await t.rows<ProgressRow>('file_section_progress'))
      .some((r) => r.section_key === 'GEN 2')).toBe(false)
    expect(await fileRow(t)).toMatchObject({ total_count: 1, filled_count: 1 })
  })

  it('counts the cell again the moment it is shown', async () => {
    const t = await fixture(tenCells({ hideC10: true }))
    await t.db.batch(fullProgressRecomputeStmts(t.db, PROJECT, FILE, 100))
    expect(await fileRow(t)).toMatchObject({ total_count: 9 })

    await t.pg.query(
      `UPDATE cells SET hidden_at = NULL WHERE project_id = $1 AND file_id = $2
         AND cell_id = 'c10' AND side = 'source'`,
      [PROJECT, FILE],
    )
    await fileProgressRecomputeStmt(t.db, PROJECT, FILE, 101).run()
    expect(await fileRow(t)).toMatchObject({ total_count: 10, filled_count: 9 })
  })

  it('leaves a file with nothing hidden byte-identical to before', async () => {
    const before = await fixture(tenCells())
    await before.db.batch(fullProgressRecomputeStmts(before.db, PROJECT, FILE, 100))
    const after = await fixture(tenCells({ hideC10: false }))
    await after.db.batch(fullProgressRecomputeStmts(after.db, PROJECT, FILE, 100))
    expect(await after.rows('file_section_progress'))
      .toEqual(await before.rows('file_section_progress'))
  })
})

describe('AQU-1424 — a hidden cell is never the next thing to work on', () => {
  it('skips a parked cell when jumping to the first untranslated one', async () => {
    // c2 is parked and untranslated; c3 is the first one a translator should
    // actually land on. Before this, "next unfinished" walked them straight into
    // a row they had deliberately taken out of the work.
    const t = await fixture([
      source('c1', 'GEN 1:1'), target('c1', 'uno'),
      source('c2', 'GEN 1:2', { hidden: true }), target('c2', ''),
      source('c3', 'GEN 1:3'), target('c3', ''),
    ])
    expect(await readFirstOpenCell(t.db, PROJECT, FILE, '', 'untranslated', '')).toBe('c3')
  })

  it('offers it again once it is shown', async () => {
    const t = await fixture([
      source('c1', 'GEN 1:1'), target('c1', 'uno'),
      source('c2', 'GEN 1:2', { hidden: true }), target('c2', ''),
      source('c3', 'GEN 1:3'), target('c3', ''),
    ])
    await t.pg.query(
      `UPDATE cells SET hidden_at = NULL WHERE project_id = $1 AND cell_id = 'c2' AND side = 'source'`,
      [PROJECT],
    )
    expect(await readFirstOpenCell(t.db, PROJECT, FILE, '', 'untranslated', '')).toBe('c2')
  })
})

describe('AQU-1424 — hidden cells leave the files counters', () => {
  it('excludes a parked cell from cell_count and the target counters', async () => {
    const t = await fixture(tenCells({ hideC10: true }))
    await fileCountersRecomputeStmt(t.db, PROJECT, FILE, 200).run()
    const [file] = await t.rows<{ cell_count: number; filled_count: number; word_count: number }>('files')
    expect(file.cell_count).toBe(9)
    expect(file.filled_count).toBe(9)

    await t.pg.query(
      `UPDATE cells SET hidden_at = NULL WHERE project_id = $1 AND file_id = $2
         AND cell_id = 'c10' AND side = 'source'`,
      [PROJECT, FILE],
    )
    await fileCountersRecomputeStmt(t.db, PROJECT, FILE, 201).run()
    const [shown] = await t.rows<{ cell_count: number; filled_count: number }>('files')
    expect(shown.cell_count).toBe(10)
    expect(shown.filled_count).toBe(9)
  })

  it('still drives an empty file to zero', async () => {
    // The predicate rides the LEFT JOIN, so an absent source row has to read as
    // VISIBLE — otherwise a file whose cells all went away keeps its old counts.
    const t = await fixture([])
    await fileCountersRecomputeStmt(t.db, PROJECT, FILE, 200).run()
    const [file] = await t.rows<{ cell_count: number; filled_count: number }>('files')
    expect(file.cell_count).toBe(0)
    expect(file.filled_count).toBe(0)
  })
})

describe('AQU-1424 — hidden cells are not searchable', () => {
  const claims = { projectId: PROJECT } as SyncTokenClaims

  it('returns no hit for a word that appears only on a hidden cell', async () => {
    const t = await fixture([
      source('c1', 'GEN 1:1'), target('c1', 'a visible rendering'),
      { ...source('c2', 'GEN 1:2', { hidden: true }), value: 'quokka' },
      { ...target('c2', 'quokka translated'), value: 'quokka translated' },
    ])
    const project = makeVerifiedProjectId(claims)
    // Both sides: the flag lives on the source row, so a target-side match has
    // to be filtered by looking at the source row rather than at itself.
    expect(await queryScopedSearch(t.db, project, 'quokka', {})).toEqual([])
    expect(await queryScopedExact(t.db, project, 'quokka', {})).toEqual([])
    // ...and Find & Replace, whose candidates are exactly these results, then has
    // nothing to rewrite in text the reviewer cannot see.
  })

  it('finds the same word again once the cell is shown', async () => {
    const t = await fixture([
      source('c1', 'GEN 1:1'), target('c1', 'a visible rendering'),
      { ...source('c2', 'GEN 1:2', { hidden: true }), value: 'quokka' },
      { ...target('c2', 'quokka translated'), value: 'quokka translated' },
    ])
    await t.pg.query(
      `UPDATE cells SET hidden_at = NULL WHERE project_id = $1 AND cell_id = 'c2' AND side = 'source'`,
      [PROJECT],
    )
    const hits = await queryScopedSearch(t.db, makeVerifiedProjectId(claims), 'quokka', {})
    expect(hits.map((h) => `${h.cellId}:${h.side}`).sort()).toEqual(['c2:source', 'c2:target'])
  })

  it('leaves a project with nothing hidden returning every hit it did before', async () => {
    const t = await fixture([
      source('c1', 'GEN 1:1'), target('c1', 'a visible rendering'),
      { ...source('c2', 'GEN 1:2'), value: 'quokka' },
    ])
    const hits = await queryScopedSearch(t.db, makeVerifiedProjectId(claims), 'quokka', {})
    expect(hits.map((h) => h.cellId)).toEqual(['c2'])
  })
})
