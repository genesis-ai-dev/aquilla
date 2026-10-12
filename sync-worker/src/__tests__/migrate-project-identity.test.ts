import { afterAll, beforeAll, expect, it } from 'vitest'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { handleMigrateProjectRequest } from '../events/migrate-project-route'
import { projectIdFor } from '../../../src/lib/migrate/ids'

let t: TestDb
const projectId = projectIdFor('122', 'gitlab')
const env = () => ({ AQUILLA_PG: t.db, SYNC_SECRET_KEY: 'test-secret' })
const query = (overrides: Record<string, string> = {}) => new URLSearchParams({
  gitlabId: '122', projectId, orgId: '1', teamId: '3', mustExist: 'true', ...overrides,
})
const get = (overrides: Record<string, string> = {}, authorized = true) => handleMigrateProjectRequest(
  new Request(`https://sync.test/migrate/project?${query(overrides)}`, {
    headers: authorized ? { Authorization: 'Bearer test-secret' } : {},
  }), env(),
)
beforeAll(async () => {
  t = await makeTestDb({
    organizations: [{ id: 1, name: 'A', owner_user_id: 9 }, { id: 2, name: 'B', owner_user_id: 9 }],
    groups: [{ id: 3, name: 'team', org_id: 1 }, { id: 4, name: 'other org', org_id: 2 }, { id: 5, name: 'no grant', org_id: 1 }],
    projects: [{ id: projectId, name: 'Renamed in Aquilla', org_id: 1, created_by: 9 }],
    group_project_grants: [{ group_id: 3, project_id: projectId, role_level: 400, granted_by: 9 }],
  })
})
afterAll(async () => { await t?.close() })

it('verifies the actual deterministic migration ID after a rename without writing any table', async () => {
  const before = await t.snapshot()
  const response = await get()
  expect(response?.status).toBe(200)
  expect(await response?.json()).toEqual({ safetyVersion: 1, projectId, exists: true, name: 'Renamed in Aquilla' })
  expect(await t.snapshot()).toEqual(before)
})

it('requires the migration admin bearer', async () => {
  expect((await get({}, false))?.status).toBe(401)
})

it.each<Record<string, string>>([
  { projectId: projectIdFor('123', 'gitlab') },
  { gitlabId: '0122' }, { orgId: '0' }, { orgId: '1.2' },
  { teamId: 'NaN' }, { mustExist: 'typo' },
])('rejects malformed or mismatched identity %j', async (overrides) => {
  expect((await get(overrides))?.status).toBe(400)
})

it.each<Record<string, string>>([{ orgId: '2' }, { teamId: '4' }, { teamId: '5' }, { teamId: '999' }])(
  'blocks wrong org/team or missing grants %j', async (overrides) => {
    expect((await get(overrides))?.status).toBe(409)
  },
)

it('blocks archived projects', async () => {
  await t.db.prepare('UPDATE projects SET archived_at=CURRENT_TIMESTAMP WHERE id=?').bind(projectId).run()
  try { expect((await get())?.status).toBe(409) }
  finally { await t.db.prepare('UPDATE projects SET archived_at=NULL WHERE id=?').bind(projectId).run() }
})

it('allows a proposed new identity but never recreates a missing existing project', async () => {
  const next = { gitlabId: '123', projectId: projectIdFor('123', 'gitlab') }
  expect((await get(next))?.status).toBe(409)
  const response = await get({ ...next, mustExist: 'false' })
  expect(response?.status).toBe(200)
  expect(await response?.json()).toMatchObject({ exists: false, name: null })
  expect((await get({ ...next, mustExist: 'false', orgId: '999' }))?.status).toBe(409)
  expect(await t.db.prepare('SELECT id FROM projects WHERE id=?').bind(next.projectId).first()).toBeNull()
})

it('retains the running daemon POST contract, renamed title and lane initialization', async () => {
  const post = (id: string) => handleMigrateProjectRequest(new Request('https://sync.test/migrate/project', {
    method: 'POST', headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: id, name: 'Codex title', orgId: 1, ownerUserId: 9, teamId: 3 }),
  }), env())
  expect((await post(projectId))?.status).toBe(200)
  expect(await t.db.prepare('SELECT name FROM projects WHERE id=?').bind(projectId).first()).toMatchObject({ name: 'Renamed in Aquilla' })
  const next = projectIdFor('124', 'gitlab')
  expect((await post(next))?.status).toBe(200)
  expect((await post(next))?.status).toBe(200)
  // A migrate POST names no languages, so it creates the source lane only.
  // A target lane is not invented; the blank bridge arrives with the first
  // target cell (ensureProjectLaneStmts).
  expect((await t.db.prepare('SELECT role FROM lanes WHERE project_id=? ORDER BY role').bind(next).all()).results)
    .toEqual([{ role: 'source' }])
  expect((await get({ gitlabId: '124', projectId: next }))?.status).toBe(200)
})
