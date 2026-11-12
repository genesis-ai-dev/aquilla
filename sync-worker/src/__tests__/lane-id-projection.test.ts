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
//   3. Once lane_id is NOT NULL, a write with no matching lane is rejected.
//      The old "stay NULL until backfill" path is gone.

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildBulkSourceCellCreateStmt,
  buildBulkTargetCellCommitStmt,
  buildEventProjectionStmts,
  type PersistedEvent,
} from '../events/event-projection'
import { fullProgressRecomputeStmts } from '../events/progress-projection'
import { laneIdResolveBindingBinds, laneIdResolveBindingSql } from '../events/lane-id-sql'
import type { EventKind } from '../events/types'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import { handleCellEvent } from '../events/handlers/cell-events'
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

/** Seed the three lanes the tests resolve against. */
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
    `SELECT c.lane_id FROM cells c
       JOIN lanes l ON l.project_id = c.project_id AND l.id = c.lane_id
      WHERE c.project_id = $1 AND c.file_id = $2 AND c.side = $3
        AND (
          ($3 = 'source' AND l.role = 'source')
          OR ($3 = 'target' AND l.role = 'target' AND l.legacy_tag IS NOT DISTINCT FROM $4)
        )`,
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

  it('rejects a cell write when the project has no lanes (lane_id is NOT NULL)', async () => {
    await t.pg.query(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
    await expect(project(t, [SOURCE, LEGACY_TARGET])).rejects.toThrow(/not-null constraint/i)
    expect(await laneIdOf(t, 'target', '')).toBeNull()
  })

  it('the composite FK forbids orphaning a resolved lane_id, and COALESCE guards NULL-writes', async () => {
    await seedLanes(t)
    await project(t, [SOURCE, LEGACY_TARGET])
    expect(await laneIdOf(t, 'target', '')).toBe(DEFAULT_TARGET_LANE)

    // Slice 8: with cells_lane_id_fkey in place, a lane can no longer "disappear"
    // out from under the rows that resolved it — the FK rejects the delete. This
    // is strictly stronger than the COALESCE guard the pre-FK test relied on.
    await expect(
      t.pg.query(`DELETE FROM lanes WHERE project_id = $1`, [PROJECT]),
    ).rejects.toThrow(/foreign key constraint/i)
    expect(await laneIdOf(t, 'target', '')).toBe(DEFAULT_TARGET_LANE)

    // A raw NULL lane_id is rejected outright (the column is NOT NULL), so the
    // already-resolved id cannot be wiped. Turn the test-only filler off so
    // this sees the production constraint.
    await t.pg.query(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
    await expect(
      t.pg.query(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_editor, last_edit_at, validated, word_count, content_hash, lane_id) VALUES ($1, $2, 'cell-1', 'target', 'Coucou', 'tc-raw', 'alice', 1, 0, 1, 'h', NULL)
         ON CONFLICT (project_id, file_id, cell_id, lane_id) DO UPDATE SET
           value   = excluded.value,
           lane_id = COALESCE(excluded.lane_id, cells.lane_id)`,
        [PROJECT, FILE],
      ),
    ).rejects.toThrow(/not-null constraint/i)
    expect(await laneIdOf(t, 'target', '')).toBe(DEFAULT_TARGET_LANE)
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

    const r = await t.pg.query<{ lane_id: string | null }>(
      `SELECT lane_id FROM cell_validators
        WHERE project_id = $1 ORDER BY lane_id`,
      [PROJECT],
    )
    // The projection column is gone. The lane id is the identity.
    expect(r.rows).toEqual([
      { lane_id: DEFAULT_TARGET_LANE },
      { lane_id: ES_LANE },
    ])
  })

  it('progress recompute writes a row per lane, keyed by lane_id', async () => {
    await seedLanes(t)
    await project(t, [SOURCE, LEGACY_TARGET, ES_TARGET])
    for (const s of fullProgressRecomputeStmts(t.db, PROJECT, FILE, 5000)) await s.run()

    const r = await t.pg.query<{ lane_id: string | null }>(
      `SELECT DISTINCT lane_id FROM file_section_progress
        WHERE project_id = $1 ORDER BY lane_id`,
      [PROJECT],
    )
    // AQU-1599: one row set per row of `lanes`, the SOURCE lane included — it
    // carries the lane-independent numbers. Identity is lane_id; the
    // projection target_lang column was dropped in 0155.
    expect(r.rows).toEqual([
      { lane_id: SOURCE_LANE },
      { lane_id: DEFAULT_TARGET_LANE },
      { lane_id: ES_LANE },
    ])
  })
})

describe('lane_id resolution — artifact_bindings resolver (slice 8)', () => {
  async function resolveBinding(role: string, tag: string): Promise<string | null> {
    const row = await t.db
      .prepare(`SELECT ${laneIdResolveBindingSql()} AS id`)
      .bind(...laneIdResolveBindingBinds(PROJECT, role, tag))
      .first<{ id: string | null }>()
    return row?.id ?? null
  }

  it('source role -> source lane; support/target role -> target lane by tag', async () => {
    await seedLanes(t)
    // A 'source' binding ignores target_lang and lands on the source lane.
    expect(await resolveBinding('source', '')).toBe(SOURCE_LANE)
    expect(await resolveBinding('source', 'es')).toBe(SOURCE_LANE)
    // Non-source roles resolve the target lane whose legacy_tag matches.
    expect(await resolveBinding('target', 'es')).toBe(ES_LANE)
    expect(await resolveBinding('support', '')).toBe(DEFAULT_TARGET_LANE)
    // No matching lane -> NULL (behavior-neutral until the lane exists).
    expect(await resolveBinding('target', 'zz')).toBeNull()
  })
})

describe('lane_id composite FK (slice 8)', () => {
  it('rejects a cells row whose (project_id, lane_id) has no lanes match', async () => {
    await seedLanes(t)
    await expect(
      t.pg.query(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_editor, last_edit_at, validated, word_count, content_hash, lane_id) VALUES ($1, $2, 'ghost', 'target', 'x', 'e-ghost', 'alice', 1, 0, 1, 'h', 'no-such-lane')`,
        [PROJECT, FILE],
      ),
    ).rejects.toThrow(/foreign key constraint/i)
  })
})

describe('default target write creates the blank bridge (AQU-1594)', () => {
  const CLAIMS = { username: 'alice', userId: 1, role: 600, projectId: PROJECT, fileId: FILE }
  let serverSeq = 0

  function commit(
    id: string,
    opts: { targetLang?: string; parentId?: string | null } = {},
  ) {
    return {
      event: {
        id,
        schemaVersion: 1 as const,
        kind: 'target.cell.commit' as const,
        projectId: PROJECT,
        fileId: FILE,
        cellId: 'cell-1',
        parentId: opts.parentId ?? null,
        payload:
          opts.targetLang === undefined
            ? { value: 'Bonjour' }
            : { value: 'Hola', targetLang: opts.targetLang },
        clientTs: 1,
      },
      claims: CLAIMS,
    } as never
  }

  async function write(id: string, opts: { targetLang?: string; parentId?: string | null } = {}) {
    await t.pg.query(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
    serverSeq += 1
    const result = handleCellEvent(t.db, commit(id, opts), 5_000, {
      serverSeq,
      updateProjection: true,
      deferFileCounters: true,
    })
    await t.db.batch(result.stmts)
  }

  async function targetLanes() {
    return t.pg.query<{ id: string; legacy_tag: string | null; language: string | null }>(
      `SELECT id, legacy_tag, language FROM lanes
        WHERE project_id = $1 AND role = 'target'
        ORDER BY legacy_tag`,
      [PROJECT],
    )
  }

  it('creates one blank lane on a default commit, and a second commit does not add another', async () => {
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag)
       VALUES ('src00001', $1, 'source', 'en', NULL)`,
      [PROJECT],
    )
    await write('tc-1')
    const created = await targetLanes()
    expect(created.rows).toHaveLength(1)
    expect(created.rows[0]?.legacy_tag).toBe('')
    expect(await laneIdOf(t, 'target', '')).toBe(created.rows[0]?.id)

    await write('tc-2', { parentId: 'tc-1' })
    const again = await targetLanes()
    expect(again.rows).toEqual(created.rows)
  })

  it('does not create a blank lane when the write names an existing tagged lane', async () => {
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag) VALUES
         ('src00001', $1, 'source', 'en', NULL),
         ('swlane01', $1, 'target', 'sw', 'sw')`,
      [PROJECT],
    )
    await write('tc-sw', { targetLang: 'sw' })
    const lanes = await targetLanes()
    expect(lanes.rows.map((row) => row.legacy_tag)).toEqual(['sw'])
    expect(await laneIdOf(t, 'target', 'sw')).toBe('swlane01')
  })

  it('does not insert a blank lane when a tagged target lane already exists', async () => {
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag) VALUES
         ('src00001', $1, 'source', 'en', NULL),
         ('swlane01', $1, 'target', 'sw', 'sw')`,
      [PROJECT],
    )
    await expect(write('tc-sw-default')).rejects.toThrow(/not-null constraint/i)
    const lanes = await targetLanes()
    expect(lanes.rows.map((row) => row.legacy_tag)).toEqual(['sw'])
    const cells = await t.pg.query(
      `SELECT cell_id FROM cells WHERE project_id = $1 AND side = 'target'`,
      [PROJECT],
    )
    expect(cells.rows).toEqual([])
  })

  it('keeps an existing blank lane, including its tag and language', async () => {
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag) VALUES
         ('src00001', $1, 'source', 'en', NULL),
         ('keepme01', $1, 'target', 'Spanish', '')`,
      [PROJECT],
    )
    await write('tc-keep')
    const lanes = await targetLanes()
    expect(lanes.rows).toEqual([{ id: 'keepme01', legacy_tag: '', language: 'Spanish' }])
    expect(await laneIdOf(t, 'target', '')).toBe('keepme01')
  })
})
