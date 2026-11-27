// AQU-2777: an import whose targets name NO lane, on a project whose one target
// lane carries a real language.
//
// An omitted targetLang means the former default lane (legacy_tag ''). The ''
// bridge spliced into the import batch mints that lane only on a project with
// NO target lane at all (AQU-1615), so on a project created by picking a target
// language at creation nothing resolved `cells.lane_id`: the NOT NULL column
// rejected the whole chunk and POST /import answered 500 "DB batch failed",
// which the import dialog then retried (the SDBH localized-edition repro).
// AQU-2554 fixed the source side of that import; this is the target side, the
// same family as AQU-1900 (the /events answer) and AQU-1902 (resolve the lane
// before the event is stored).
//
// Every test turns the PGlite harness's lane-minting trigger OFF
// (db/shared/test-lane-fill.ts). Production has no such trigger, and with it on
// the insert would mint the very '' lane whose absence is the bug.

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { handleBulkImportRequest } from '../events/import-route'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'test-secret'
const PROJECT = 'proj-2777'
const FILE = 'file-2777'
const CELL = 'SDBH-aleph'
const SOURCE_EVENT = 'evt-2777-source'
const TARGET_EVENT = 'evt-2777-target'

let t: TestDb
beforeEach(async () => {
  if (!t) t = await makeTestDb()
  else await t.reset()
  // Production mints no lane on insert; neither does this suite.
  await t.pg.query(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
})
afterAll(async () => {
  await t?.close()
})

async function seedSourceLane(): Promise<void> {
  await t.pg.query(
    `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
     VALUES ('lane2777src', $1, 'source', 'Hebrew', NULL, NULL, NULL, 0)`,
    [PROJECT],
  )
}

/** Target lanes exactly as the create flow builds them: every lane a real tag. */
async function seedTargetLanes(
  lanes: Array<{ id: string; tag: string; archived?: boolean }>,
): Promise<void> {
  for (const [index, lane] of lanes.entries()) {
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position, archived_at)
       VALUES ($1, $2, 'target', $3, NULL, NULL, $3, $4, $5)`,
      [lane.id, PROJECT, lane.tag, index + 1, lane.archived ? new Date().toISOString() : null],
    )
  }
}

/** The legacy shape: the project still carries the '' default lane. */
async function seedBlankTargetLane(): Promise<void> {
  await t.pg.query(
    `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
     VALUES ('lane2777blank', $1, 'target', '', NULL, NULL, '', 9)`,
    [PROJECT],
  )
}

/** One SDBH-shaped chunk: a source cell plus its pre-filled target. */
function chunk(target: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: PROJECT,
    fileId: FILE,
    file: {
      id: 'evt-2777-file',
      name: 'SDBH-es.JSON',
      fileType: 'json',
      kind: 'json',
      role: 'source',
      orderedBy: 'sequence',
      sourceLanguage: 'Hebrew',
    },
    cells: [{ id: SOURCE_EVENT, cellId: CELL, value: 'אָb' }],
    targets: [
      {
        id: TARGET_EVENT,
        cellId: CELL,
        parentId: SOURCE_EVENT,
        value: 'alef',
        ...target,
      },
    ],
  }
}

async function post(body: Record<string, unknown>): Promise<Response> {
  const token = await makeTestToken(SECRET, {
    projectId: PROJECT,
    fileId: FILE,
    userId: 1,
    username: 'alice',
    role: 700,
  })
  const response = await handleBulkImportRequest(
    new Request('https://worker/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
  )
  expect(response).not.toBeNull()
  return response!
}

/** Each target cell row with the legacy tag of the lane it actually landed in. */
async function targetLaneTags(): Promise<Array<{ cell_id: string; legacy_tag: string | null }>> {
  const rows = await t.pg.query<{ cell_id: string; legacy_tag: string | null }>(
    `SELECT c.cell_id, l.legacy_tag
       FROM cells c JOIN lanes l ON l.id = c.lane_id
      WHERE c.project_id = $1 AND l.role = 'target'
      ORDER BY c.cell_id`,
    [PROJECT],
  )
  return rows.rows
}

async function storedTargetPayload(): Promise<Record<string, unknown> | null> {
  const rows = await t.pg.query<{ payload: string | Record<string, unknown> }>(
    `SELECT payload FROM events WHERE id = $1`,
    [TARGET_EVENT],
  )
  const payload = rows.rows[0]?.payload
  if (payload === undefined) return null
  return typeof payload === 'string' ? JSON.parse(payload) : payload
}

describe('AQU-2777 — an import target that names no lane', () => {
  it('lands in the project\'s one target language, and the stored event records it', async () => {
    await seedSourceLane()
    await seedTargetLanes([{ id: 'lane2777es', tag: 'Spanish' }])

    const response = await post(chunk())

    expect(response.status).toBe(200)
    expect(await targetLaneTags()).toEqual([{ cell_id: CELL, legacy_tag: 'Spanish' }])
    // Resolved BEFORE the event was stored, so a replay lands in the same lane.
    expect(await storedTargetPayload()).toMatchObject({ targetLang: 'Spanish' })
    // No '' lane minted beside the real language.
    const lanes = await t.pg.query<{ legacy_tag: string | null }>(
      `SELECT legacy_tag FROM lanes WHERE project_id = $1 AND role = 'target'`,
      [PROJECT],
    )
    expect(lanes.rows.map((lane) => lane.legacy_tag)).toEqual(['Spanish'])
  })

  it('refuses with 422, not a retryable 500, when the project has more than one target language', async () => {
    await seedSourceLane()
    await seedTargetLanes([
      { id: 'lane2777es', tag: 'Spanish' },
      { id: 'lane2777fr', tag: 'French' },
    ])

    const response = await post(chunk())

    // 422 is NOT in the client's isRetryableImportStatus (src/lib/sync/bulk-import.ts
    // retries 408/425/429/5xx), so the dialog reports it instead of looping.
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: string; lanes: string[] }
    expect(body.error).toContain('more than one')
    expect(body.lanes.sort()).toEqual(['French', 'Spanish'])
    // Nothing written.
    expect(await t.rows('events')).toHaveLength(0)
    expect(await t.rows('cells')).toHaveLength(0)
  })

  it('refuses with 422 when the only target language is archived', async () => {
    await seedSourceLane()
    await seedTargetLanes([{ id: 'lane2777es', tag: 'Spanish', archived: true }])

    const response = await post(chunk())

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('no target language')
    expect(await t.rows('events')).toHaveLength(0)
  })

  it('leaves a target that names its own lane alone, even with several languages', async () => {
    await seedSourceLane()
    await seedTargetLanes([
      { id: 'lane2777es', tag: 'Spanish' },
      { id: 'lane2777fr', tag: 'French' },
    ])

    const response = await post(chunk({ targetLang: 'French' }))

    expect(response.status).toBe(200)
    expect(await targetLaneTags()).toEqual([{ cell_id: CELL, legacy_tag: 'French' }])
    expect(await storedTargetPayload()).toMatchObject({ targetLang: 'French' })
  })

  it('still mints the bridge on a project with no target lane at all', async () => {
    await seedSourceLane()

    const response = await post(chunk())

    expect(response.status).toBe(200)
    expect(await targetLaneTags()).toEqual([{ cell_id: CELL, legacy_tag: '' }])
  })

  it('still prefers the \'\' lane on a legacy project that has one', async () => {
    await seedSourceLane()
    await seedBlankTargetLane()
    await seedTargetLanes([{ id: 'lane2777es', tag: 'Spanish' }])

    const response = await post(chunk())

    expect(response.status).toBe(200)
    expect(await targetLaneTags()).toEqual([{ cell_id: CELL, legacy_tag: '' }])
  })
})
