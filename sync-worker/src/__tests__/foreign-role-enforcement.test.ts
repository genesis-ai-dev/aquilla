// Tests for foreign-vs-self role enforcement:
//
//   cell.unvalidate:
//     - reviewer(300) can remove their OWN validation
//     - reviewer(300) CANNOT remove another user's validation (foreign unvalidate)
//     - maintainer(600) CAN remove another user's validation
//
//   comment.edit / comment.delete / comment.resolve:
//     - commenter(200) can mutate their OWN comment
//     - commenter(200) CANNOT mutate a foreign comment (route rejects 403)
//     - maintainer(600) CAN edit/delete/resolve a foreign comment
//
// All tests go through handleEventsWriteRequest (the full route layer) so the
// foreign ownership DB check + role gate is exercised end-to-end.

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

// ── Token helpers ──────────────────────────────────────────────────────────

async function makeToken(role: number, username = 'alice'): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: 'proj-a',
    fileId: 'file-x',
    role,
    username,
  } as any)
}

async function makeRequest(events: unknown[], token: string): Promise<Request> {
  return new Request('https://worker/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ events }),
  })
}

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

// ── Seed helpers ────────────────────────────────────────────────────────────

/** Post one event through the route and assert it was accepted. */
async function postEvent(db: AquillaDb, event: RawEvent, token: string): Promise<void> {
  const res = await handleEventsWriteRequest(await makeRequest([event], token), makeEnv(db))
  const body = await res!.json() as any
  expect(body.rejected, `event ${event.id} should be accepted but was rejected: ${JSON.stringify(body.rejected)}`).toHaveLength(0)
  expect(body.accepted).toHaveLength(1)
}

// Seed a file and a target cell so validation events have something to attach to.
async function seedFileAndCell(db: AquillaDb): Promise<void> {
  const ownerToken = await makeToken(700, 'owner')
  const fileEvt: RawEvent<'file.create'> = {
    id: 'evt-file-seed',
    schemaVersion: 1,
    kind: 'file.create',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: undefined,
    parentId: null,
    author: 'owner',
    payload: { name: 'Test File', fileType: 'codex' },
    clientTs: 0,
  }
  await postEvent(db, fileEvt, ownerToken)

  const contributorToken = await makeToken(400, 'alice')
  const cellEvt: RawEvent<'target.cell.create'> = {
    id: 'evt-cell-seed',
    schemaVersion: 1,
    kind: 'target.cell.create',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    parentId: null,
    author: 'alice',
    payload: { cellId: 'cell-1', value: 'hello' },
    clientTs: 100,
  }
  await postEvent(db, cellEvt, contributorToken)
}

// ── cell.unvalidate tests ──────────────────────────────────────────────────

describe('cell.unvalidate — foreign-vs-self role enforcement', () => {
  it('reviewer(300) can unvalidate their own validation', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db)

    // bob validates the cell
    const bobReviewerToken = await makeToken(300, 'bob')
    const validateEvt: RawEvent<'cell.validate'> = {
      id: 'evt-validate-bob',
      schemaVersion: 1,
      kind: 'cell.validate',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: 'cell-1',
      parentId: 'evt-cell-seed',
      author: 'bob',
      payload: { editEventId: 'evt-cell-seed' },
      clientTs: 200,
    }
    await postEvent(db, validateEvt, bobReviewerToken)

    // bob unvalidates their own (no targetUsername needed — self path)
    const unvalidateEvt: RawEvent<'cell.unvalidate'> = {
      id: 'evt-unvalidate-bob-self',
      schemaVersion: 1,
      kind: 'cell.unvalidate',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: 'cell-1',
      parentId: 'evt-cell-seed',
      author: 'bob',
      payload: { editEventId: 'evt-cell-seed' },
      clientTs: 300,
    }
    const res = await handleEventsWriteRequest(
      await makeRequest([unvalidateEvt], bobReviewerToken),
      makeEnv(db),
    )
    const body = await res!.json() as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })

  it('reviewer(300) CANNOT remove another user validation (foreign unvalidate → 403)', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db)

    // alice validates
    const aliceReviewerToken = await makeToken(300, 'alice')
    const validateEvt: RawEvent<'cell.validate'> = {
      id: 'evt-validate-alice',
      schemaVersion: 1,
      kind: 'cell.validate',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: 'cell-1',
      parentId: 'evt-cell-seed',
      author: 'alice',
      payload: { editEventId: 'evt-cell-seed' },
      clientTs: 200,
    }
    await postEvent(db, validateEvt, aliceReviewerToken)

    // bob (reviewer) tries to remove alice's validation via targetUsername
    const bobReviewerToken = await makeToken(300, 'bob')
    const foreignUnvalidate: RawEvent<'cell.unvalidate'> = {
      id: 'evt-unvalidate-alice-by-bob',
      schemaVersion: 1,
      kind: 'cell.unvalidate',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: 'cell-1',
      parentId: 'evt-cell-seed',
      author: 'bob',
      payload: { editEventId: 'evt-cell-seed', targetUsername: 'alice' },
      clientTs: 300,
    }
    const res = await handleEventsWriteRequest(
      await makeRequest([foreignUnvalidate], bobReviewerToken),
      makeEnv(db),
    )
    const body = await res!.json() as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
    expect(body.accepted).toHaveLength(0)
  })

  it('maintainer(600) CAN remove another user validation (foreign unvalidate)', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db)

    // alice validates
    const aliceReviewerToken = await makeToken(300, 'alice')
    const validateEvt: RawEvent<'cell.validate'> = {
      id: 'evt-validate-alice-m',
      schemaVersion: 1,
      kind: 'cell.validate',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: 'cell-1',
      parentId: 'evt-cell-seed',
      author: 'alice',
      payload: { editEventId: 'evt-cell-seed' },
      clientTs: 200,
    }
    await postEvent(db, validateEvt, aliceReviewerToken)

    // maintainer removes alice's validation
    const maintainerToken = await makeToken(600, 'carol')
    const foreignUnvalidate: RawEvent<'cell.unvalidate'> = {
      id: 'evt-unvalidate-alice-by-carol',
      schemaVersion: 1,
      kind: 'cell.unvalidate',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: 'cell-1',
      parentId: 'evt-cell-seed',
      author: 'carol',
      payload: { editEventId: 'evt-cell-seed', targetUsername: 'alice' },
      clientTs: 300,
    }
    const res = await handleEventsWriteRequest(
      await makeRequest([foreignUnvalidate], maintainerToken),
      makeEnv(db),
    )
    const body = await res!.json() as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })
})

// ── comment.edit / comment.delete / comment.resolve tests ─────────────────

/** Seed a comment authored by `author` and return the commentId. */
async function seedComment(db: AquillaDb, commentId: string, authorUsername: string): Promise<void> {
  const authorToken = await makeToken(200, authorUsername)
  const createEvt: RawEvent<'comment.create'> = {
    id: `evt-comment-create-${commentId}`,
    schemaVersion: 1,
    kind: 'comment.create',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: undefined,
    parentId: null,
    author: authorUsername,
    payload: {
      commentId,
      scope: { kind: 'project' },
      body: 'Original body',
      parentCommentId: null,
    },
    clientTs: 100,
  }
  await postEvent(db, createEvt, authorToken)
}

describe('comment.edit — foreign-vs-self role enforcement', () => {
  it('author (commenter) can edit their own comment', async () => {
    const { db } = await makeTestDb()
    await seedComment(db, 'cmt-self-edit', 'alice')

    const aliceToken = await makeToken(200, 'alice')
    const editEvt: RawEvent<'comment.edit'> = {
      id: 'evt-comment-edit-self',
      schemaVersion: 1,
      kind: 'comment.edit',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: undefined,
      parentId: null,
      author: 'alice',
      payload: { commentId: 'cmt-self-edit', body: 'Updated body' },
      clientTs: 200,
    }
    const res = await handleEventsWriteRequest(await makeRequest([editEvt], aliceToken), makeEnv(db))
    const body = await res!.json() as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })

  it('commenter(200) CANNOT edit a foreign comment → 403', async () => {
    const { db } = await makeTestDb()
    await seedComment(db, 'cmt-foreign-edit', 'alice')

    const bobToken = await makeToken(200, 'bob')
    const editEvt: RawEvent<'comment.edit'> = {
      id: 'evt-comment-edit-foreign',
      schemaVersion: 1,
      kind: 'comment.edit',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: undefined,
      parentId: null,
      author: 'bob',
      payload: { commentId: 'cmt-foreign-edit', body: 'Hacked' },
      clientTs: 200,
    }
    const res = await handleEventsWriteRequest(await makeRequest([editEvt], bobToken), makeEnv(db))
    const body = await res!.json() as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
  })

  it('maintainer(600) CAN edit a foreign comment', async () => {
    const { db } = await makeTestDb()
    await seedComment(db, 'cmt-maintainer-edit', 'alice')

    const maintainerToken = await makeToken(600, 'carol')
    const editEvt: RawEvent<'comment.edit'> = {
      id: 'evt-comment-edit-maint',
      schemaVersion: 1,
      kind: 'comment.edit',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: undefined,
      parentId: null,
      author: 'carol',
      payload: { commentId: 'cmt-maintainer-edit', body: 'Maintainer edit' },
      clientTs: 200,
    }
    const res = await handleEventsWriteRequest(await makeRequest([editEvt], maintainerToken), makeEnv(db))
    const body = await res!.json() as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })
})

describe('comment.delete — foreign-vs-self role enforcement', () => {
  it('author can delete their own comment', async () => {
    const { db } = await makeTestDb()
    await seedComment(db, 'cmt-self-del', 'alice')

    const aliceToken = await makeToken(200, 'alice')
    const delEvt: RawEvent<'comment.delete'> = {
      id: 'evt-comment-del-self',
      schemaVersion: 1,
      kind: 'comment.delete',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: undefined,
      parentId: null,
      author: 'alice',
      payload: { commentId: 'cmt-self-del' },
      clientTs: 200,
    }
    const res = await handleEventsWriteRequest(await makeRequest([delEvt], aliceToken), makeEnv(db))
    const body = await res!.json() as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })

  it('commenter(200) CANNOT delete a foreign comment → 403', async () => {
    const { db } = await makeTestDb()
    await seedComment(db, 'cmt-foreign-del', 'alice')

    const bobToken = await makeToken(200, 'bob')
    const delEvt: RawEvent<'comment.delete'> = {
      id: 'evt-comment-del-foreign',
      schemaVersion: 1,
      kind: 'comment.delete',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: undefined,
      parentId: null,
      author: 'bob',
      payload: { commentId: 'cmt-foreign-del' },
      clientTs: 200,
    }
    const res = await handleEventsWriteRequest(await makeRequest([delEvt], bobToken), makeEnv(db))
    const body = await res!.json() as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
  })

  it('maintainer(600) CAN delete a foreign comment', async () => {
    const { db } = await makeTestDb()
    await seedComment(db, 'cmt-maintainer-del', 'alice')

    const maintainerToken = await makeToken(600, 'carol')
    const delEvt: RawEvent<'comment.delete'> = {
      id: 'evt-comment-del-maint',
      schemaVersion: 1,
      kind: 'comment.delete',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: undefined,
      parentId: null,
      author: 'carol',
      payload: { commentId: 'cmt-maintainer-del' },
      clientTs: 200,
    }
    const res = await handleEventsWriteRequest(await makeRequest([delEvt], maintainerToken), makeEnv(db))
    const body = await res!.json() as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })
})

describe('comment.resolve — foreign-vs-self role enforcement', () => {
  it('author can resolve their own comment thread', async () => {
    const { db } = await makeTestDb()
    await seedComment(db, 'cmt-self-res', 'alice')

    const aliceToken = await makeToken(200, 'alice')
    const resolveEvt: RawEvent<'comment.resolve'> = {
      id: 'evt-comment-res-self',
      schemaVersion: 1,
      kind: 'comment.resolve',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: undefined,
      parentId: null,
      author: 'alice',
      payload: { commentId: 'cmt-self-res', resolved: true },
      clientTs: 200,
    }
    const res = await handleEventsWriteRequest(await makeRequest([resolveEvt], aliceToken), makeEnv(db))
    const body = await res!.json() as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })

  it('commenter(200) CANNOT resolve a foreign comment thread → 403', async () => {
    const { db } = await makeTestDb()
    await seedComment(db, 'cmt-foreign-res', 'alice')

    const bobToken = await makeToken(200, 'bob')
    const resolveEvt: RawEvent<'comment.resolve'> = {
      id: 'evt-comment-res-foreign',
      schemaVersion: 1,
      kind: 'comment.resolve',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: undefined,
      parentId: null,
      author: 'bob',
      payload: { commentId: 'cmt-foreign-res', resolved: true },
      clientTs: 200,
    }
    const res = await handleEventsWriteRequest(await makeRequest([resolveEvt], bobToken), makeEnv(db))
    const body = await res!.json() as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
  })

  it('maintainer(600) CAN resolve a foreign comment thread', async () => {
    const { db } = await makeTestDb()
    await seedComment(db, 'cmt-maintainer-res', 'alice')

    const maintainerToken = await makeToken(600, 'carol')
    const resolveEvt: RawEvent<'comment.resolve'> = {
      id: 'evt-comment-res-maint',
      schemaVersion: 1,
      kind: 'comment.resolve',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: undefined,
      parentId: null,
      author: 'carol',
      payload: { commentId: 'cmt-maintainer-res', resolved: true },
      clientTs: 200,
    }
    const res = await handleEventsWriteRequest(await makeRequest([resolveEvt], maintainerToken), makeEnv(db))
    const body = await res!.json() as any
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })
})

// ── Projection-level: maintainer edit/delete actually mutates foreign row ──

describe('projection: maintainer edit/delete ACTUALLY updates foreign comment row', () => {
  it('maintainer edit changes the body of a foreign comment', async () => {
    const { db, rows } = await makeTestDb()
    await seedComment(db, 'cmt-proj-edit', 'alice')

    const maintainerToken = await makeToken(600, 'carol')
    const editEvt: RawEvent<'comment.edit'> = {
      id: 'evt-proj-edit-maint',
      schemaVersion: 1,
      kind: 'comment.edit',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: undefined,
      parentId: null,
      author: 'carol',
      payload: { commentId: 'cmt-proj-edit', body: 'Maintainer corrected body' },
      clientTs: 200,
    }
    await handleEventsWriteRequest(await makeRequest([editEvt], maintainerToken), makeEnv(db))

    const comments = await rows<{ comment_id: string; body: string }>('comments')
    const row = comments.find((r) => r.comment_id === 'cmt-proj-edit')
    expect(row?.body).toBe('Maintainer corrected body')
  })

  it('maintainer delete soft-deletes a foreign comment', async () => {
    const { db, rows } = await makeTestDb()
    await seedComment(db, 'cmt-proj-del', 'alice')

    const maintainerToken = await makeToken(600, 'carol')
    const delEvt: RawEvent<'comment.delete'> = {
      id: 'evt-proj-del-maint',
      schemaVersion: 1,
      kind: 'comment.delete',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: undefined,
      parentId: null,
      author: 'carol',
      payload: { commentId: 'cmt-proj-del' },
      clientTs: 200,
    }
    await handleEventsWriteRequest(await makeRequest([delEvt], maintainerToken), makeEnv(db))

    const comments = await rows<{ comment_id: string; body: string; deleted_at: number | null }>('comments')
    const row = comments.find((r) => r.comment_id === 'cmt-proj-del')
    expect(row?.body).toBe('')
    expect(row?.deleted_at).not.toBeNull()
  })
})

