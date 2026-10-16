// PRE-AQU-1240 characterization baseline — pins §2.5: replay reintroduces `''`
// for historical lane-less target commits. UPDATE (do not silently delete) when
// `''` is eliminated for target rows (AQU-1240 slice 0).

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  buildEventProjectionStmts,
  laneOfEvent,
  type PersistedEvent,
} from '../events/event-projection'
import type { EventKind } from '../events/types'
import { foldProjection, type FoldEvent } from '../../../scripts/lib/fold-projection'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const PROJECT = 'proj-replay-baseline'
const FILE = 'file-1'
const CELL = 'cell-1'
const SECRET = 'test-secret'

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

async function insertEventRow(db: AquillaDb, e: PersistedEvent): Promise<void> {
  await db
    .prepare(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      e.id,
      e.schemaVersion,
      e.projectId,
      e.fileId,
      e.cellId,
      e.parentId ?? null,
      e.kind,
      e.author,
      JSON.stringify(e.payload),
      e.clientTs,
      e.serverTs,
      e.serverSeq ?? 0,
    )
    .run()
}

async function replayViaRebuild(t: TestDb): Promise<void> {
  const req = new Request(`https://worker/admin/projects/${PROJECT}/rebuild-projection`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
  })
  const res = await handleRebuildProjectionRequest(req, {
    AQUILLA_PG: t.db,
    SYNC_SECRET_KEY: SECRET,
  })
  expect(res).not.toBeNull()
  expect(res!.status).toBe(200)
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

describe('replay reintroduces "" for lane-less target commits (§2.5)', () => {
  const source = ev({
    kind: 'source.cell.create',
    id: 'src-1',
    payload: { cellId: CELL, value: 'Hello' },
  })
  const legacyTarget = ev({
    kind: 'target.cell.commit',
    id: 'tc-legacy',
    parentId: 'src-1',
    payload: { value: 'Bonjour' },
  })

  it('laneOfEvent maps the historical commit to "" before replay', () => {
    expect(laneOfEvent(legacyTarget.kind, legacyTarget.payload)).toBe('')
  })

  it('rebuild.ts replay lands a lane-less commit on the default lane', async () => {
    await insertEventRow(t.db, source)
    await insertEventRow(t.db, legacyTarget)

    await replayViaRebuild(t)

    const row = await t.pg.query<{ legacy_tag: string; value: string; event_id: string }>(
      `SELECT COALESCE(l.legacy_tag, '') AS legacy_tag, c.value, c.event_id
         FROM cells c
         JOIN lanes l ON l.project_id = c.project_id AND l.id = c.lane_id
       WHERE c.project_id = $1 AND c.file_id = $2 AND c.cell_id = $3 AND c.side = 'target'`,
      [PROJECT, FILE, CELL],
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0]?.legacy_tag).toBe('')
    expect(row.rows[0]?.value).toBe('Bonjour')
    expect(row.rows[0]?.event_id).toBe('tc-legacy')
  })

  it('fold-projection does not carry a projection target_lang for a lane-less commit', async () => {
    const events = [source, legacyTarget]
    const foldRows = foldProjection(
      events.map(
        (e): FoldEvent => ({
          id: e.id,
          projectId: e.projectId,
          fileId: e.fileId,
          cellId: e.cellId,
          parentId: e.parentId,
          kind: e.kind,
          author: e.author,
          payload: e.payload as Record<string, unknown>,
          serverTs: e.serverTs,
          serverSeq: e.serverSeq!,
        }),
      ),
    )
    const targetRows = foldRows.cells.filter((r) => r.side === 'target')
    expect(targetRows).toHaveLength(1)
    expect(targetRows[0]?.target_lang).toBeUndefined()
    expect(targetRows[0]?.value).toBe('Bonjour')
  })

  it('canonical per-event projection lands a lane-less commit on the default lane', async () => {
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(t.db, source, stmts, { deferFileCounters: true })
    buildEventProjectionStmts(t.db, legacyTarget, stmts, { deferFileCounters: true })
    for (const s of stmts) await s.run()

    const row = await t.pg.query<{ legacy_tag: string }>(
      `SELECT COALESCE(l.legacy_tag, '') AS legacy_tag FROM cells c
         JOIN lanes l ON l.project_id = c.project_id AND l.id = c.lane_id
       WHERE c.project_id = $1 AND c.side = 'target' AND c.cell_id = $2`,
      [PROJECT, CELL],
    )
    expect(row.rows[0]?.legacy_tag).toBe('')
  })
})
