// Tests for handleBookAffirmEvent — the book.affirm / book.unaffirm projection
// (AQU-727 "mark book done").
//
// 1. book.affirm        : inserts one book_affirmations row keyed (project, book).
// 2. book.affirm again  : ON CONFLICT DO UPDATE refreshes author + timestamp + note.
// 3. book.unaffirm      : deletes the (project, book) row.
// 4. Role gate          : a reviewer (300) token is rejected — the family
//                         requires project_lead (500).

import { describe, it, expect } from 'vitest'
import { handleBookAffirmEvent } from '../events/handlers/book-affirm-events'
import { authorize } from '../events/authorize'
import { makeTestToken } from './helpers/auth'
import { makeTestDb } from './helpers/pg-test-db'
import type { EventKind, RawEvent } from '../events/types'

const SECRET = 'test-secret'

// Build an AuthorizedEvent the same way the route does (authorize() under a
// file-scoped sync token). book.affirm carries a fileId on the envelope for
// auth/routing; the affirmed unit (book_code) lives in the payload.
async function authorizeBookAffirm<K extends EventKind>(
  kind: K,
  payload: unknown,
  { role = 500, userId = 7, username = 'lead' }: { role?: number; userId?: number; username?: string } = {},
) {
  const raw = {
    id: 'evt-00000000-0000-7000-0000-0000000000bb',
    schemaVersion: 1,
    kind,
    projectId: 'proj-1',
    fileId: 'file-gen',
    parentId: null,
    author: username,
    payload,
    clientTs: 1000,
  } as unknown as RawEvent<K>
  const token = await makeTestToken(SECRET, {
    userId,
    username,
    projectId: 'proj-1',
    fileId: 'file-gen',
    role,
  })
  const res = await authorize(token, raw, SECRET)
  if (!res.ok) throw new Error(`authorize failed: ${res.status} ${res.reason}`)
  return res.event
}

describe('book.affirm', () => {
  it('inserts one book_affirmations row keyed (project, book)', async () => {
    const { db, snapshot } = await makeTestDb({})
    const authed = await authorizeBookAffirm('book.affirm', { bookCode: 'GEN', note: 'Done reviewing' }, { userId: 42, username: 'matthew' })

    const result = handleBookAffirmEvent(db, authed, 2000)
    await db.batch(result.stmts)

    const rows = (await snapshot()).book_affirmations
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.project_id).toBe('proj-1')
    expect(row.book_code).toBe('GEN')
    expect(row.affirmed_by).toBe(42)
    expect(row.affirmed_by_label).toBe('matthew')
    expect(row.event_id).toBe('evt-00000000-0000-7000-0000-0000000000bb')
    expect(row.affirmed_at).toBe(2000)
    expect(row.note).toBe('Done reviewing')

    expect(result.dirtyTables).toEqual(
      expect.arrayContaining(['events', 'book_affirmations']),
    )
  })

  it('re-affirming the same book refreshes author, timestamp, and note (ON CONFLICT DO UPDATE)', async () => {
    const { db, snapshot } = await makeTestDb({})

    const first = await authorizeBookAffirm('book.affirm', { bookCode: 'GEN', note: 'first' }, { userId: 1, username: 'alice' })
    await db.batch(handleBookAffirmEvent(db, first, 2000).stmts)

    const second = await authorizeBookAffirm('book.affirm', { bookCode: 'GEN' }, { userId: 2, username: 'bob' })
    await db.batch(handleBookAffirmEvent(db, second, 3000).stmts)

    const rows = (await snapshot()).book_affirmations
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.affirmed_by).toBe(2)
    expect(row.affirmed_by_label).toBe('bob')
    expect(row.affirmed_at).toBe(3000)
    expect(row.note).toBeNull()
  })

  it('book.unaffirm deletes the (project, book) row', async () => {
    const { db, snapshot } = await makeTestDb({})

    const affirm = await authorizeBookAffirm('book.affirm', { bookCode: 'GEN' })
    await db.batch(handleBookAffirmEvent(db, affirm, 2000).stmts)
    expect((await snapshot()).book_affirmations).toHaveLength(1)

    const unaffirm = await authorizeBookAffirm('book.unaffirm', { bookCode: 'GEN' })
    await db.batch(handleBookAffirmEvent(db, unaffirm, 4000).stmts)
    expect((await snapshot()).book_affirmations).toHaveLength(0)
  })

  it('rejects a reviewer (300) — the family requires project_lead (500)', async () => {
    await expect(
      authorizeBookAffirm('book.affirm', { bookCode: 'GEN' }, { role: 300 }),
    ).rejects.toThrow(/role too low/)
  })
})
