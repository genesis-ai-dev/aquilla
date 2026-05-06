import { describe, it, expect } from 'vitest'
import { handleEventsReadRequest } from '../events/read-route'
import { handleValidatorsReadRequest } from '../events/validators-read-route'
import { handleCellsAuditReadRequest } from '../events/cells-audit-read-route'
import { makeInMemoryD1 } from './helpers/d1-fake'
import { makeTestToken } from './helpers/auth'

const SECRET = 'read-route-secret'

function envWith(db: ReturnType<typeof makeInMemoryD1>) {
  return { CODEX_DB: db, SYNC_SECRET_KEY: SECRET }
}

describe('CQRS read routes', () => {
  it('GET /events returns rows newest-first with filters', async () => {
    const db = makeInMemoryD1({
      events: [
        {
          id: 'e1',
          schema_version: 1,
          project_id: 'proj-a',
          file_id: 'file-x',
          cell_id: 'c1',
          kind: 'cell.commit',
          author: 'alice',
          payload: '{"value":"a"}',
          client_ts: 1,
          server_ts: 100,
        },
        {
          id: 'e2',
          schema_version: 1,
          project_id: 'proj-a',
          file_id: 'file-x',
          cell_id: 'c1',
          kind: 'cell.commit',
          author: 'bob',
          payload: '{"value":"b"}',
          client_ts: 2,
          server_ts: 200,
        },
        {
          id: 'e3',
          schema_version: 1,
          project_id: 'proj-a',
          file_id: 'file-x',
          cell_id: 'c2',
          kind: 'cell.commit',
          author: 'alice',
          payload: '{"value":"c"}',
          client_ts: 3,
          server_ts: 150,
        },
      ],
    })
    const token = await makeTestToken(SECRET, {
      projectId: 'proj-a',
      fileId: 'file-x',
    })
    const req = new Request('https://w/events?fileId=file-x&cellId=c1&limit=10', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleEventsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: { id: string; serverTs: number }[] }
    expect(body.events).toHaveLength(2)
    expect(body.events[0].id).toBe('e2')
    expect(body.events[1].id).toBe('e1')
  })

  it('GET /cell-validators returns validator rows', async () => {
    const db = makeInMemoryD1({
      cell_validators: [
        {
          project_id: 'proj-a',
          file_id: 'file-x',
          cell_id: 'c1',
          edit_event_id: 'ev1',
          username: 'bob',
          is_active: 1,
          decided_ts: 50,
        },
        {
          project_id: 'proj-a',
          file_id: 'file-x',
          cell_id: 'c1',
          edit_event_id: 'ev1',
          username: 'bob',
          is_active: 0,
          decided_ts: 100,
        },
      ],
    })
    const token = await makeTestToken(SECRET, {
      projectId: 'proj-a',
      fileId: 'file-x',
    })
    const req = new Request(
      'https://w/cell-validators?fileId=file-x&cellId=c1',
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleValidatorsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      validators: { editEventId: string; isActive: boolean; decidedTs: number }[]
    }
    expect(body.validators).toHaveLength(2)
    expect(body.validators[0].decidedTs).toBe(100)
    expect(body.validators[0].isActive).toBe(false)
  })

  it('GET /cells/audit-stats returns edit_count, content_hash, last-edit metadata, and active validators', async () => {
    const db = makeInMemoryD1({
      cells: [
        {
          file_id: 'file-x',
          cell_id: 'c1',
          content_text: 'x',
          content_hash: 'abcd1234',
          validated: 1,
          word_count: 1,
          last_editor: 'a',
          last_edit_at: 1700,
          projected_from: 'event:ev-current',
          edit_count: 3,
        },
        {
          file_id: 'file-x',
          cell_id: 'c2',
          content_text: 'y',
          content_hash: 'beef9999',
          validated: 0,
          word_count: 1,
          last_editor: 'b',
          last_edit_at: 1800,
          // projected_from without "event:" prefix → no last_edit_event_id, no validators usable.
          projected_from: 'legacy-y-doc',
          edit_count: 1,
        },
      ],
      cell_validators: [
        // Active validators tied to the current edit on c1.
        {
          project_id: 'proj-x',
          file_id: 'file-x',
          cell_id: 'c1',
          edit_event_id: 'ev-current',
          username: 'alice',
          is_active: 1,
          decided_ts: 1750,
        },
        {
          project_id: 'proj-x',
          file_id: 'file-x',
          cell_id: 'c1',
          edit_event_id: 'ev-current',
          username: 'bob',
          is_active: 1,
          decided_ts: 1751,
        },
        // Stale validator on a previous edit — must not surface for the current edit.
        {
          project_id: 'proj-x',
          file_id: 'file-x',
          cell_id: 'c1',
          edit_event_id: 'ev-old',
          username: 'carol',
          is_active: 1,
          decided_ts: 1600,
        },
        // Soft-deleted validator on the current edit — must not appear.
        {
          project_id: 'proj-x',
          file_id: 'file-x',
          cell_id: 'c1',
          edit_event_id: 'ev-current',
          username: 'dave',
          is_active: 0,
          decided_ts: 1752,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { fileId: 'file-x', projectId: 'proj-x' })
    const req = new Request('https://w/cells/audit-stats?fileId=file-x', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleCellsAuditReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      cells: {
        cellId: string
        editCount: number
        contentHash: string
        lastEditAt: number | null
        lastEditEventId: string | null
        activeValidators: string[]
      }[]
    }
    const c1 = body.cells.find((c) => c.cellId === 'c1')!
    expect(c1.editCount).toBe(3)
    expect(c1.contentHash).toBe('abcd1234')
    expect(c1.lastEditAt).toBe(1700)
    expect(c1.lastEditEventId).toBe('ev-current')
    expect(new Set(c1.activeValidators)).toEqual(new Set(['alice', 'bob']))

    const c2 = body.cells.find((c) => c.cellId === 'c2')!
    expect(c2.lastEditEventId).toBe(null)
    expect(c2.activeValidators).toEqual([])
  })
})
