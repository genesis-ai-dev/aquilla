// AQU-1693: a concept's Bible entity link (`externalIds.acai`) through the
// term.* projection and back out of the concepts read route, on PGlite built
// from schema.sql.
//
// WHY THE ROUND TRIP: the link decides whose name a rendering becomes in
// Voices and Who's Who. So each test runs the real producer (the projector)
// into the real consumer (the read route the SPA calls): a link must survive
// every edit that does not name it, an unlink must really unlink, and nothing
// malformed may come back as a link.

import { describe, it, expect, beforeEach } from 'vitest'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { handleConceptsReadRequest } from '../events/concepts-read-route'
import type { EventKind, EventPayloads } from '../events/types'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'test-secret'
const PROJECT = 'p1'
const JESUS = 'person:Jesus.2'

let testDb: TestDb
let seq = 0

beforeEach(async () => {
  testDb = await makeTestDb()
  seq = 0
})

async function apply<K extends EventKind>(kind: K, payload: EventPayloads[K]): Promise<void> {
  seq += 1
  const event = {
    id: `evt-${seq}`,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: null,
    cellId: null,
    parentId: null,
    kind,
    author: 'alice',
    payload,
    clientTs: 1000 + seq,
    serverTs: 2000 + seq,
    serverSeq: seq,
  } as PersistedEvent<K>
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(testDb.db, event, stmts)
  await testDb.db.batch(stmts)
}

async function readLink(conceptId: string): Promise<unknown> {
  const token = await makeTestToken(SECRET, { projectId: PROJECT })
  const res = await handleConceptsReadRequest(
    new Request(`https://worker/api/v1/projects/${PROJECT}/concepts`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { AQUILLA_PG: testDb.db, SYNC_SECRET_KEY: SECRET },
  )
  expect(res?.status).toBe(200)
  const body = (await res!.json()) as { concepts: Array<{ conceptId: string; externalIds: unknown }> }
  return body.concepts.find((c) => c.conceptId === conceptId)?.externalIds
}

const create = (externalIds?: unknown) =>
  apply('term.create', {
    conceptId: 'c1',
    sourceTerm: 'Jesus',
    renderings: [{ rendering: 'Yesus', status: 'preferred' }],
    status: 'active',
    ...(externalIds === undefined ? {} : { externalIds: externalIds as { acai?: string } }),
  })

describe('a concept linked to a Bible entity', () => {
  it('reads back the link a term.create stored', async () => {
    await create({ acai: JESUS })
    expect(await readLink('c1')).toEqual({ acai: JESUS })
  })

  it('reads back no link for a concept created without one', async () => {
    await create()
    expect(await readLink('c1')).toBeNull()
  })

  it('keeps its link through an edit that does not name it', async () => {
    // Two people: one links, the other renames the headword from a snapshot
    // taken before the link. The rename must not undo the link.
    await create({ acai: JESUS })
    await apply('term.update', { conceptId: 'c1', sourceTerm: 'Yesus Kristus', notes: 'n' })
    expect(await readLink('c1')).toEqual({ acai: JESUS })
  })

  it('links and unlinks through term.update, and `{}` really unlinks', async () => {
    await create()
    await apply('term.update', { conceptId: 'c1', externalIds: { acai: JESUS } })
    expect(await readLink('c1')).toEqual({ acai: JESUS })
    await apply('term.update', { conceptId: 'c1', externalIds: {} })
    expect(await readLink('c1')).toBeNull()
  })

  it('never stores a malformed link, and a malformed update leaves the link alone', async () => {
    // Nothing validates an app-pushed payload before the projector.
    await create({ acai: 'Jesus Christ' })
    expect(await readLink('c1')).toBeNull()
    await apply('term.update', { conceptId: 'c1', externalIds: { acai: JESUS } })
    await apply('term.update', { conceptId: 'c1', externalIds: { acai: 42 } as unknown as { acai?: string } })
    expect(await readLink('c1')).toEqual({ acai: JESUS })
  })
})
