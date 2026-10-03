// AQU-1589: a back-translation belongs to one target lane.
//
// lane_id is resolved from the event's targetLang via lanes.legacy_tag
// (absent/'' → the lane whose legacy_tag is ''). Live projection and rebuild
// run that same SQL, so a replay lands the same id.

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import type { EventKind } from '../events/types'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const PROJECT = 'proj-bt-lane'
const FILE = 'file-1'
const CELL = 'cell-1'
const SECRET = 'bt-lane-secret'

const DEFAULT_LANE = 'lane-default'
const ES_LANE = 'lane-es'
const FR_LANE = 'lane-fr'

let seq = 0
function ev(partial: Partial<PersistedEvent> & { kind: EventKind }): PersistedEvent {
  seq += 1
  return {
    id: partial.id ?? `e${seq}`,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    author: 'alice',
    payload: {},
    clientTs: 1000 + seq,
    serverTs: 1000 + seq,
    serverSeq: seq,
    ...partial,
  }
}

async function seedLanes(t: TestDb): Promise<void> {
  await t.pg.query(
    `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag) VALUES
       ($1, $4, 'target', 'Default', NULL, ''),
       ($2, $4, 'target', 'Spanish', 'es', 'es'),
       ($3, $4, 'target', 'French', 'fr', 'fr')`,
    [DEFAULT_LANE, ES_LANE, FR_LANE, PROJECT],
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

async function project(t: TestDb, events: PersistedEvent[]): Promise<void> {
  const stmts: AquillaStatement[] = []
  for (const e of events) buildEventProjectionStmts(t.db, e, stmts, { deferFileCounters: true })
  for (const s of stmts) await s.run()
}

async function laneIds(t: TestDb): Promise<Array<{ target_event_id: string; lane_id: string | null }>> {
  const r = await t.pg.query<{ target_event_id: string; lane_id: string | null }>(
    `SELECT target_event_id, lane_id FROM cell_backtranslations
      WHERE project_id = $1
      ORDER BY target_event_id`,
    [PROJECT],
  )
  return r.rows
}

const DEFAULT_BT = ev({
  kind: 'cell.backtranslation.set',
  id: 'bt-default',
  payload: { btText: 'in the beginning', targetEventId: 'tc-default', polished: false },
})
const ES_BT = ev({
  kind: 'cell.backtranslation.set',
  id: 'bt-es',
  serverTs: 2000,
  payload: { btText: 'en el principio', targetEventId: 'tc-es', polished: false, targetLang: 'es' },
})
const FR_BT = ev({
  kind: 'cell.backtranslation.set',
  id: 'bt-fr',
  serverTs: 3000,
  payload: { btText: 'au commencement', targetEventId: 'tc-fr', polished: true, targetLang: 'fr' },
})

let t: TestDb
beforeEach(async () => {
  if (!t) t = await makeTestDb()
  else await t.reset()
  seq = 0
})
afterAll(async () => {
  await t?.close()
})

describe('cell.backtranslation.set writes lane_id', () => {
  it('resolves each lane from legacy_tag, and leaves lane_id NULL when the lane is missing', async () => {
    await project(t, [ES_BT])
    expect(await laneIds(t)).toEqual([{ target_event_id: 'tc-es', lane_id: null }])

    await t.reset()
    await seedLanes(t)
    await project(t, [DEFAULT_BT, ES_BT, FR_BT])
    expect(await laneIds(t)).toEqual([
      { target_event_id: 'tc-default', lane_id: DEFAULT_LANE },
      { target_event_id: 'tc-es', lane_id: ES_LANE },
      { target_event_id: 'tc-fr', lane_id: FR_LANE },
    ])
  })

  it('does not replace a resolved lane_id with NULL when the lane later cannot be resolved', async () => {
    await seedLanes(t)
    await project(t, [ES_BT])
    // The row still points at the lane; the tag no longer resolves, so the
    // upsert's lane_id subquery is NULL and must not wipe the stored id.
    await t.pg.query(
      `UPDATE lanes SET legacy_tag = 'es-retired' WHERE project_id = $1 AND id = $2`,
      [PROJECT, ES_LANE],
    )
    await project(t, [ev({
      kind: 'cell.backtranslation.set',
      id: 'bt-es-2',
      payload: { btText: 'al principio', targetEventId: 'tc-es', polished: false, targetLang: 'es' },
    })])
    expect(await laneIds(t)).toEqual([{ target_event_id: 'tc-es', lane_id: ES_LANE }])
  })
})

describe('lane_id resolution — live projection and rebuild', () => {
  it('rebuild lands the same lane_id the live projection did', async () => {
    await seedLanes(t)
    for (const e of [DEFAULT_BT, ES_BT, FR_BT]) await insertEventRow(t.db, e)
    await project(t, [DEFAULT_BT, ES_BT, FR_BT])
    const live = await laneIds(t)

    await t.pg.query(`DELETE FROM cell_backtranslations WHERE project_id = $1`, [PROJECT])
    const res = await handleRebuildProjectionRequest(
      new Request(`https://worker/admin/projects/${PROJECT}/rebuild-projection`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
    )
    expect(res?.status).toBe(200)
    expect(await laneIds(t)).toEqual(live)
  })
})
