// AQU-1771 — the org may set a default for how many validations a cell or a
// take needs; a project's own value wins; absent on both reads as 1. These pin
// the resolution in the projection (cells.validated) and the progress reads.

import { describe, it, expect, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { readValidationCount, readValidationCountAudio } from '../events/progress-read-route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'org-default-secret'
const PROJECT = 'proj-orgdef'
const FILE = 'file-orgdef'

async function token(role: number, username: string): Promise<string> {
  return makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role, username } as any)
}

async function post(db: AquillaDb, events: RawEvent[], tok: string) {
  const res = await handleEventsWriteRequest(
    new Request('https://worker/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ events }),
    }),
    { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET },
  )
  return res!.json() as Promise<{ accepted: unknown[]; rejected: unknown[] }>
}

async function seedOrg(db: AquillaDb, orgSettings: Record<string, unknown> | null) {
  await db.prepare(`INSERT INTO organizations (id, name, owner_user_id) VALUES (41, 'Org', 1)`).run()
  await db
    .prepare(
      `INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'P', 41, 1)
       ON CONFLICT (id) DO UPDATE SET org_id = 41`,
    )
    .bind(PROJECT)
    .run()
  if (orgSettings) {
    await db
      .prepare(`INSERT INTO org_settings (org_id, settings, version) VALUES (41, ?, 1)`)
      .bind(JSON.stringify(orgSettings))
      .run()
  }
}

async function setProjectSettings(db: AquillaDb, settings: Record<string, unknown>) {
  await db
    .prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_at)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (project_id) DO UPDATE SET settings = excluded.settings`,
    )
    .bind(PROJECT, JSON.stringify(settings))
    .run()
}

async function seedFileAndCell(db: AquillaDb) {
  const r1 = await post(db, [{
    id: 'evt-od-file', schemaVersion: 1, kind: 'file.create', projectId: PROJECT, fileId: FILE,
    cellId: undefined, parentId: null, author: 'owner',
    payload: { name: 'F', fileType: 'codex' }, clientTs: 0,
  } as RawEvent<'file.create'>], await token(700, 'owner'))
  expect(r1.rejected).toHaveLength(0)
  const r2 = await post(db, [{
    id: 'evt-od-commit', schemaVersion: 1, kind: 'target.cell.commit', projectId: PROJECT, fileId: FILE,
    cellId: 'cell-od-1', parentId: null, author: 'alice',
    payload: { value: 'text', valueHtml: '<p>text</p>' }, clientTs: 100,
  } as RawEvent<'target.cell.commit'>], await token(400, 'alice'))
  expect(r2.rejected).toHaveLength(0)
}

async function validateOnceAndRead(db: AquillaDb): Promise<number> {
  const res = await post(db, [{
    id: 'evt-od-val', schemaVersion: 1, kind: 'cell.validate', projectId: PROJECT, fileId: FILE,
    cellId: 'cell-od-1', parentId: 'evt-od-commit', author: 'bob',
    payload: { editEventId: 'evt-od-commit' }, clientTs: 200,
  } as RawEvent<'cell.validate'>], await token(300, 'bob'))
  expect(res.rejected).toHaveLength(0)
  const row = await db
    .prepare(`SELECT validated FROM cells WHERE project_id = ? AND cell_id = 'cell-od-1' AND side = 'target'`)
    .bind(PROJECT)
    .first<{ validated: number | boolean }>()
  return Number(row?.validated)
}

describe('AQU-1771: cells.validated uses the org default when the project has none', () => {
  it('one endorsement does not validate when the org requires two and the project is silent', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db)
    await seedOrg(db, { validationCount: 2 })
    expect(await validateOnceAndRead(db)).toBe(0)
  })

  it("the project's own value wins over the org's", async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db)
    await seedOrg(db, { validationCount: 2 })
    await setProjectSettings(db, { validationCount: 1 })
    expect(await validateOnceAndRead(db)).toBe(1)
  })

  it('neither set: one endorsement validates', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db)
    await seedOrg(db, null)
    expect(await validateOnceAndRead(db)).toBe(1)
  })
})

describe('AQU-1771: progress reads resolve project → org → 1', () => {
  it('project set wins', async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { validationCount: 3, validationCountAudio: 4 })
    await setProjectSettings(db, { validationCount: 2, validationCountAudio: 5 })
    expect(await readValidationCount(db, PROJECT)).toBe(2)
    expect(await readValidationCountAudio(db, PROJECT)).toBe(5)
  })

  it('project unset falls back to the org', async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { validationCount: 3, validationCountAudio: 4 })
    await setProjectSettings(db, {})
    expect(await readValidationCount(db, PROJECT)).toBe(3)
    expect(await readValidationCountAudio(db, PROJECT)).toBe(4)
  })

  it('no settings row at all still takes the org default', async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, { validationCount: 3 })
    expect(await readValidationCount(db, PROJECT)).toBe(3)
    expect(await readValidationCountAudio(db, PROJECT)).toBe(1)
  })

  it('both unset read as 1, and values are capped at 15', async () => {
    const { db } = await makeTestDb()
    await seedOrg(db, null)
    expect(await readValidationCount(db, PROJECT)).toBe(1)
    await setProjectSettings(db, { validationCount: 99 })
    expect(await readValidationCount(db, PROJECT)).toBe(15)
  })
})
