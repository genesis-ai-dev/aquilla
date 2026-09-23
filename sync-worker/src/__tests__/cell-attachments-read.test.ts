// AQU-777: the cell-attachments read route, against real Postgres (PGlite)
// running the canonical db/postgres/schema.sql.
//
// A real engine rather than a SQL-pattern stub, because what this route gets
// wrong is exactly what a stub cannot see: the LEFT JOIN onto `cells`
// (an attachment on a deleted cell must still surface, with a null label), the
// ORDER BY that lets the drawer group in one pass, and the soft-delete and
// project/file scoping in the WHERE clause.

import { describe, it, expect } from 'vitest'
import {
  handleCellAttachmentsReadRequest,
  ATTACHMENTS_MAX_ROWS,
  type AttachmentRowOut,
} from '../events/cell-attachments-read-route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'cell-attachments-read-secret'

function attachment(over: Record<string, unknown> = {}) {
  return {
    attachment_id: 'att-1',
    project_id: 'p1',
    file_id: 'f1',
    cell_id: 'GEN 1:1',
    object_name: 'att-1.png',
    name: 'layout.png',
    mime_type: 'image/png',
    size_bytes: 1024,
    author_id: 'ana',
    author_label: 'ana',
    created_at: 1000,
    deleted_at: null,
    event_id: 'evt-1',
    ...over,
  }
}

function sourceCell(over: Record<string, unknown> = {}) {
  return {
    project_id: 'p1',
    file_id: 'f1',
    cell_id: 'GEN 1:1',
    side: 'source',
    value: 'In the beginning',
    canonical_ref: 'GEN 1:1',
    event_id: 'evt-cell-1',
    ...over,
  }
}

async function get(
  db: AquillaDb,
  query: string,
  tokenOver: Record<string, unknown> = {},
): Promise<Response> {
  const token = await makeTestToken(SECRET, { projectId: 'p1', fileId: 'any', ...tokenOver })
  const res = await handleCellAttachmentsReadRequest(
    new Request(`https://w/api/v1/projects/p1/attachments${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET },
  )
  expect(res).not.toBeNull()
  return res!
}

async function rowsOf(res: Response): Promise<AttachmentRowOut[]> {
  const body = (await res.json()) as { attachments: AttachmentRowOut[] }
  return body.attachments
}

describe('GET /attachments', () => {
  it('returns a file\'s live attachments with the cell\'s canonical ref', async () => {
    const { db } = await makeTestDb({
      cell_attachments: [attachment()],
      cells: [sourceCell()],
    })
    const rows = await rowsOf(await get(db, '?fileId=f1'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      attachmentId: 'att-1',
      fileId: 'f1',
      cellId: 'GEN 1:1',
      objectName: 'att-1.png',
      name: 'layout.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      cellRef: 'GEN 1:1',
    })
  })

  it('orders by (cell, created, id) so the drawer can group in one pass', async () => {
    const { db } = await makeTestDb({
      cell_attachments: [
        attachment({ attachment_id: 'c', cell_id: 'GEN 1:2', created_at: 1000 }),
        attachment({ attachment_id: 'b', cell_id: 'GEN 1:1', created_at: 2000 }),
        attachment({ attachment_id: 'a', cell_id: 'GEN 1:1', created_at: 1000 }),
        // Deliberate created_at tie inside a cell — the id is the tiebreak, so
        // two attachments saved in the same millisecond have a stable order
        // instead of whatever the planner returns.
        attachment({ attachment_id: 'a2', cell_id: 'GEN 1:1', created_at: 1000 }),
      ],
    })
    const rows = await rowsOf(await get(db, '?fileId=f1'))
    expect(rows.map((r) => r.attachmentId)).toEqual(['a', 'a2', 'b', 'c'])
  })

  it('omits soft-deleted rows', async () => {
    const { db } = await makeTestDb({
      cell_attachments: [
        attachment({ attachment_id: 'live' }),
        attachment({ attachment_id: 'gone', deleted_at: 5000 }),
      ],
    })
    const rows = await rowsOf(await get(db, '?fileId=f1'))
    expect(rows.map((r) => r.attachmentId)).toEqual(['live'])
  })

  it('keeps an attachment whose cell no longer exists, with a null label', async () => {
    // LEFT, not INNER. An attachment on a since-deleted cell must still reach
    // the drawer — it just has no verse address to head its group with.
    const { db } = await makeTestDb({
      cell_attachments: [attachment({ cell_id: 'ghost' })],
      cells: [sourceCell()],
    })
    const rows = await rowsOf(await get(db, '?fileId=f1'))
    expect(rows).toHaveLength(1)
    expect(rows[0].cellRef).toBeNull()
  })

  it('does not duplicate a row when the cell has a target side too', async () => {
    // The join is pinned to side='source'; without that a cell with both sides
    // would return its attachment twice.
    const { db } = await makeTestDb({
      cell_attachments: [attachment()],
      cells: [
        sourceCell(),
        sourceCell({ side: 'target', value: 'Au commencement', event_id: 'evt-cell-2' }),
      ],
    })
    expect(await rowsOf(await get(db, '?fileId=f1'))).toHaveLength(1)
  })

  it('scopes to the requested file', async () => {
    const { db } = await makeTestDb({
      cell_attachments: [
        attachment({ attachment_id: 'mine', file_id: 'f1' }),
        attachment({ attachment_id: 'other', file_id: 'f2' }),
      ],
    })
    const rows = await rowsOf(await get(db, '?fileId=f1'))
    expect(rows.map((r) => r.attachmentId)).toEqual(['mine'])
  })

  it('narrows to one cell when asked', async () => {
    const { db } = await makeTestDb({
      cell_attachments: [
        attachment({ attachment_id: 'a', cell_id: 'GEN 1:1' }),
        attachment({ attachment_id: 'b', cell_id: 'GEN 1:2' }),
      ],
    })
    const rows = await rowsOf(await get(db, '?fileId=f1&cellId=GEN 1:2'))
    expect(rows.map((r) => r.attachmentId)).toEqual(['b'])
  })

  it('never returns another project\'s rows, even for the same file id', async () => {
    // Double-scoped by the projectId VERIFIED from the JWT, not one taken from
    // the query — a token for p1 must not read p2.
    const { db } = await makeTestDb({
      cell_attachments: [
        attachment({ attachment_id: 'ours', project_id: 'p1' }),
        attachment({ attachment_id: 'theirs', project_id: 'p2' }),
      ],
    })
    const rows = await rowsOf(await get(db, '?fileId=f1'))
    expect(rows.map((r) => r.attachmentId)).toEqual(['ours'])
  })

  it('rejects a token scoped to a different project', async () => {
    const { db } = await makeTestDb({ cell_attachments: [attachment()] })
    const res = await get(db, '?fileId=f1', { projectId: 'p2' })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('requires an Authorization header', async () => {
    const { db } = await makeTestDb({ cell_attachments: [attachment()] })
    const res = await handleCellAttachmentsReadRequest(
      new Request('https://w/api/v1/projects/p1/attachments?fileId=f1'),
      { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET },
    )
    expect(res!.status).toBe(401)
  })

  it('requires fileId — the drawer\'s unit of work is one file', async () => {
    const { db } = await makeTestDb({ cell_attachments: [attachment()] })
    const res = await get(db, '')
    expect(res.status).toBe(400)
  })

  it('reports truncation rather than silently dropping rows', async () => {
    const { db } = await makeTestDb({
      cell_attachments: Array.from({ length: ATTACHMENTS_MAX_ROWS + 5 }, (_, i) =>
        attachment({ attachment_id: `att-${String(i).padStart(5, '0')}`, cell_id: `c${i}` }),
      ),
    })
    const res = await get(db, '?fileId=f1')
    const body = (await res.json()) as { attachments: AttachmentRowOut[]; truncated: boolean }
    expect(body.attachments).toHaveLength(ATTACHMENTS_MAX_ROWS)
    expect(body.truncated).toBe(true)
  })

  it('is not truncated at exactly the limit', async () => {
    // The over-fetch-by-one is what makes this unambiguous; a bare
    // `rows.length === LIMIT` check would cry wolf on an exactly-full file.
    const { db } = await makeTestDb({
      cell_attachments: Array.from({ length: ATTACHMENTS_MAX_ROWS }, (_, i) =>
        attachment({ attachment_id: `att-${String(i).padStart(5, '0')}`, cell_id: `c${i}` }),
      ),
    })
    const res = await get(db, '?fileId=f1')
    const body = (await res.json()) as { attachments: AttachmentRowOut[]; truncated: boolean }
    expect(body.attachments).toHaveLength(ATTACHMENTS_MAX_ROWS)
    expect(body.truncated).toBe(false)
  })

  it('falls through on a non-matching path or method', async () => {
    const { db } = await makeTestDb({})
    const env = { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
    expect(
      await handleCellAttachmentsReadRequest(
        new Request('https://w/api/v1/projects/p1/comments'),
        env,
      ),
    ).toBeNull()
    expect(
      await handleCellAttachmentsReadRequest(
        new Request('https://w/api/v1/projects/p1/attachments', { method: 'POST' }),
        env,
      ),
    ).toBeNull()
  })
})
