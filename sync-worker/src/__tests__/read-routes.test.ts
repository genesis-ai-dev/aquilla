import { describe, it, expect } from 'vitest'
import { handleEventsReadRequest } from '../events/read-route'
import { handleValidatorsReadRequest } from '../events/validators-read-route'
import { handleCellsAuditReadRequest } from '../events/cells-audit-read-route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'read-route-secret'

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

describe('GET /events', () => {
  it('returns rows newest-first by server_seq with filters', async () => {
    const { db } = await makeTestDb({
      events: [
        {
          id: 'e1', schema_version: 1, project_id: 'proj-a', file_id: 'file-x',
          cell_id: 'c1', parent_id: null, kind: 'target.cell.create',
          author: 'alice', payload: '{"value":"a"}',
          client_ts: 1, server_ts: 100, server_seq: 1,
        },
        {
          id: 'e2', schema_version: 1, project_id: 'proj-a', file_id: 'file-x',
          cell_id: 'c1', parent_id: 'e1', kind: 'target.cell.commit',
          author: 'bob', payload: '{"value":"b"}',
          client_ts: 2, server_ts: 200, server_seq: 2,
        },
        {
          id: 'e3', schema_version: 1, project_id: 'proj-a', file_id: 'file-x',
          cell_id: 'c2', parent_id: null, kind: 'target.cell.create',
          author: 'alice', payload: '{"value":"c"}',
          client_ts: 3, server_ts: 150, server_seq: 3,
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
    const body = (await res.json()) as { events: { id: string; serverSeq: number; parentId: string | null }[] }
    expect(body.events).toHaveLength(2)
    expect(body.events[0].id).toBe('e2')
    expect(body.events[0].serverSeq).toBe(2)
    expect(body.events[0].parentId).toBe('e1')
    expect(body.events[1].id).toBe('e1')
    expect(body.events[1].parentId).toBe(null)
  })
})

describe('GET /cell-validators', () => {
  it('returns validator rows newest-first', async () => {
    // DELETE-on-unvalidate: each row = one active validator. Two rows from
    // different timestamps; newest-first ordering checked below.
    const { db } = await makeTestDb({
      cell_validators: [
        {
          project_id: 'proj-a', file_id: 'file-x', cell_id: 'c1',
          event_id: 'ev1', username: 'bob',
          decided_ts: 50,
        },
        {
          project_id: 'proj-a', file_id: 'file-x', cell_id: 'c1',
          event_id: 'ev2', username: 'alice',
          decided_ts: 100,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x' })
    const req = new Request(
      'https://w/cell-validators?fileId=file-x&cellId=c1',
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleValidatorsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      validators: { editEventId: string; decidedTs: number }[]
    }
    expect(body.validators).toHaveLength(2)
    expect(body.validators[0].decidedTs).toBe(100)
  })
})

describe('GET /cells/audit-stats', () => {
  it('returns side, event_id (chain head), source_event_id (AD-9 pin), and active validators', async () => {
    const { db } = await makeTestDb({
      cells: [
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
          side: 'target', value: 'hello world', content_hash: 'abcd1234',
          event_id: 'ev-current', source_event_id: 'src-current-1',
          last_editor: 'a', last_edit_at: 1700, validated: 1, word_count: 2,
        },
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c2',
          side: 'source', value: 'hola', content_hash: 'beef9999',
          event_id: 'src-1', source_event_id: null,
          last_editor: 'b', last_edit_at: 1800, validated: 0, word_count: 1,
        },
      ],
      cell_validators: [
        // Active validators tied to the current chain head on c1.
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
          event_id: 'ev-current', username: 'alice',
          decided_ts: 1750,
        },
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
          event_id: 'ev-current', username: 'bob',
          decided_ts: 1751,
        },
        // Validator on a prior edit — does not count for the current head.
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
          event_id: 'ev-old', username: 'carol',
          decided_ts: 1600,
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
        side: string
        contentHash: string | null
        lastEditAt: number | null
        lastEditEventId: string
        sourceEventId: string | null
        activeValidators: string[]
      }[]
    }
    const c1 = body.cells.find((c) => c.cellId === 'c1')!
    expect(c1.side).toBe('target')
    expect(c1.lastEditEventId).toBe('ev-current')
    expect(c1.sourceEventId).toBe('src-current-1')
    expect(new Set(c1.activeValidators)).toEqual(new Set(['alice', 'bob']))

    const c2 = body.cells.find((c) => c.cellId === 'c2')!
    expect(c2.side).toBe('source')
    expect(c2.sourceEventId).toBe(null)
    expect(c2.activeValidators).toEqual([])
  })
})
