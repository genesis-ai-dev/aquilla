// FRO-365 regression pin: a VIEWER (role 100) must never be able to write
// through the real POST /events route, for the exact event kinds the client
// surfaces affordances for (selection-toolbar Translate, header "Run AI
// completions", validate). These floors already existed in role-policy.ts
// (CONTRIBUTOR=400 for target.cell.commit, REVIEWER=300 for cell.validate,
// COMMENTER=200 for comment.create) — this file pins them end-to-end through
// handleEventsWriteRequest so a future refactor of authorize()/route.ts can't
// silently regress viewer enforcement without a test failing.
//
// All tests go through handleEventsWriteRequest (full route layer), matching
// the pattern in events-route.test.ts / foreign-role-enforcement.test.ts.

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
const PROJECT = 'proj-viewer'
const FILE = 'file-viewer'
const CELL = 'cell-viewer-1'

async function makeToken(role: number, username = 'viewer-vera'): Promise<string> {
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

/** Post one event through the route and assert it was accepted (seed helper). */
async function postEvent(db: AquillaDb, event: RawEvent, token: string): Promise<void> {
  const res = await handleEventsWriteRequest(await makeRequest([event], token), makeEnv(db))
  const body = (await res!.json()) as any
  expect(
    body.rejected,
    `event ${event.id} should be accepted: ${JSON.stringify(body.rejected)}`,
  ).toHaveLength(0)
}

async function seedFileAndTargetCell(db: AquillaDb): Promise<string> {
  const ownerToken = await makeToken(700, 'owner')
  await postEvent(db, {
    id: 'evt-viewer-file',
    schemaVersion: 1,
    kind: 'file.create',
    projectId: PROJECT,
    fileId: FILE,
    parentId: null,
    author: 'owner',
    payload: { name: 'Viewer Floor Test', fileType: 'codex' },
    clientTs: 0,
  } as RawEvent<'file.create'>, ownerToken)

  const contributorToken = await makeToken(400, 'contributor-carl')
  const commitEventId = 'evt-viewer-seed-commit'
  await postEvent(db, {
    id: commitEventId,
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    author: 'contributor-carl',
    payload: { value: 'seeded translation' },
    clientTs: 100,
  } as RawEvent<'target.cell.commit'>, contributorToken)

  return commitEventId
}

describe('FRO-365: viewer (role 100) write floor — target.cell.commit', () => {
  it('rejects a viewer-role target.cell.commit (RED #1: selection-toolbar Translate)', async () => {
    const { db } = await makeTestDb()
    await seedFileAndTargetCell(db)
    const viewerToken = await makeToken(100)
    const event: RawEvent<'target.cell.commit'> = {
      id: 'evt-viewer-translate-attempt',
      schemaVersion: 1,
      kind: 'target.cell.commit',
      projectId: PROJECT,
      fileId: FILE,
      cellId: CELL,
      parentId: 'evt-viewer-seed-commit',
      author: 'viewer-vera',
      payload: { value: 'viewer tried to translate this', ai_suggestion: true },
      clientTs: 200,
    }
    const res = (await handleEventsWriteRequest(await makeRequest([event], viewerToken), makeEnv(db)))!
    const body = await res.json() as any
    expect(body.accepted).toHaveLength(0)
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
  })

  it('accepts the same event kind from a CONTRIBUTOR(400) token (floor is not over-tightened)', async () => {
    const { db } = await makeTestDb()
    await seedFileAndTargetCell(db)
    const contributorToken = await makeToken(400, 'contributor-carl')
    const event: RawEvent<'target.cell.commit'> = {
      id: 'evt-contributor-translate',
      schemaVersion: 1,
      kind: 'target.cell.commit',
      projectId: PROJECT,
      fileId: FILE,
      cellId: CELL,
      parentId: 'evt-viewer-seed-commit',
      author: 'contributor-carl',
      payload: { value: 'contributor translation', ai_suggestion: true },
      clientTs: 200,
    }
    const res = (await handleEventsWriteRequest(await makeRequest([event], contributorToken), makeEnv(db)))!
    const body = await res.json() as any
    expect(body.rejected).toHaveLength(0)
    expect(body.accepted).toHaveLength(1)
  })
})

describe('FRO-365: viewer (role 100) write floor — cell.validate', () => {
  it('rejects a viewer-role cell.validate', async () => {
    const { db } = await makeTestDb()
    const commitEventId = await seedFileAndTargetCell(db)
    const viewerToken = await makeToken(100)
    const event: RawEvent<'cell.validate'> = {
      id: 'evt-viewer-validate-attempt',
      schemaVersion: 1,
      kind: 'cell.validate',
      projectId: PROJECT,
      fileId: FILE,
      cellId: CELL,
      parentId: commitEventId,
      author: 'viewer-vera',
      payload: { editEventId: commitEventId },
      clientTs: 300,
    }
    const res = (await handleEventsWriteRequest(await makeRequest([event], viewerToken), makeEnv(db)))!
    const body = await res.json() as any
    expect(body.accepted).toHaveLength(0)
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
  })
})

describe('FRO-365: viewer (role 100) write floor — comment.create', () => {
  it('rejects a viewer-role comment.create', async () => {
    const { db } = await makeTestDb()
    await seedFileAndTargetCell(db)
    const viewerToken = await makeToken(100)
    const event: RawEvent<'comment.create'> = {
      id: 'evt-viewer-comment-attempt',
      schemaVersion: 1,
      kind: 'comment.create',
      projectId: PROJECT,
      fileId: FILE,
      cellId: CELL,
      parentId: null,
      author: 'viewer-vera',
      payload: {
        commentId: 'cmt-viewer-1',
        scope: { kind: 'cell', fileId: FILE, cellId: CELL },
        body: 'viewer trying to comment',
        parentCommentId: null,
      },
      clientTs: 400,
    }
    const res = (await handleEventsWriteRequest(await makeRequest([event], viewerToken), makeEnv(db)))!
    const body = await res.json() as any
    expect(body.accepted).toHaveLength(0)
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
  })
})
