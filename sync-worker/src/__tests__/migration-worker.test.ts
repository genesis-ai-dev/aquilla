import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMigrationWorker, type MigrationWorkerEnv } from '../migration-worker'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { projectIdFor } from '../../../src/lib/migrate/ids'
import { SyncClient } from '../../../scripts/migrate-daemon/http'

const PROJECT = projectIdFor('41', 'gitlab')
const HOST = 'ep-isolated-pooler.c-3.us-east-2.aws.neon.tech'
const DESTINATION = `${HOST}/postgres/postgres`
const ENV: MigrationWorkerEnv = {
  ADMIN_SECRET: 'test-operator',
  MIGRATION_DATABASE_URL: `postgresql://postgres:test-password@${HOST}/postgres?sslmode=require`,
  MIGRATION_EXPECTED_HOST: HOST, MIGRATION_EXPECTED_DATABASE: 'postgres', MIGRATION_EXPECTED_ROLE: 'postgres',
  MIGRATION_WRITES_ENABLED: 'true', MIGRATION_ALLOWED_GITLAB_IDS: '41',
}
let t: TestDb
const pending: Promise<unknown>[] = []
const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p) } } as ExecutionContext
const headers = { Authorization: 'Bearer test-operator', 'x-migrate-runner': 'test-runner',
  'x-migrate-gitlab-id': '41', 'x-migrate-org-id': '1', 'x-migrate-team-id': '1', 'x-migrate-destination': DESTINATION }
function request(path = '/migrate/ingest', body: unknown = { projectId: PROJECT, events: [] }, override = {}) {
  return new Request(`https://direct.test${path}`, { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(body) })
}
function worker() {
  return createMigrationWorker(() => new Proxy(t.db, { get(target, key) {
    if (key === 'close') return async () => {}
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }))
}
beforeAll(async () => { t = await makeTestDb() }, 120_000)
afterAll(async () => { await t.close() })
afterEach(async () => { vi.unstubAllGlobals(); await Promise.allSettled(pending.splice(0)) })
beforeEach(async () => {
  await t.reset()
  await t.pg.exec(`SET statement_timeout=15000; SET idle_in_transaction_session_timeout=30000;
    INSERT INTO users(id,username,email,password_hash) VALUES(1,'test','test@example.invalid','not-a-password');
    INSERT INTO organizations(id,name,owner_user_id) VALUES(1,'Test organization',1);
    INSERT INTO groups(id,org_id,name,created_by) VALUES(1,1,'Test team',1);`)
  await t.pg.query('INSERT INTO projects(id,name,org_id,created_by) VALUES($1,$2,1,1)', [PROJECT, 'Original name'])
  await t.pg.query('INSERT INTO group_project_grants(group_id,project_id,role_level) VALUES(1,$1,400)', [PROJECT])
})

describe('dedicated direct migration Worker', () => {
  it('fails closed on credential, source identity, placement, destination, config and timeout mismatches', async () => {
    const w = worker()
    const cases: Array<[Request, MigrationWorkerEnv, number]> = [
      [request('/events'), ENV, 404],
      [new Request('https://direct.test/migrate/ingest', { headers }), ENV, 405],
      [request(undefined, undefined, { Authorization: 'Bearer test-signing' }), ENV, 401],
      [request(undefined, undefined, { 'x-migrate-runner': '' }), ENV, 503],
      [request(), { ...ENV, MIGRATION_WRITES_ENABLED: 'false' }, 503],
      [request(), { ...ENV, MIGRATION_ALLOWED_GITLAB_IDS: '42' }, 403],
      [request(undefined, undefined, { 'x-migrate-gitlab-id': '42' }), ENV, 400],
      [request(undefined, undefined, { 'x-migrate-org-id': '2' }), ENV, 409],
      [request(undefined, undefined, { 'x-migrate-team-id': '2' }), ENV, 409],
      [request(undefined, undefined, { 'x-migrate-destination': 'other/database/role' }), ENV, 409],
      [request('/migrate/ingest?transport=hyperdrive'), ENV, 400],
      [request(undefined, { projectId: PROJECT, eventsOnly: true, events: [] }), ENV, 400],
      [request(undefined, { projectId: PROJECT, events: Array(251).fill({}) }), ENV, 400],
      [request(), { ...ENV, MIGRATION_EXPECTED_HOST: 'wrong-pooler.neon.tech' }, 503],
      [request(), { ...ENV, MIGRATION_EXPECTED_ROLE: 'wrong' }, 503],
    ]
    for (const [req, env, status] of cases) expect((await w.fetch(req, env, ctx)).status, req.url).toBe(status)
    await t.pg.exec('SET statement_timeout=0')
    expect((await w.fetch(request(), ENV, ctx)).status).toBe(503)
    expect((await t.pg.query<{ n: number }>('SELECT count(*)::int n FROM events')).rows[0].n).toBe(0)
  })

  it('runs the real client and handlers across chunking, lost acknowledgement, rename, replay and finalize', async () => {
    const w = worker()
    let dropped = false
    const batches: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const req = new Request(url, init)
      const res = await w.fetch(req, ENV, ctx)
      if (new URL(url).pathname === '/migrate/ingest') {
        batches.push(JSON.parse(String(init.body)).events.length)
        if (!dropped && res.status === 200) { dropped = true; return new Response('lost acknowledgement', { status: 503 }) }
      }
      return res
    }))
    const client = new SyncClient('https://normal.test', 'normal-secret', 'integration-test', { sleep: async () => {}, random: () => .5 }, {
      base: 'https://direct.test', secret: 'test-operator', destination: DESTINATION,
      identity: () => ({ gitlabId: 41, orgId: 1, teamId: 1 }),
    })
    const events = [
      { id: 'file', kind: 'file.create', author: 'legacy', clientTs: 1, fileId: 'f', payload: { name: 'Test', fileType: 'codex' } },
      ...Array.from({ length: 250 }, (_, i) => ({ id: `source-${i}`, kind: 'source.cell.create', author: 'legacy', clientTs: 2,
        fileId: 'f', cellId: `c${i}`, payload: { cellId: `c${i}`, value: `Source ${i}`, startTime: 10.25 } })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `audio-${i}`, kind: 'cell.audio.attach', author: 'legacy', clientTs: 3,
        fileId: 'f', cellId: `c${i}`, payload: { audioId: `a${i}`, slot: 'main', url: `synthetic://a${i}`, mimeType: 'audio/webm', durationMs: 1234.5 } })),
    ]
    await client.ingest(PROJECT, events)
    expect(Math.max(...batches)).toBe(250)
    expect(batches).toEqual([250, 250, 11])
    await client.finalize(PROJECT, ['f'])
    expect((await t.pg.query<{ n: number }>('SELECT count(*)::int n FROM events')).rows[0].n).toBe(261)
    expect((await t.pg.query<{ n: number }>('SELECT count(*)::int n FROM cells')).rows[0].n).toBe(250)
    expect((await t.pg.query<{ n: number }>('SELECT count(*)::int n FROM cell_audio')).rows[0].n).toBe(10)
    const before = (await t.pg.query('SELECT id,server_ts FROM events ORDER BY id')).rows
    await t.pg.query('UPDATE projects SET name=$1 WHERE id=$2', ['Renamed in Aquilla', PROJECT])
    expect((await client.ingest(PROJECT, events)).accepted).toBe(0)
    expect((await t.pg.query('SELECT id,server_ts FROM events ORDER BY id')).rows).toEqual(before)
    await t.pg.query('UPDATE projects SET archived_at=now() WHERE id=$1', [PROJECT])
    await expect(client.ingest(PROJECT, events)).rejects.toMatchObject({ status: 409 })
  })
})
