// Tests for the comment.* event projection + comments read route.
//
// 1. comment.create inserts a row into the comments table.
// 2. comment.edit updates body + updated_at (same author only).
// 3. comment.delete soft-deletes: body cleared, deleted_at set.
// 4. comment.resolve sets resolved on top-level; noops on a reply.
// 5. Threaded reply: comment.create with parentCommentId inserts a child row.

import { describe, it, expect } from 'vitest'
import {
  buildEventProjectionStmts,
  type PersistedEvent,
} from '../events/event-projection'
import { makeTestDb } from './helpers/pg-test-db'
import type { EventKind } from '../events/types'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEvent<K extends EventKind>(
  kind: K,
  payload: unknown,
  overrides: Partial<PersistedEvent> = {},
): PersistedEvent<K> {
  return {
    id: 'evt-comment-1',
    schemaVersion: 1,
    projectId: 'proj-1',
    fileId: null,
    cellId: null,
    parentId: null,
    kind,
    author: 'alice',
    payload,
    clientTs: 1000,
    serverTs: 2000,
    serverSeq: 1,
    ...overrides,
  } as PersistedEvent<K>
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('comment.create', () => {
  it('inserts a row into the comments table with correct fields', async () => {
    const { db, snapshot } = await makeTestDb()
    const stmts: D1PreparedStatement[] = []

    const touches = buildEventProjectionStmts(
      db,
      makeEvent('comment.create', {
        commentId: 'cmt-1',
        scope: { kind: 'cell', fileId: 'file-a', cellId: 'cell-1' },
        body: 'Looks great!',
        parentCommentId: null,
      }),
      stmts,
    )

    expect(touches).toContain('comments')
    await db.batch(stmts)

    const tables = (await snapshot()) as any
    const row = (tables.comments as any[]).find((r: any) => r.comment_id === 'cmt-1')
    expect(row).toBeDefined()
    expect(row.project_id).toBe('proj-1')
    expect(row.scope_kind).toBe('cell')
    expect(row.file_id).toBe('file-a')
    expect(row.cell_id).toBe('cell-1')
    expect(row.body).toBe('Looks great!')
    expect(row.resolved).toBe(0)
    expect(row.author_id).toBe('alice')
    expect(row.parent_comment_id).toBeNull()
    expect(row.deleted_at).toBeNull()
  })

  it('inserts a threaded reply with parent_comment_id set', async () => {
    const { db, snapshot } = await makeTestDb()
    const stmts1: D1PreparedStatement[] = []
    const stmts2: D1PreparedStatement[] = []

    buildEventProjectionStmts(
      db,
      makeEvent('comment.create', {
        commentId: 'cmt-root',
        scope: { kind: 'cell', fileId: 'file-a', cellId: 'cell-1' },
        body: 'Root comment',
        parentCommentId: null,
      }, { id: 'evt-1' }),
      stmts1,
    )
    await db.batch(stmts1)

    buildEventProjectionStmts(
      db,
      makeEvent('comment.create', {
        commentId: 'cmt-reply',
        scope: { kind: 'cell', fileId: 'file-a', cellId: 'cell-1' },
        body: 'Reply here',
        parentCommentId: 'cmt-root',
      }, { id: 'evt-2' }),
      stmts2,
    )
    await db.batch(stmts2)

    const tables = (await snapshot()) as any
    const reply = (tables.comments as any[]).find((r: any) => r.comment_id === 'cmt-reply')
    expect(reply).toBeDefined()
    expect(reply.parent_comment_id).toBe('cmt-root')
    expect(reply.body).toBe('Reply here')
  })
})

describe('comment.edit', () => {
  it('updates body and updated_at for the same author', async () => {
    const { db, snapshot } = await makeTestDb()

    // Seed a comment row directly.
    const createStmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('comment.create', {
        commentId: 'cmt-edit',
        scope: { kind: 'project' },
        body: 'Original',
        parentCommentId: null,
      }, { id: 'evt-c1', serverTs: 1000 }),
      createStmts,
    )
    await db.batch(createStmts)

    const editStmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('comment.edit', {
        commentId: 'cmt-edit',
        body: 'Edited body',
      }, { id: 'evt-e1', serverTs: 2000 }),
      editStmts,
    )
    await db.batch(editStmts)

    const tables = (await snapshot()) as any
    const row = (tables.comments as any[]).find((r: any) => r.comment_id === 'cmt-edit')
    expect(row.body).toBe('Edited body')
    expect(row.updated_at).toBe(2000)
  })
})

describe('comment.delete', () => {
  it('soft-deletes: sets body to empty and deleted_at to serverTs', async () => {
    const { db, snapshot } = await makeTestDb()

    const createStmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('comment.create', {
        commentId: 'cmt-del',
        scope: { kind: 'file', fileId: 'file-b' },
        body: 'To be deleted',
        parentCommentId: null,
      }, { id: 'evt-c2', serverTs: 1000 }),
      createStmts,
    )
    await db.batch(createStmts)

    const delStmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('comment.delete', { commentId: 'cmt-del' }, { id: 'evt-d1', serverTs: 3000 }),
      delStmts,
    )
    await db.batch(delStmts)

    const tables = (await snapshot()) as any
    const row = (tables.comments as any[]).find((r: any) => r.comment_id === 'cmt-del')
    expect(row).toBeDefined()           // row still exists (soft-delete)
    expect(row.body).toBe('')           // body cleared
    expect(row.deleted_at).toBe(3000)   // deleted_at set
  })
})

describe('comment.resolve', () => {
  it('sets resolved=1 on a top-level comment', async () => {
    const { db, snapshot } = await makeTestDb()

    const createStmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('comment.create', {
        commentId: 'cmt-res',
        scope: { kind: 'project' },
        body: 'Thread to resolve',
        parentCommentId: null,
      }, { id: 'evt-cr1', serverTs: 1000 }),
      createStmts,
    )
    await db.batch(createStmts)

    const resolveStmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('comment.resolve', { commentId: 'cmt-res', resolved: true }, { id: 'evt-rv1', serverTs: 4000 }),
      resolveStmts,
    )
    await db.batch(resolveStmts)

    const tables = (await snapshot()) as any
    const row = (tables.comments as any[]).find((r: any) => r.comment_id === 'cmt-res')
    expect(row.resolved).toBe(1)
  })

  it('noops when commentId is a reply (parent_comment_id IS NOT NULL)', async () => {
    const { db, snapshot } = await makeTestDb()

    // Create root + reply
    const stmts1: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('comment.create', {
        commentId: 'cmt-root2',
        scope: { kind: 'project' },
        body: 'Root',
        parentCommentId: null,
      }, { id: 'evt-cr2', serverTs: 1000 }),
      stmts1,
    )
    const stmts2: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('comment.create', {
        commentId: 'cmt-reply2',
        scope: { kind: 'project' },
        body: 'Reply',
        parentCommentId: 'cmt-root2',
      }, { id: 'evt-cr3', serverTs: 1000 }),
      stmts2,
    )
    await db.batch(stmts1)
    await db.batch(stmts2)

    // Try to resolve the reply — should be a noop because
    // the WHERE clause requires parent_comment_id IS NULL.
    const resolveStmts: D1PreparedStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent('comment.resolve', { commentId: 'cmt-reply2', resolved: true }, { id: 'evt-rv2', serverTs: 5000 }),
      resolveStmts,
    )
    await db.batch(resolveStmts)

    const tables = (await snapshot()) as any
    const reply = (tables.comments as any[]).find((r: any) => r.comment_id === 'cmt-reply2')
    // The UPDATE WHERE ... parent_comment_id IS NULL matched nothing, so resolved stays 0.
    expect(reply.resolved).toBe(0)
  })
})
