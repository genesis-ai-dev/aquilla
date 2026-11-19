// AQU-2309: the events route applies milestoneFloor on top of the static
// project-lead floor. A page that has not picked up a raised setting cannot
// write past it, and changing the setting does not touch an existing
// milestone or any cell.

import { describe, it, expect, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const PROJECT = 'proj-ms'
const FILE = 'file-ms'
const MILESTONE = 'ms-0199b0c4'

async function makeToken(role: number, username = 'alice'): Promise<string> {
  return makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role, username } as any)
}

async function makeRequest(events: unknown[], token: string): Promise<Request> {
  return new Request('https://worker/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  })
}

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

async function post(db: AquillaDb, event: RawEvent, token: string) {
  const res = await handleEventsWriteRequest(await makeRequest([event], token), makeEnv(db))
  return (await res!.json()) as { accepted: unknown[]; rejected: { status: number; reason: string }[] }
}

async function seedFile(db: AquillaDb): Promise<void> {
  const owner = await makeToken(700, 'owner')
  const body = await post(db, {
    id: 'evt-ms-file',
    schemaVersion: 1,
    kind: 'file.create',
    projectId: PROJECT,
    fileId: FILE,
    parentId: null,
    author: 'owner',
    payload: { name: 'Milestone Floor', fileType: 'codex' },
    clientTs: 0,
  } as RawEvent<'file.create'>, owner)
  expect(body.rejected, JSON.stringify(body.rejected)).toHaveLength(0)
}

async function setProjectSettings(db: AquillaDb, settings: Record<string, unknown> | null): Promise<void> {
  if (settings == null) return
  await db
    .prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_at)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (project_id)
       DO UPDATE SET settings = excluded.settings, version = project_settings.version + 1`,
    )
    .bind(PROJECT, JSON.stringify(settings))
    .run()
}

function milestoneSet(id: string, author: string, name = 'The storm', endCellId = 'cell-2'): RawEvent<'file.milestone.set'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'file.milestone.set',
    projectId: PROJECT,
    fileId: FILE,
    parentId: null,
    author,
    payload: {
      milestoneId: MILESTONE,
      name,
      startCellId: 'cell-1',
      endCellId,
    },
    clientTs: 1,
  }
}

function milestoneRemove(id: string, author: string): RawEvent<'file.milestone.remove'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'file.milestone.remove',
    projectId: PROJECT,
    fileId: FILE,
    parentId: null,
    author,
    payload: { milestoneId: MILESTONE },
    clientTs: 2,
  }
}

async function milestoneCount(db: AquillaDb): Promise<number> {
  const row = await db
    .prepare('SELECT count(*)::int AS n FROM file_milestones WHERE project_id = ?')
    .bind(PROJECT)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

async function cellCount(db: AquillaDb): Promise<number> {
  const row = await db
    .prepare('SELECT count(*)::int AS n FROM cells WHERE project_id = ?')
    .bind(PROJECT)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

async function storedMilestone(db: AquillaDb) {
  return db
    .prepare(
      `SELECT name, start_cell_id, end_cell_id, event_id
       FROM file_milestones WHERE project_id = ? AND file_id = ? AND milestone_id = ?`,
    )
    .bind(PROJECT, FILE, MILESTONE)
    .first<{ name: string; start_cell_id: string; end_cell_id: string; event_id: string }>()
}

describe('file.milestone — a raised floor rejects a stale project-lead write', () => {
  it.each([
    ['no settings row', null],
    ['an explicit maintainer tier', { milestoneFloor: 'maintainer' }],
    ['a tier this build does not recognise', { milestoneFloor: 'lane_lead' }],
    ['a non-string tier', { milestoneFloor: 500 }],
  ] as const)('%s refuses the lead and writes no milestone', async (_label, settings) => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await setProjectSettings(db, settings)

    const lead = await makeToken(500, 'lead')
    const body = await post(db, milestoneSet('evt-ms-lead-set', 'lead'), lead)
    expect(body.accepted).toHaveLength(0)
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
    expect(body.rejected[0].reason).toMatch(/role too low to set milestones/)
    expect(await milestoneCount(db)).toBe(0)
    expect(await cellCount(db)).toBe(0)
  })

  it('refuses a lead remove the same way', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await setProjectSettings(db, { milestoneFloor: 'maintainer' })
    const maintainer = await makeToken(600, 'maint')
    const created = await post(db, milestoneSet('evt-ms-kept', 'maint'), maintainer)
    expect(created.rejected).toHaveLength(0)

    const lead = await makeToken(500, 'lead')
    const body = await post(db, milestoneRemove('evt-ms-lead-remove', 'lead'), lead)
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
    expect(body.rejected[0].reason).toMatch(/role too low to set milestones/)
    expect(await storedMilestone(db)).toMatchObject({ name: 'The storm', event_id: 'evt-ms-kept' })
  })
})

describe("file.milestone — milestoneFloor = 'project_lead'", () => {
  it('accepts a project lead set and remove', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await setProjectSettings(db, { milestoneFloor: 'project_lead' })
    const lead = await makeToken(500, 'lead')

    const created = await post(db, milestoneSet('evt-ms-open-set', 'lead'), lead)
    expect(created.rejected, JSON.stringify(created.rejected)).toHaveLength(0)
    expect(await storedMilestone(db)).toMatchObject({
      name: 'The storm',
      start_cell_id: 'cell-1',
      end_cell_id: 'cell-2',
      event_id: 'evt-ms-open-set',
    })

    const removed = await post(db, milestoneRemove('evt-ms-open-remove', 'lead'), lead)
    expect(removed.rejected).toHaveLength(0)
    expect(await milestoneCount(db)).toBe(0)
    expect(await cellCount(db)).toBe(0)
  })

  it('still refuses a contributor', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await setProjectSettings(db, { milestoneFloor: 'project_lead' })
    const contributor = await makeToken(400, 'bob')
    const body = await post(db, milestoneSet('evt-ms-contrib', 'bob'), contributor)
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
    expect(await milestoneCount(db)).toBe(0)
  })
})

describe('changing milestoneFloor leaves existing milestones alone', () => {
  it('a stale lead rename or resize does not change the stored row', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await setProjectSettings(db, { milestoneFloor: 'project_lead' })
    const maintainer = await makeToken(600, 'maint')
    const created = await post(db, milestoneSet('evt-ms-original', 'maint'), maintainer)
    expect(created.rejected).toHaveLength(0)
    const before = await storedMilestone(db)

    await setProjectSettings(db, { milestoneFloor: 'maintainer' })
    const lead = await makeToken(500, 'lead')
    const renamed = await post(
      db,
      milestoneSet('evt-ms-stale-rename', 'lead', 'Renamed', 'cell-9'),
      lead,
    )
    expect(renamed.rejected[0]?.status).toBe(403)
    expect(await storedMilestone(db)).toEqual(before)
    expect(await cellCount(db)).toBe(0)
  })

  it('switching the setting either way does not rewrite the milestone or write a cell', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    const maintainer = await makeToken(600, 'maint')
    const created = await post(db, milestoneSet('evt-ms-stable', 'maint'), maintainer)
    expect(created.rejected).toHaveLength(0)
    const before = await storedMilestone(db)
    const eventsBefore = await db
      .prepare(`SELECT count(*)::int AS n FROM events WHERE project_id = ? AND kind LIKE 'file.milestone.%'`)
      .bind(PROJECT)
      .first<{ n: number }>()

    await setProjectSettings(db, { milestoneFloor: 'project_lead' })
    await setProjectSettings(db, { milestoneFloor: 'maintainer' })

    expect(await storedMilestone(db)).toEqual(before)
    expect(await cellCount(db)).toBe(0)
    const eventsAfter = await db
      .prepare(`SELECT count(*)::int AS n FROM events WHERE project_id = ? AND kind LIKE 'file.milestone.%'`)
      .bind(PROJECT)
      .first<{ n: number }>()
    expect(Number(eventsAfter?.n)).toBe(Number(eventsBefore?.n))
  })
})
