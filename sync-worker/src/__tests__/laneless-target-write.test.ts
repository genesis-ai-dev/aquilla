// AQU-1900: a target.cell.* write that names NO lane is a 422 on a project
// whose target lanes all carry a real tag.
//
// An omitted laneId/targetLang means the former default lane (legacy_tag '').
// A lane-less target write splices the '' bridge INSERT into its own batch, but
// since AQU-1615 that INSERT only adds a row when the project has NO target lane
// at all. On a project created today — every lane tagged — the bridge is never
// minted, `cells.lane_id` resolves NULL, and the whole batch came back as a
// per-event 500 "DB batch failed". authorize() used to wave every lane-less
// target write through on the assumption the bridge would exist; now it does so
// only when the project has no target lane (or already has the '' lane).
//
// Every test turns the PGlite harness's lane-minting trigger OFF
// (db/shared/test-lane-fill.ts). Production has no such trigger, and with it on
// the insert would mint the very '' lane whose absence is the bug.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

// events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { missingLaneReason } from '../../../src/lib/lanes/archived-lane'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const PROJECT = 'proj-1900'
const FILE = 'file-1900'
const CELL = 'cell-1900'
const SOURCE_EVENT = 'evt-1900-source'
const SPANISH = 'lane1900es'
const FRENCH = 'lane1900fr'

interface EventsBody {
  accepted: Array<{ id: string }>
  rejected: Array<{ id: string; status: number; reason: string }>
}

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
     VALUES ('lane1900src', $1, 'source', 'English', NULL, NULL, NULL, 0)`,
    [PROJECT],
  )
}

/** A project as the create flow builds one today: every target lane carries a real tag. */
async function seedTargetLanes(targets: Array<{ id: string; tag: string }>): Promise<void> {
  for (const [index, lane] of targets.entries()) {
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
       VALUES ($1, $2, 'target', $3, NULL, NULL, $3, $4)`,
      [lane.id, PROJECT, lane.tag, index + 1],
    )
  }
}

async function taggedProject(): Promise<void> {
  await seedSourceLane()
  await seedTargetLanes([
    { id: SPANISH, tag: 'Spanish' },
    { id: FRENCH, tag: 'French' },
  ])
}

async function postEvents(events: unknown[]): Promise<EventsBody> {
  const token = await makeTestToken(SECRET, {
    projectId: PROJECT,
    fileId: FILE,
    userId: 1,
    username: 'alice',
    role: 700,
  })
  const res = await handleEventsWriteRequest(
    new Request('https://worker/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    }),
    { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
  )
  expect(res).not.toBeNull()
  expect(res!.status).toBe(200)
  return (await res!.json()) as EventsBody
}

function sourceCreate(): RawEvent<'source.cell.create'> {
  return {
    id: SOURCE_EVENT,
    schemaVersion: 1,
    kind: 'source.cell.create',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    author: 'alice',
    payload: { cellId: CELL, value: 'In the beginning', anchorCellId: null },
    clientTs: 1000,
  }
}

function commit(
  id: string,
  lane: { targetLang?: string; laneId?: string } = {},
): RawEvent<'target.cell.commit'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: SOURCE_EVENT,
    author: 'alice',
    payload: { value: 'En el principio', ...lane },
    clientTs: 1001,
  }
}

function targetCreate(id: string): RawEvent<'target.cell.create'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'target.cell.create',
    projectId: PROJECT,
    fileId: FILE,
    cellId: 'cell-1900-new',
    parentId: null,
    author: 'alice',
    payload: { cellId: 'cell-1900-new', value: 'Al principio', anchorCellId: null },
    clientTs: 1002,
  } as RawEvent<'target.cell.create'>
}

async function targetRows(): Promise<Array<{ value: string; legacy_tag: string }>> {
  const { rows } = await t.pg.query<{ value: string; legacy_tag: string | null }>(
    `SELECT c.value, l.legacy_tag
       FROM cells c JOIN lanes l ON l.project_id = c.project_id AND l.id = c.lane_id
      WHERE c.project_id = $1 AND c.side = 'target'
      ORDER BY l.legacy_tag, c.value`,
    [PROJECT],
  )
  return rows.map((row) => ({ value: row.value, legacy_tag: row.legacy_tag ?? '' }))
}

async function targetLaneTags(): Promise<string[]> {
  const { rows } = await t.pg.query<{ legacy_tag: string | null }>(
    `SELECT legacy_tag FROM lanes WHERE project_id = $1 AND role = 'target' ORDER BY legacy_tag`,
    [PROJECT],
  )
  return rows.map((row) => row.legacy_tag ?? '')
}

async function storedEventIds(): Promise<string[]> {
  const { rows } = await t.pg.query<{ id: string }>(
    `SELECT id FROM events WHERE project_id = $1 ORDER BY id`,
    [PROJECT],
  )
  return rows.map((row) => row.id)
}

describe('AQU-1900 — a lane-less target write on a project with only tagged lanes', () => {
  it('is a 422 naming the missing lane, not a 500 "DB batch failed", and writes nothing', async () => {
    await taggedProject()
    const seeded = await postEvents([sourceCreate()])
    expect(seeded.rejected, JSON.stringify(seeded.rejected)).toEqual([])

    const r = await postEvents([commit('evt-1900-no-lane')])

    expect(r.accepted).toEqual([])
    expect(r.rejected).toEqual([
      { id: 'evt-1900-no-lane', status: 422, reason: missingLaneReason('') },
    ])
    expect(r.rejected[0]!.reason).not.toContain('DB batch failed')
    // Refused before any DB write: no event row, no target row, no bridge lane.
    expect(await storedEventIds()).toEqual([SOURCE_EVENT])
    expect(await targetRows()).toEqual([])
    expect(await targetLaneTags()).toEqual(['French', 'Spanish'])
  })

  it('refuses a lane-less target.cell.create the same way', async () => {
    await taggedProject()

    const r = await postEvents([targetCreate('evt-1900-create')])

    expect(r.accepted).toEqual([])
    expect(r.rejected).toEqual([
      { id: 'evt-1900-create', status: 422, reason: missingLaneReason('') },
    ])
    expect(await storedEventIds()).toEqual([])
    expect(await targetLaneTags()).toEqual(['French', 'Spanish'])
  })

  it('refuses only the lane-less event and still lands its lane-bearing siblings', async () => {
    await taggedProject()

    const r = await postEvents([
      sourceCreate(),
      commit('evt-1900-sibling-no-lane'),
      commit('evt-1900-sibling-es', { targetLang: 'Spanish', laneId: SPANISH }),
    ])

    expect(r.rejected).toEqual([
      { id: 'evt-1900-sibling-no-lane', status: 422, reason: missingLaneReason('') },
    ])
    expect(r.accepted.map((a) => a.id)).toEqual([SOURCE_EVENT, 'evt-1900-sibling-es'])
    expect(await targetRows()).toEqual([{ value: 'En el principio', legacy_tag: 'Spanish' }])
  })

  it('still accepts the same write when it names a lane by id or by tag', async () => {
    await taggedProject()

    const byId = await postEvents([
      sourceCreate(),
      commit('evt-1900-by-id', { laneId: SPANISH }),
    ])
    expect(byId.rejected, JSON.stringify(byId.rejected)).toEqual([])

    const byTag = await postEvents([commit('evt-1900-by-tag', { targetLang: 'French' })])
    expect(byTag.rejected, JSON.stringify(byTag.rejected)).toEqual([])
    expect(byTag.accepted).toEqual([{ id: 'evt-1900-by-tag' }])

    expect(await targetRows()).toEqual([
      { value: 'En el principio', legacy_tag: 'French' },
      { value: 'En el principio', legacy_tag: 'Spanish' },
    ])
  })

  it('still refuses an unknown lane id as before', async () => {
    await taggedProject()

    const r = await postEvents([commit('evt-1900-ghost', { laneId: 'lane1900ghost' })])

    expect(r.accepted).toEqual([])
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]!.status).toBe(422)
    expect(r.rejected[0]!.reason).toContain('unknown lane id')
  })
})

describe('AQU-1900 — lane-less target writes that still resolve', () => {
  it('a project with NO target lane mints the blank bridge and lands the write', async () => {
    await seedSourceLane()

    const r = await postEvents([sourceCreate(), commit('evt-1900-bridge')])

    expect(r.rejected, JSON.stringify(r.rejected)).toEqual([])
    expect(r.accepted.map((a) => a.id)).toEqual([SOURCE_EVENT, 'evt-1900-bridge'])
    expect(await targetLaneTags()).toEqual([''])
    expect(await targetRows()).toEqual([{ value: 'En el principio', legacy_tag: '' }])

    // The bridge now exists, so a later lane-less write on it resolves too.
    const again = await postEvents([
      { ...commit('evt-1900-bridge-2'), parentId: 'evt-1900-bridge', payload: { value: 'Otra vez' } },
    ])
    expect(again.rejected, JSON.stringify(again.rejected)).toEqual([])
    expect(await targetRows()).toEqual([{ value: 'Otra vez', legacy_tag: '' }])
  })

  it('a legacy project that already has the default lane accepts a lane-less write', async () => {
    await seedSourceLane()
    await seedTargetLanes([
      { id: 'lane1900default', tag: '' },
      { id: FRENCH, tag: 'French' },
    ])

    const r = await postEvents([sourceCreate(), commit('evt-1900-legacy')])

    expect(r.rejected, JSON.stringify(r.rejected)).toEqual([])
    expect(await targetRows()).toEqual([{ value: 'En el principio', legacy_tag: '' }])
  })
})
