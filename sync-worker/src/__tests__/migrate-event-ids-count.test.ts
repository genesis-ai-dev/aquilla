import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { handleMigrateEventIdsRequest } from '../events/migrate-event-ids-route'
import { handleMigrateIngestRequest } from '../events/migrate-ingest-route'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

let t: TestDb
beforeAll(async () => { t = await makeTestDb() }, 120_000)
afterAll(async () => { await t.close() })
const env = () => ({ AQUILLA_PG: t.db, SYNC_SECRET_KEY: 's' })

describe('GET /migrate/event-ids?count=1', () => {
  it('returns only the count', async () => {
    await handleMigrateIngestRequest(new Request('https://s/migrate/ingest', { method: 'POST', headers: { Authorization: 'Bearer s' },
      body: JSON.stringify({ projectId: 'p', eventsOnly: true, events: [{ id: 'a', kind: 'file.create', author: 'x', clientTs: 1, payload: {} }, { id: 'b', kind: 'file.create', author: 'x', clientTs: 1, payload: {} }] }) }), env())
    const r = await handleMigrateEventIdsRequest(new Request('https://s/migrate/event-ids?projectId=p&count=1', { headers: { Authorization: 'Bearer s' } }), env())
    expect(await r!.json()).toEqual({ count: 2 })
  })
})
