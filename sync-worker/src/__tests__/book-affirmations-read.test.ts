// Tests for the book-affirmations read route (AQU-727).
//
//   GET /api/v1/projects/:projectId/book-affirmations[?bookCode=]
//
// Verifies: rows are returned camelCased + project-scoped; the optional
// bookCode filter narrows to one book; a token for another project cannot read
// (project scope enforced by the JWT).

import { describe, it, expect } from 'vitest'
import { handleBookAffirmationsReadRequest, type BookAffirmationRowOut } from '../events/book-affirmations-read-route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'test-secret'

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

function seededAffirmations() {
  return [
    { project_id: 'proj-a', book_code: 'GEN', affirmed_by: 7, affirmed_by_label: 'lead', event_id: 'e1', affirmed_at: 1000, note: 'done' },
    { project_id: 'proj-a', book_code: 'EXO', affirmed_by: 7, affirmed_by_label: 'lead', event_id: 'e2', affirmed_at: 1100, note: null },
    // A different project's row — must never leak through a proj-a token.
    { project_id: 'proj-b', book_code: 'GEN', affirmed_by: 9, affirmed_by_label: 'other', event_id: 'e3', affirmed_at: 1200, note: null },
  ]
}

describe('book-affirmations read route', () => {
  it('returns every affirmation for the token project, camelCased, ordered by book', async () => {
    const { db } = await makeTestDb({ book_affirmations: seededAffirmations() })
    const token = await makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x' })
    const req = new Request('https://w/api/v1/projects/proj-a/book-affirmations', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleBookAffirmationsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { affirmations: BookAffirmationRowOut[] }
    expect(body.affirmations.map((a) => a.bookCode)).toEqual(['EXO', 'GEN'])
    const gen = body.affirmations.find((a) => a.bookCode === 'GEN')!
    expect(gen.projectId).toBe('proj-a')
    expect(gen.affirmedBy).toBe(7)
    expect(gen.affirmedByLabel).toBe('lead')
    expect(gen.note).toBe('done')
  })

  it('filters to a single book with ?bookCode', async () => {
    const { db } = await makeTestDb({ book_affirmations: seededAffirmations() })
    const token = await makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x' })
    const req = new Request('https://w/api/v1/projects/proj-a/book-affirmations?bookCode=GEN', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleBookAffirmationsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { affirmations: BookAffirmationRowOut[] }
    expect(body.affirmations).toHaveLength(1)
    expect(body.affirmations[0].bookCode).toBe('GEN')
  })

  it('rejects a token scoped to another project', async () => {
    const { db } = await makeTestDb({ book_affirmations: seededAffirmations() })
    const token = await makeTestToken(SECRET, { projectId: 'proj-b', fileId: 'file-x' })
    const req = new Request('https://w/api/v1/projects/proj-a/book-affirmations', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleBookAffirmationsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(403)
  })

  it('returns null for a non-matching path', async () => {
    const { db } = await makeTestDb({})
    const req = new Request('https://w/api/v1/projects/proj-a/comments')
    const res = await handleBookAffirmationsReadRequest(req, envWith(db))
    expect(res).toBeNull()
  })
})
