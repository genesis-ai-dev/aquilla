// AQU-1240 slice 5: the projection resolves each cells row's opaque `lane_id`
// from (project, side, lane tag) via the `lanes` side table.
//
// The invariant these tests pin (design §6, 4-then-5 / 5-then-4 convergence):
//   1. Resolution is correct — source rows -> the project's role='source' lane;
//      default-lane target rows (tag '') -> the role='target' lane with
//      legacy_tag=''; a named target row -> the lane with the matching tag.
//   2. Resolution is DETERMINISTIC across paths — the canonical per-event
//      projection, a rebuild/replay, and the bulk-import builders all land the
//      SAME lane_id, because they run the same SQL against the same (replay-
//      stable) `lanes` table.
//   3. It is BEHAVIOR-NEUTRAL until lanes exist — with no matching lane the
//      subquery is NULL, so lane_id stays NULL (additive column, migration 0093).

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildBulkSourceCellCreateStmt,
  buildBulkTargetCellCommitStmt,
  buildEventProjectionStmts,
  type PersistedEvent,
} from '../events/event-projection'
import { fullProgressRecomputeStmts } from '../events/progress-projection'
import type { EventKind } from '../events/types'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const PROJECT = 'proj-lane-id'
const FILE = 'file-1'
const SECRET = 'test-secret'

const SOURCE_LANE = 'lane-src'
const DEFAULT_TARGET_LANE = 'lane-tgt-default'
const ES_LANE = 'lane-tgt-es'

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

/** Seed the three lanes the tests resolve against. Omit to test the
 *  behavior-neutral (no lanes -> NULL) path. */
async function seedLanes(t: TestDb): Promise<void> {
  await t.pg.query(
    `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag) VALUES
       ($1, $4, 'source', 'Source',  NULL, NULL),
       ($2, $4, 'target', 'Default', NULL, ''),
       ($3, $4, 'target', 'Spanish', 'es', 'es')`,
    [SOURCE_LANE, DEFAULT_TARGET_LANE, ES_LANE, PROJECT],
  )
}

async function insertEventRow(db: AquillaDb, e: PersistedEvent): Promise<void> {
  await db
    .prepare(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      e.id, e.schemaVersion, e.projectId, e.fileId, e.cellId, e.parentId ?? null,
      e.kind, e.author, JSON.stringify(e.payload), e.clientTs, e.serverTs, e.serverSeq ?? 0,
    )
    .run()
}

async function replayViaRebuild(t: TestDb): Promise<void> {
  const res = await handleRebuildProjectionRequest(
    new Request(`https://worker/admin/projects/${PROJECT}/rebuild-projection`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
  )
  expect(res?.status).toBe(200)
}

async function laneIdOf(t: TestDb, side: 'source' | 'target', targetLang: string): Promise<string | null> {
  const r = await t.pg.query<{ lane_id: string | null }>(
    `SELECT lane_id FROM cells
      WHERE project_id = $1 AND file_id = $2 AND side = $3 AND target_lang = $4`,
    [PROJECT, FILE, side, targetLang],
  )
  return r.rows[0]?.lane_id ?? null
}

/** Run the canonical per-event projection for a set of events. */
async function project(t: TestDb, events: PersistedEvent[]): Promise<void> {
  const stmts: AquillaStatement[] = []
  for (const e of events) buildEventProjectionStmts(t.db, e, stmts, { deferFileCounters: true })
  for (const s of stmts) await s.run()
}

const SOURCE = ev({ kind: 'source.cell.create', id: 'src-1', payload: { cellId: 'cell-1', value: 'Hello' } })
const LEGACY_TARGET = ev({ kind: 'target.cell.commit', id: 'tc-legacy', parentId: 'src-1', payload: { value: 'Bonjour' } })
const ES_TARGET = ev({ kind: 'target.cell.commit', id: 'tc-es', parentId: 'src-1', payload: { value: 'Hola', targetLang: 'es' } })

let t: TestDb
beforeEach(async () => {
  if (!t) t = await makeTestDb()
  else await t.reset()
  seq = 0
})
afterAll(async () => {
  await t?.close()
})

describe('lane_id resolution — canonical per-event projection', () => {
  it('resolves source -> role=source, default target -> legacy_tag="", named target -> matching tag', async () => {
    await seedLanes(t)
    await project(t, [SOURCE, LEGACY_TARGET, ES_TARGET])

    expect(await laneIdOf(t, 'source', '')).toBe(SOURCE_LANE)
    expect(await laneIdOf(t, 'target', '')).toBe(DEFAULT_TARGET_LANE)
    expect(await laneIdOf(t, 'target', 'es')).toBe(ES_LANE)
  })

  it('leaves lane_id NULL when the project has no lanes rows (behavior-neutral)', async () => {
    await project(t, [SOURCE, LEGACY_TARGET, ES_TARGET])

    expect(await laneIdOf(t, 'source', '')).toBeNull()
    expect(await laneIdOf(t, 'target', '')).toBeNull()
    expect(await laneIdOf(t, 'target', 'es')).toBeNull()
  })

  it('backfills lane_id on ON CONFLICT: a row first written lanes-less resolves once lanes exist', async () => {
    // First commit lands NULL (no lanes yet); then lanes appear; a later commit
    // to the same row must fill lane_id via COALESCE(excluded.lane_id, ...).
    await project(t, [SOURCE, LEGACY_TARGET])
    expect(await laneIdOf(t, 'target', '')).toBeNull()

    await seedLanes(t)
    await project(t, [ev({ kind: 'target.cell.commit', id: 'tc-2', parentId: 'tc-legacy', payload: { value: 'Salut' } })])
    expect(await laneIdOf(t, 'target', '')).toBe(DEFAULT_TARGET_LANE)
  })

  it('never regresses a resolved lane_id back to NULL if lanes later disappear', async () => {
    await seedLanes(t)
    await project(t, [SOURCE, LEGACY_TARGET])
    expect(await laneIdOf(t, 'target', '')).toBe(DEFAULT_TARGET_LANE)

    await t.pg.query(`DELETE FROM lanes WHERE project_id = $1`, [PROJECT])
    await project(t, [ev({ kind: 'target.cell.commit', id: 'tc-3', parentId: 'tc-legacy', payload: { value: 'Coucou' } })])
    expect(await laneIdOf(t, 'target', '')).toBe(DEFAULT_TARGET_LANE) // COALESCE keeps it
  })
})

describe('lane_id resolution — determinism across live and rebuild/replay', () => {
  it('rebuild lands the SAME lane_id the live projection did', async () => {
    await seedLanes(t)
    await insertEventRow(t.db, SOURCE)
    await insertEventRow(t.db, LEGACY_TARGET)
    await insertEventRow(t.db, ES_TARGET)

    await replayViaRebuild(t)

    expect(await laneIdOf(t, 'source', '')).toBe(SOURCE_LANE)
    expect(await laneIdOf(t, 'target', '')).toBe(DEFAULT_TARGET_LANE)
    expect(await laneIdOf(t, 'target', 'es')).toBe(ES_LANE)
  })
})

describe('lane_id resolution — bulk import builders', () => {
  it('buildBulkSourceCellCreateStmt resolves the source lane', async () => {
    await seedLanes(t)
    await buildBulkSourceCellCreateStmt(t.db, [
      ev({ kind: 'source.cell.create', id: 's1', cellId: 'c1', payload: { cellId: 'c1', value: 'a' } }),
      ev({ kind: 'source.cell.create', id: 's2', cellId: 'c2', payload: { cellId: 'c2', value: 'b' } }),
    ]).run()

    const r = await t.pg.query<{ lane_id: string | null }>(
      `SELECT lane_id FROM cells WHERE project_id = $1 AND side = 'source'`,
      [PROJECT],
    )
    expect(r.rows).toHaveLength(2)
    expect(r.rows.every((x) => x.lane_id === SOURCE_LANE)).toBe(true)
  })

  it('buildBulkTargetCellCommitStmt resolves default + named target lanes', async () => {
    await seedLanes(t)
    // Source rows must exist first (target rows share their cell ids).
    await buildBulkSourceCellCreateStmt(t.db, [
      ev({ kind: 'source.cell.create', id: 's1', cellId: 'c1', payload: { cellId: 'c1', value: 'a' } }),
      ev({ kind: 'source.cell.create', id: 's2', cellId: 'c2', payload: { cellId: 'c2', value: 'b' } }),
    ]).run()
    await buildBulkTargetCellCommitStmt(t.db, [
      ev({ kind: 'target.cell.commit', id: 't1', cellId: 'c1', payload: { value: 'x' } }),
      ev({ kind: 'target.cell.commit', id: 't2', cellId: 'c2', payload: { value: 'y', targetLang: 'es' } }),
    ] as PersistedEvent<'target.cell.commit'>[]).run()

    const def = await t.pg.query<{ lane_id: string | null }>(
      `SELECT lane_id FROM cells WHERE project_id = $1 AND side = 'target' AND cell_id = 'c1'`,
      [PROJECT],
    )
    const es = await t.pg.query<{ lane_id: string | null }>(
      `SELECT lane_id FROM cells WHERE project_id = $1 AND side = 'target' AND cell_id = 'c2'`,
      [PROJECT],
    )
    expect(def.rows[0]?.lane_id).toBe(DEFAULT_TARGET_LANE)
    expect(es.rows[0]?.lane_id).toBe(ES_LANE)
  })
})

describe('lane_id resolution — leftover projection writes (slice 7a)', () => {
  it('cell.validate writes lane_id on cell_validators', async () => {
    await seedLanes(t)
    await project(t, [
      SOURCE,
      LEGACY_TARGET,
      ES_TARGET,
      ev({ kind: 'cell.validate', payload: { editEventId: 'tc-legacy' } }),
      ev({
        kind: 'cell.validate',
        id: 'v-es',
        payload: { editEventId: 'tc-es', targetLang: 'es' },
      }),
    ])

    const r = await t.pg.query<{ target_lang: string; lane_id: string | null }>(
      `SELECT target_lang, lane_id FROM cell_validators
        WHERE project_id = $1 ORDER BY target_lang`,
      [PROJECT],
    )
    expect(r.rows).toEqual([
      { target_lang: '', lane_id: DEFAULT_TARGET_LANE },
      { target_lang: 'es', lane_id: ES_LANE },
    ])
  })

  it('progress recompute writes lane_id grouped by target_lang', async () => {
    await seedLanes(t)
    await project(t, [SOURCE, LEGACY_TARGET, ES_TARGET])
    for (const s of fullProgressRecomputeStmts(t.db, PROJECT, FILE, 5000)) await s.run()

    const r = await t.pg.query<{ target_lang: string; lane_id: string | null }>(
      `SELECT DISTINCT target_lang, lane_id FROM file_section_progress
        WHERE project_id = $1 ORDER BY target_lang`,
      [PROJECT],
    )
    expect(r.rows).toEqual([
      { target_lang: '', lane_id: DEFAULT_TARGET_LANE },
      { target_lang: 'es', lane_id: ES_LANE },
    ])
  })
})
