// AQU-538 slice 2: per-lane validators + per-lane file/section progress.
//
// The TMS-style model (docs/superpowers/specs/2026-07-11-project-data-model-
// decision.md) fans a shared source into N target lanes ('' = default lane).
// Slice 1 pinned the cells projection; this suite pins the projection surfaces
// that reach the client per lane, on a REAL Postgres engine (PGlite + the prod
// shim):
//
//   1. A standing validation is per lane — validating lane A never touches
//      lane B's validated flag, and one user can hold validations on two lanes
//      of one cell (two cell_validators rows).
//   2. Unvalidate removes ONLY that lane's validator row.
//   3. The AQU-279 validationCount threshold still works, independently, per
//      lane.
//   4. file_section_progress materializes one row set per lane (file + section
//      scopes) — and the '' rows are byte-identical to the pre-lane projection
//      for N=1 projects. The source denominator is lane-independent (shared
//      across lanes).
//
//      AQU-1599: "one row set per lane" now means per row of `lanes`, so the
//      default lane gets its rows because the project HAS a default lane (every
//      create / settings write runs ensureProjectLaneStmts), not because the
//      projection manufactured a '' row whether or not one existed. The source
//      lane gets a row set too; it carries the denominator and no translations.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  buildEventProjectionStmts,
  type PersistedEvent,
} from '../events/event-projection'
import { fullProgressRecomputeStmts } from '../events/progress-projection'
import type { EventKind } from '../events/types'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { progressRowsForLane } from './helpers/progress-rows'

type ProjectionOpts = { deferFileCounters?: boolean; validationCount?: number }

const PROJECT = 'proj-lanes'
const FILE = 'file-1'

let seq = 0
function ev(partial: Partial<PersistedEvent> & { kind: EventKind }): PersistedEvent {
  seq += 1
  return {
    id: partial.id ?? `e${seq}`,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId: partial.cellId ?? 'cell-1',
    parentId: null,
    author: 'alice',
    payload: {},
    clientTs: 1000 + seq,
    serverTs: 1000 + seq,
    serverSeq: seq,
    ...partial,
  }
}

async function applyEvents(
  db: AquillaDb,
  events: PersistedEvent[],
  opts: ProjectionOpts = { deferFileCounters: true },
): Promise<void> {
  const stmts: AquillaStatement[] = []
  for (const e of events) buildEventProjectionStmts(db, e, stmts, opts)
  for (const s of stmts) await s.run()
}

interface ValidatorRow {
  cell_id: string
  target_lang: string
  username: string
  event_id: string
}
interface CellRow {
  cell_id: string
  side: string
  target_lang: string
  value: string
  validated: number
}
interface ProgressRow {
  scope: string
  section_key: string
  target_lang: string
  total_count: number
  filled_count: number
}

let t: TestDb
beforeEach(async () => {
  if (!t) t = await makeTestDb()
  else await t.reset()
  seq = 0
})
afterAll(async () => {
  await t?.close()
})

async function validators(): Promise<ValidatorRow[]> {
  const rows = await t.rows<ValidatorRow>('cell_validators')
  return rows.sort(
    (a, b) =>
      a.cell_id.localeCompare(b.cell_id) ||
      a.target_lang.localeCompare(b.target_lang) ||
      a.username.localeCompare(b.username),
  )
}
async function targets(): Promise<CellRow[]> {
  const rows = await t.rows<CellRow>('cells')
  return rows
    .filter((r) => r.side === 'target')
    .sort((a, b) => a.cell_id.localeCompare(b.cell_id) || a.target_lang.localeCompare(b.target_lang))
}
/**
 * The TARGET lanes' progress rows. AQU-1599 gave the source lane a row of its
 * own — the lane-independent denominator, carrying no lane's translations — so
 * reading the whole table here would put a second '' row beside the default
 * lane's in every expectation below. `sourceProgress` reads that one.
 */
async function progress(): Promise<ProgressRow[]> {
  const rows = await progressRowsForLane<ProgressRow>(t.pg, PROJECT, 'target')
  return rows.sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.section_key.localeCompare(b.section_key) ||
      a.target_lang.localeCompare(b.target_lang),
  )
}

/** Two target lanes (fr, swh) committed on one shared source cell. */
async function seedTwoLanes(): Promise<void> {
  await applyEvents(t.db, [
    ev({ kind: 'source.cell.create', id: 'src-1', payload: { cellId: 'cell-1', value: 'Hello', canonicalRef: 'GEN 1:1' } }),
    ev({ kind: 'target.cell.commit', id: 'tc-fr', parentId: 'src-1', payload: { value: 'Bonjour', targetLang: 'fr' } }),
    ev({ kind: 'target.cell.commit', id: 'tc-swh', parentId: 'src-1', payload: { value: 'Habari', targetLang: 'swh' } }),
  ])
}

describe('per-lane validators', () => {
  it('validating lane fr leaves lane swh untouched', async () => {
    await seedTwoLanes()
    await applyEvents(t.db, [
      ev({ kind: 'cell.validate', author: 'reviewer', payload: { editEventId: 'tc-fr', targetLang: 'fr' } }),
    ])
    const rows = await targets()
    expect(rows.find((r) => r.target_lang === 'fr')!.validated).toBe(1)
    expect(rows.find((r) => r.target_lang === 'swh')!.validated).toBe(0)
    const v = await validators()
    expect(v.map((r) => [r.target_lang, r.username])).toEqual([['fr', 'reviewer']])
  })

  it('one user holds standing validations on two lanes of one cell', async () => {
    await seedTwoLanes()
    await applyEvents(t.db, [
      ev({ kind: 'cell.validate', author: 'reviewer', payload: { editEventId: 'tc-fr', targetLang: 'fr' } }),
      ev({ kind: 'cell.validate', author: 'reviewer', payload: { editEventId: 'tc-swh', targetLang: 'swh' } }),
    ])
    const v = await validators()
    expect(v).toHaveLength(2)
    expect(v.map((r) => [r.cell_id, r.target_lang, r.username, r.event_id])).toEqual([
      ['cell-1', 'fr', 'reviewer', 'tc-fr'],
      ['cell-1', 'swh', 'reviewer', 'tc-swh'],
    ])
    const rows = await targets()
    expect(rows.every((r) => r.validated === 1)).toBe(true)
  })

  it('unvalidate removes only the addressed lane', async () => {
    await seedTwoLanes()
    await applyEvents(t.db, [
      ev({ kind: 'cell.validate', author: 'reviewer', payload: { editEventId: 'tc-fr', targetLang: 'fr' } }),
      ev({ kind: 'cell.validate', author: 'reviewer', payload: { editEventId: 'tc-swh', targetLang: 'swh' } }),
      ev({ kind: 'cell.unvalidate', author: 'reviewer', payload: { editEventId: 'tc-fr', targetLang: 'fr' } }),
    ])
    const v = await validators()
    expect(v.map((r) => r.target_lang)).toEqual(['swh'])
    const rows = await targets()
    expect(rows.find((r) => r.target_lang === 'fr')!.validated).toBe(0)
    expect(rows.find((r) => r.target_lang === 'swh')!.validated).toBe(1)
  })

  it('N=1 default lane: a lane-less validate marks the "" row validated', async () => {
    await applyEvents(t.db, [
      ev({ kind: 'source.cell.create', id: 'src-1', payload: { cellId: 'cell-1', value: 'Hello' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-1', parentId: 'src-1', payload: { value: 'Bonjour' } }),
      ev({ kind: 'cell.validate', author: 'reviewer', payload: { editEventId: 'tc-1' } }),
    ])
    const v = await validators()
    expect(v).toHaveLength(1)
    expect(v[0].target_lang).toBe('')
    expect((await targets())[0].validated).toBe(1)
  })

  it('threshold (validationCount=2) is enforced per lane', async () => {
    await seedTwoLanes()
    const opts: ProjectionOpts = { deferFileCounters: true, validationCount: 2 }
    // One validator on each lane — below threshold everywhere.
    await applyEvents(
      t.db,
      [
        ev({ kind: 'cell.validate', author: 'rev1', payload: { editEventId: 'tc-fr', targetLang: 'fr' } }),
        ev({ kind: 'cell.validate', author: 'rev1', payload: { editEventId: 'tc-swh', targetLang: 'swh' } }),
      ],
      opts,
    )
    let rows = await targets()
    expect(rows.find((r) => r.target_lang === 'fr')!.validated).toBe(0)
    expect(rows.find((r) => r.target_lang === 'swh')!.validated).toBe(0)

    // Second validator ONLY on fr crosses the threshold for fr, not swh.
    await applyEvents(
      t.db,
      [ev({ kind: 'cell.validate', author: 'rev2', payload: { editEventId: 'tc-fr', targetLang: 'fr' } })],
      opts,
    )
    rows = await targets()
    expect(rows.find((r) => r.target_lang === 'fr')!.validated).toBe(1)
    expect(rows.find((r) => r.target_lang === 'swh')!.validated).toBe(0)
    expect((await validators()).filter((r) => r.target_lang === 'fr')).toHaveLength(2)
  })
})

describe('per-lane file/section progress', () => {
  it('N=1: default-lane rows are byte-identical to the pre-lane projection', async () => {
    // Two source cells in one section; one default-lane target filled.
    await applyEvents(t.db, [
      ev({ kind: 'source.cell.create', id: 'src-1', payload: { cellId: 'cell-1', value: 'a', canonicalRef: 'GEN 1:1' } }),
      ev({ kind: 'source.cell.create', id: 'src-2', payload: { cellId: 'cell-2', value: 'b', canonicalRef: 'GEN 1:2' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-1', cellId: 'cell-1', parentId: 'src-1', payload: { value: 'Bonjour' } }),
    ])
    for (const s of fullProgressRecomputeStmts(t.db, PROJECT, FILE, 5000)) await s.run()

    const rows = await progress()
    // Exactly one row per scope, all on the '' lane. AQU-1093 added the book
    // row (this fixture is Scripture, so GEN rolls its chapters up); the point
    // of this test is that N=1 produces ONE lane, which still holds.
    expect(rows.map((r) => [r.scope, r.section_key, r.target_lang, r.total_count, r.filled_count])).toEqual([
      ['book', 'GEN', '', 2, 1],
      ['file', '', '', 2, 1],
      ['section', 'GEN 1', '', 2, 1],
    ])
    expect(rows.every((r) => r.target_lang === '')).toBe(true)
  })

  it('AQU-1599: the source lane gets a row of its own, with the denominator and no translations', async () => {
    await applyEvents(t.db, [
      ev({ kind: 'source.cell.create', id: 'src-1', payload: { cellId: 'cell-1', value: 'a', canonicalRef: 'GEN 1:1' } }),
      ev({ kind: 'source.cell.create', id: 'src-2', payload: { cellId: 'cell-2', value: 'b', canonicalRef: 'GEN 1:2' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-1', cellId: 'cell-1', parentId: 'src-1', payload: { value: 'Bonjour' } }),
    ])
    for (const s of fullProgressRecomputeStmts(t.db, PROJECT, FILE, 5000)) await s.run()

    // One row per scope, keyed to the source lane: the full denominator, and
    // filled_count 0 because no translation belongs to the source lane. This is
    // the row the plan board, the files list and the org overview take their
    // lane-independent numbers from, so archiving a target lane cannot move it.
    const sourceRows = await progressRowsForLane<ProgressRow>(t.pg, PROJECT, 'source')
    expect(sourceRows.map((r) => [r.scope, r.section_key, r.total_count, r.filled_count])).toEqual([
      ['book', 'GEN', 2, 0],
      ['file', '', 2, 0],
      ['section', 'GEN 1', 2, 0],
    ])
    // And it is NOT one of the lanes anybody translates in.
    expect((await progress()).every((r) => r.target_lang === '')).toBe(true)
  })

  it('materializes one row set per lane, including the untranslated default lane, sharing the source denominator', async () => {
    // The default lane exists because the project has one — what every create
    // and settings write makes sure of (db/shared/lanes.ts) — not because the
    // projection invents a '' row. Nobody has translated in it.
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position)
       VALUES ('deflane', $1, 'target', 'Default', '', 1)`,
      [PROJECT],
    )
    // Two source cells; fr fills both, swh fills one, default lane fills none.
    await applyEvents(t.db, [
      ev({ kind: 'source.cell.create', id: 'src-1', payload: { cellId: 'cell-1', value: 'a', canonicalRef: 'GEN 1:1' } }),
      ev({ kind: 'source.cell.create', id: 'src-2', payload: { cellId: 'cell-2', value: 'b', canonicalRef: 'GEN 1:2' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-fr-1', cellId: 'cell-1', parentId: 'src-1', payload: { value: 'Bonjour', targetLang: 'fr' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-fr-2', cellId: 'cell-2', parentId: 'src-2', payload: { value: 'Salut', targetLang: 'fr' } }),
      ev({ kind: 'target.cell.commit', id: 'tc-swh-1', cellId: 'cell-1', parentId: 'src-1', payload: { value: 'Habari', targetLang: 'swh' } }),
    ])
    for (const s of fullProgressRecomputeStmts(t.db, PROJECT, FILE, 5000)) await s.run()

    const rows = await progress()
    // File scope: one row per lane ('', fr, swh); denominator shared (=2).
    const files = rows.filter((r) => r.scope === 'file')
    expect(files.map((r) => [r.target_lang, r.total_count, r.filled_count])).toEqual([
      ['', 2, 0],
      ['fr', 2, 2],
      ['swh', 2, 1],
    ])
    // Section scope mirrors it (single section GEN 1).
    const sections = rows.filter((r) => r.scope === 'section')
    expect(sections.map((r) => [r.section_key, r.target_lang, r.total_count, r.filled_count])).toEqual([
      ['GEN 1', '', 2, 0],
      ['GEN 1', 'fr', 2, 2],
      ['GEN 1', 'swh', 2, 1],
    ])
  })
})
