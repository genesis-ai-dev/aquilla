// AQU-2647: POST /events refuses a source edit the project's sourceTextFloor
// does not allow. The static floor is Contributor; the tier (default
// Maintainer) is what decides. Hide uses the same tier.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'
import { BIBLICA_ETT_ORG_NAME } from '../../../db/shared/source-text-floor'

const SECRET = 'test-secret'
const PROJECT = 'proj-st'
const FILE = 'file-st'

async function token(
  role: number,
  extra: { userId?: number; username?: string; laneGrants?: Array<{ lane: string; level: number }> | null } = {},
): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: PROJECT,
    fileId: FILE,
    role,
    userId: extra.userId ?? 1,
    username: extra.username ?? 'alice',
    ...(extra.laneGrants ? { laneGrants: extra.laneGrants } : {}),
  })
}

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

async function post(db: AquillaDb, event: RawEvent, bearer: string) {
  const res = await handleEventsWriteRequest(
    new Request('https://worker/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ events: [event] }),
    }),
    makeEnv(db),
  )
  return (await res!.json()) as { accepted: unknown[]; rejected: { status: number; reason: string }[] }
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

async function seedSource(db: AquillaDb): Promise<void> {
  const owner = await token(700, { username: 'owner' })
  const file = await post(db, {
    id: 'evt-st-file',
    schemaVersion: 1,
    kind: 'file.create',
    projectId: PROJECT,
    fileId: FILE,
    parentId: null,
    author: 'owner',
    payload: { name: 'Source floor', fileType: 'codex' },
    clientTs: 0,
  } as RawEvent<'file.create'>, owner)
  expect(file.rejected, JSON.stringify(file.rejected)).toEqual([])
  const created = await post(db, {
    id: 'evt-st-src',
    schemaVersion: 1,
    kind: 'source.cell.create',
    projectId: PROJECT,
    fileId: FILE,
    cellId: 'cell-1',
    parentId: null,
    author: 'owner',
    payload: { cellId: 'cell-1', value: 'In the beginning' },
    clientTs: 1,
  } as RawEvent<'source.cell.create'>, owner)
  expect(created.rejected, JSON.stringify(created.rejected)).toEqual([])
}

function sourceCommit(id: string, parentId = 'evt-st-src', value = 'In the beginning God'): RawEvent<'source.cell.commit'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'source.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId: 'cell-1',
    parentId,
    author: 'alice',
    payload: { value },
    clientTs: 2,
  }
}

function hide(id: string): RawEvent<'source.cell.visibility.set'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'source.cell.visibility.set',
    projectId: PROJECT,
    fileId: FILE,
    cellId: 'cell-1',
    parentId: null,
    author: 'alice',
    payload: { hidden: true },
    clientTs: 3,
  }
}

async function sourceValue(db: AquillaDb): Promise<string | undefined> {
  const row = await db
    .prepare(`SELECT value FROM cells WHERE project_id = ? AND cell_id = ? AND side = 'source'`)
    .bind(PROJECT, 'cell-1')
    .first<{ value: string }>()
  return row?.value
}

describe('source text floor — the server refuses the event (AQU-2647)', () => {
  // One database for the file. Loading the schema five times blows the
  // 30s watchdog when the machine is busy, and these tests only need a
  // clean project between them.
  let db: AquillaDb
  let reset: () => Promise<void>
  let close: () => Promise<void>

  beforeAll(async () => {
    const t = await makeTestDb()
    db = t.db
    reset = t.reset
    close = () => t.pg.close()
  }, 120_000)

  beforeEach(async () => {
    await reset()
  })

  afterAll(async () => {
    await close()
  })

  it('defaults to Maintainer: a project lead is refused and a maintainer is not', async () => {
    await seedSource(db)

    const lead = await post(db, sourceCommit('evt-st-lead'), await token(500, { username: 'lead' }))
    expect(lead.accepted).toHaveLength(0)
    expect(lead.rejected[0].status).toBe(403)
    expect(lead.rejected[0].reason).toContain('source.cell.commit')
    expect(await sourceValue(db)).toBe('In the beginning')

    const maintainer = await post(db, sourceCommit('evt-st-maint'), await token(600, { username: 'maint' }))
    expect(maintainer.rejected, JSON.stringify(maintainer.rejected)).toEqual([])
    expect(maintainer.accepted).toHaveLength(1)
    expect(await sourceValue(db)).toBe('In the beginning God')
  })

  it('a project lead may edit and hide when the floor is Project Lead, and neither when it is Maintainer', async () => {
    await seedSource(db)
    await setProjectSettings(db, { sourceTextFloor: 'project_lead' })
    const lead = await token(500, { username: 'lead' })

    const edited = await post(db, sourceCommit('evt-st-lead-ok'), lead)
    expect(edited.rejected, JSON.stringify(edited.rejected)).toEqual([])
    const hidden = await post(db, hide('evt-st-hide-ok'), lead)
    expect(hidden.rejected, JSON.stringify(hidden.rejected)).toEqual([])

    await setProjectSettings(db, { sourceTextFloor: 'maintainer' })
    const refused = await post(db, sourceCommit('evt-st-lead-no', 'evt-st-lead-ok', 'A later correction'), lead)
    expect(refused.rejected[0].status).toBe(403)
    const hideRefused = await post(db, hide('evt-st-hide-no'), lead)
    expect(hideRefused.rejected[0].status).toBe(403)
    expect(hideRefused.rejected[0].reason).toContain('source.cell.visibility.set')
  })

  it('Project Lead on one lane can edit at that floor and cannot at Maintainer', async () => {
    await seedSource(db)
    const laneLead = await token(100, {
      username: 'lane-lead',
      laneGrants: [{ lane: 'es', level: 500 }],
    })

    const closed = await post(db, sourceCommit('evt-st-lane-no'), laneLead)
    expect(closed.rejected[0].status).toBe(403)
    expect(await sourceValue(db)).toBe('In the beginning')

    await setProjectSettings(db, { sourceTextFloor: 'project_lead' })
    const open = await post(db, sourceCommit('evt-st-lane-ok'), laneLead)
    expect(open.rejected, JSON.stringify(open.rejected)).toEqual([])
    expect(await sourceValue(db)).toBe('In the beginning God')
  })

  it('Contributor on one lane can edit only at the Contributor floor, including a grant stored on the project', async () => {
    await seedSource(db)
    const onToken = await token(100, {
      username: 'lane-contributor',
      userId: 42,
      laneGrants: [{ lane: 'es', level: 400 }],
    })
    await setProjectSettings(db, { sourceTextFloor: 'project_lead' })
    const tooHigh = await post(db, sourceCommit('evt-st-c-no'), onToken)
    expect(tooHigh.rejected[0].status).toBe(403)

    await setProjectSettings(db, { sourceTextFloor: 'contributor' })
    const open = await post(db, sourceCommit('evt-st-c-ok'), onToken)
    expect(open.rejected, JSON.stringify(open.rejected)).toEqual([])

    await db
      .prepare(
        `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
         VALUES ('lane-es', ?, 'target', 'es', 'es', 0)`,
      )
      .bind(PROJECT)
      .run()
    await db
      .prepare(
        `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES (?, ?, ?, ?)`,
      )
      .bind(PROJECT, 43, 'lane-es', 400)
      .run()
    await setProjectSettings(db, { sourceTextFloor: 'maintainer' })
    const fromTable = await token(100, { username: 'stored-grant', userId: 43 })
    const stillClosed = await post(db, sourceCommit('evt-st-c-table-no', 'evt-st-c-ok', 'Still closed'), fromTable)
    expect(stillClosed.rejected[0].status).toBe(403)
    await setProjectSettings(db, { sourceTextFloor: 'contributor' })
    const fromTableOk = await post(db, sourceCommit('evt-st-c-table-ok', 'evt-st-c-ok', 'Opened'), fromTable)
    expect(fromTableOk.rejected, JSON.stringify(fromTableOk.rejected)).toEqual([])
    expect(fromTableOk.accepted).toHaveLength(1)
  })

  it('the retiring project role counts without a lane grant, and Biblica ETT org default is Project Lead', async () => {
    await db.prepare(
      `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'alice', 'a@x.com', 'x'), (9, 'owner', 'o@x.com', 'x')`,
    ).run()
    await db.prepare(
      `INSERT INTO organizations (id, name, owner_user_id) VALUES (7, ?, 9)`,
    ).bind(BIBLICA_ETT_ORG_NAME).run()
    await db.prepare(
      `INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Pattani', 7, 9)`,
    ).bind(PROJECT).run()
    await db.prepare(
      `INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 1, 700)`,
    ).bind(PROJECT).run()
    await db.prepare(
      `INSERT INTO org_settings (org_id, settings, version) VALUES (7, ?, 1)`,
    ).bind(JSON.stringify({ sourceTextFloor: 'project_lead' })).run()
    await seedSource(db)
    const lead = await post(db, sourceCommit('evt-st-biblica'), await token(500, { username: 'lead' }))
    expect(lead.rejected, JSON.stringify(lead.rejected)).toEqual([])

    const contributor = await post(db, hide('evt-st-biblica-hide'), await token(400, { username: 'contributor' }))
    expect(contributor.rejected[0].status).toBe(403)
  })
})
