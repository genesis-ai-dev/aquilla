// AQU-1884: a cell.validate / cell.unvalidate that names NO lane is a 4xx.
//
// The lane a validation addresses comes from the event's `targetLang`/`laneId`.
// An omitted pair means the former default lane — the one whose `legacy_tag` is
// `''`. Projects created today have no such lane: every lane gets a real tag,
// such as its language. There the lane cannot resolve, `cell_validators.lane_id`
// is NOT NULL, and the whole batch used to come back as a per-event
// 500 "DB batch failed" — indistinguishable from a real outage. A missing lane
// is the caller's mistake, so it is refused up front with a reason naming it.
//
// Every test here turns the PGlite harness's lane-minting trigger OFF
// (db/shared/test-lane-fill.ts). Production has no such trigger, and with it on
// the insert would mint the very `''` lane whose absence is the bug.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'

// events/route.ts → broadcast.ts → partyserver (cloudflare:*).
import { vi } from 'vitest'
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const PROJECT = 'proj-1884'
const FILE = 'file-1884'
const CELL = 'cell-1884'
const SOURCE_EVENT = 'evt-1884-source'
const COMMIT_EVENT = 'evt-1884-commit'
const SPANISH = 'lane1884es'
const FRENCH = 'lane1884fr'

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

/** A project as the create flow builds one today: every lane carries a real tag. */
async function seedLanes(targets: Array<{ id: string; tag: string }>): Promise<void> {
  await t.pg.query(
    `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
     VALUES ('lane1884src', $1, 'source', 'English', NULL, NULL, NULL, 0)`,
    [PROJECT],
  )
  for (const [index, lane] of targets.entries()) {
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
       VALUES ($1, $2, 'target', $3, NULL, NULL, $3, $4)`,
      [lane.id, PROJECT, lane.tag, index + 1],
    )
  }
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

function commit(lane: { targetLang?: string; laneId?: string }): RawEvent<'target.cell.commit'> {
  return {
    id: COMMIT_EVENT,
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

function validate(
  id: string,
  kind: 'cell.validate' | 'cell.unvalidate',
  lane: { targetLang?: string; laneId?: string } = {},
): RawEvent<'cell.validate'> {
  return {
    id,
    schemaVersion: 1,
    kind,
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    author: 'alice',
    payload: { editEventId: COMMIT_EVENT, ...lane },
    clientTs: 1002,
  } as RawEvent<'cell.validate'>
}

async function validatorTags(): Promise<string[]> {
  const { rows } = await t.pg.query<{ legacy_tag: string | null }>(
    `SELECT l.legacy_tag
       FROM cell_validators v
       JOIN lanes l ON l.project_id = v.project_id AND l.id = v.lane_id
      WHERE v.project_id = $1
      ORDER BY l.legacy_tag`,
    [PROJECT],
  )
  return rows.map((row) => row.legacy_tag ?? '')
}

/** A translated cell in the Spanish lane, ready to validate. */
async function translatedCell(): Promise<void> {
  await seedLanes([
    { id: SPANISH, tag: 'Spanish' },
    { id: FRENCH, tag: 'French' },
  ])
  const written = await postEvents([
    sourceCreate(),
    commit({ targetLang: 'Spanish', laneId: SPANISH }),
  ])
  expect(written.rejected, JSON.stringify(written.rejected)).toEqual([])
}

describe('AQU-1884 — a lane-less validate on a project with no default lane', () => {
  it('is a 4xx naming the missing lane, not a 500 "DB batch failed"', async () => {
    await translatedCell()

    const r = await postEvents([validate('evt-1884-no-lane', 'cell.validate')])

    expect(r.accepted).toEqual([])
    expect(r.rejected).toHaveLength(1)
    const [refusal] = r.rejected
    expect(refusal!.status).toBeGreaterThanOrEqual(400)
    expect(refusal!.status).toBeLessThan(500)
    expect(refusal!.reason).not.toContain('DB batch failed')
    expect(refusal!.reason).toContain('no default lane')
    // The rejected event changed no validation state anywhere.
    expect(await validatorTags()).toEqual([])
  })

  it('still accepts the same validate once it names the lane', async () => {
    await translatedCell()

    const r = await postEvents([
      validate('evt-1884-with-lane', 'cell.validate', {
        targetLang: 'Spanish',
        laneId: SPANISH,
      }),
    ])

    expect(r.rejected).toEqual([])
    expect(r.accepted).toEqual([{ id: 'evt-1884-with-lane' }])
    // Only the Spanish lane — the French lane is untouched.
    expect(await validatorTags()).toEqual(['Spanish'])
  })

  it('refuses a lane-less unvalidate instead of silently matching nothing', async () => {
    await translatedCell()
    const validated = await postEvents([
      validate('evt-1884-pre', 'cell.validate', { targetLang: 'Spanish', laneId: SPANISH }),
    ])
    expect(validated.rejected).toEqual([])

    const r = await postEvents([validate('evt-1884-unval', 'cell.unvalidate')])

    expect(r.accepted).toEqual([])
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]!.status).toBeGreaterThanOrEqual(400)
    expect(r.rejected[0]!.status).toBeLessThan(500)
    expect(r.rejected[0]!.reason).toContain('no default lane')
    // The standing validation survives the refusal.
    expect(await validatorTags()).toEqual(['Spanish'])
  })

  it('refuses a validate naming a lane id the project does not have', async () => {
    await translatedCell()

    const r = await postEvents([
      validate('evt-1884-ghost', 'cell.validate', { laneId: 'lane1884ghost' }),
    ])

    expect(r.accepted).toEqual([])
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]!.status).toBeGreaterThanOrEqual(400)
    expect(r.rejected[0]!.status).toBeLessThan(500)
    expect(r.rejected[0]!.reason).toContain('unknown lane id')
    expect(await validatorTags()).toEqual([])
  })

  it('still lets a legacy project with a default lane validate without naming one', async () => {
    await seedLanes([{ id: 'lane1884default', tag: '' }])
    const written = await postEvents([
      sourceCreate(),
      commit({ targetLang: '', laneId: 'lane1884default' }),
    ])
    expect(written.rejected, JSON.stringify(written.rejected)).toEqual([])

    const r = await postEvents([validate('evt-1884-legacy', 'cell.validate')])

    expect(r.rejected).toEqual([])
    expect(r.accepted).toEqual([{ id: 'evt-1884-legacy' }])
    expect(await validatorTags()).toEqual([''])
  })
})
