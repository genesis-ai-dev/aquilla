// Comments read route: cursor pagination + scoped variants + counts aggregate.
//
// Why: the unpaged route shipped the whole project history on every open of
// the workspace. A page must be exact (no skipped or repeated rows across a
// created_at tie) and the badge count must not require the rows at all.
import { describe, it, expect } from 'vitest'
import {
  handleCommentsReadRequest,
  decodeCommentsCursor,
  encodeCommentsCursor,
  type CommentRowOut,
} from '../events/comments-read-route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'comments-page-secret'

function comment(i: number, over: Record<string, unknown> = {}) {
  return {
    comment_id: `cmt-${String(i).padStart(3, '0')}`, project_id: 'p1', scope_kind: 'cell',
    file_id: i % 2 === 0 ? 'f-even' : 'f-odd', cell_id: `c${i}`, parent_comment_id: null,
    body: `body ${i}`, resolved: 0, author_id: 'alice',
    // Deliberate created_at ties: every pair shares a timestamp so the
    // id tiebreak is exercised at page boundaries.
    created_at: 1000 + Math.floor(i / 2), updated_at: 1000, deleted_at: null,
    ...over,
  }
}

async function get(db: AquillaDb, path: string) {
  const token = await makeTestToken(SECRET, { projectId: 'p1', fileId: 'any' })
  const res = await handleCommentsReadRequest(
    new Request(`https://w${path}`, { headers: { Authorization: `Bearer ${token}` } }),
    { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET },
  )
  return res!
}

describe('GET /comments — cursor pagination', () => {
  it('walks every row exactly once across created_at ties and ends with a null cursor', async () => {
    const { db } = await makeTestDb({ comments: Array.from({ length: 23 }, (_, i) => comment(i)) })
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const qs = `limit=5${cursor ? `&cursor=${cursor}` : ''}`
      const res = await get(db, `/api/v1/projects/p1/comments?${qs}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { comments: CommentRowOut[]; nextCursor: string | null }
      expect(body.comments.length).toBeLessThanOrEqual(5)
      seen.push(...body.comments.map((c) => c.commentId))
      cursor = body.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBe(5)
    expect(seen).toHaveLength(23)
    expect(new Set(seen).size).toBe(23)
    expect(seen).toEqual([...seen].sort())
  })

  it('defaults to a 200-row page and reports a cursor only when more rows exist', async () => {
    const { db } = await makeTestDb({ comments: Array.from({ length: 201 }, (_, i) => comment(i)) })
    const first = (await (await get(db, '/api/v1/projects/p1/comments')).json()) as {
      comments: CommentRowOut[]; nextCursor: string | null
    }
    expect(first.comments).toHaveLength(200)
    expect(first.nextCursor).not.toBeNull()
    const rest = (await (await get(db, `/api/v1/projects/p1/comments?cursor=${first.nextCursor}`)).json()) as {
      comments: CommentRowOut[]; nextCursor: string | null
    }
    expect(rest.comments).toHaveLength(1)
    expect(rest.nextCursor).toBeNull()
  })

  it('scopes to ?fileId= and pages within that scope', async () => {
    const { db } = await makeTestDb({ comments: Array.from({ length: 10 }, (_, i) => comment(i)) })
    const res = await get(db, '/api/v1/projects/p1/comments?fileId=f-odd&limit=3')
    const body = (await res.json()) as { comments: CommentRowOut[]; nextCursor: string | null }
    expect(body.comments.map((c) => c.fileId)).toEqual(['f-odd', 'f-odd', 'f-odd'])
    const next = (await (await get(db, `/api/v1/projects/p1/comments?fileId=f-odd&limit=3&cursor=${body.nextCursor}`)).json()) as {
      comments: CommentRowOut[]; nextCursor: string | null
    }
    expect(next.comments).toHaveLength(2)
    expect(next.comments.every((c) => c.fileId === 'f-odd')).toBe(true)
    expect(next.nextCursor).toBeNull()
  })

  it('scopes to ?fileId=&cellId=', async () => {
    const { db } = await makeTestDb({ comments: Array.from({ length: 6 }, (_, i) => comment(i)) })
    const body = (await (await get(db, '/api/v1/projects/p1/comments?fileId=f-even&cellId=c4')).json()) as {
      comments: CommentRowOut[]; nextCursor: string | null
    }
    expect(body.comments.map((c) => c.commentId)).toEqual(['cmt-004'])
    expect(body.nextCursor).toBeNull()
  })

  it('rejects a malformed cursor with 400 instead of silently restarting', async () => {
    const { db } = await makeTestDb({ comments: [comment(0)] })
    expect((await get(db, '/api/v1/projects/p1/comments?cursor=%%%')).status).toBe(400)
  })

  it('cursor round-trips', () => {
    const c = { createdAt: 1712345678901, commentId: 'a:b/c+d' }
    expect(decodeCommentsCursor(encodeCommentsCursor(c))).toEqual(c)
  })
})

describe('GET /comments/counts — unresolved aggregate', () => {
  it('counts open root threads per file, ignoring replies, resolved and deleted rows', async () => {
    const { db } = await makeTestDb({
      comments: [
        comment(1, { file_id: 'f1' }),
        comment(2, { file_id: 'f1' }),
        comment(3, { file_id: 'f1', parent_comment_id: 'cmt-001' }), // reply
        comment(4, { file_id: 'f1', resolved: 1 }),
        comment(5, { file_id: 'f2', deleted_at: 5 }),
        comment(6, { file_id: 'f2' }),
        comment(7, { scope_kind: 'project', file_id: null, cell_id: null }),
        comment(8, { project_id: 'p-other', file_id: 'f1' }), // other project
      ],
    })
    const res = await get(db, '/api/v1/projects/p1/comments/counts')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ unresolved: 4, byFile: { f1: 2, f2: 1, '': 1 } })
  })

  it('requires auth like the list route', async () => {
    const { db } = await makeTestDb({})
    const res = await handleCommentsReadRequest(
      new Request('https://w/api/v1/projects/p1/comments/counts'),
      { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET },
    )
    expect(res!.status).toBe(401)
  })
})
