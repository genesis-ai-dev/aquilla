// Tests for handleRebuildProjectionRequest.
//
// Uses the in-memory D1 fake. The rebuild path wipes the projection then
// replays events in server_seq order, applying the AD-2 first-child-of-
// parent rule for each (project, file, cell, parent_id) slot.

import { describe, it, expect } from 'vitest'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import { makeInMemoryD1, type EventRow } from './helpers/d1-fake'

function makeRequest(
  path: string,
  method = 'POST',
  secret = 'shared-secret',
) {
  return new Request(`https://worker${path}`, {
    method,
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
  })
}

function makeEnv(db?: D1Database, secret: string | undefined = 'shared-secret') {
  return { AQUILLA_DB: db, SYNC_SECRET_KEY: secret }
}

function evt(overrides: Partial<EventRow> & Pick<EventRow, 'id' | 'kind' | 'payload'>): EventRow {
  return {
    schema_version: 1,
    project_id: 'proj-1',
    file_id: 'file-a',
    cell_id: 'cell-1',
    parent_id: null,
    author: 'alice',
    client_ts: 0,
    server_ts: 0,
    server_seq: 0,
    ...overrides,
  } as EventRow
}

describe('handleRebuildProjectionRequest — URL/method/auth', () => {
  it('returns null for non-matching URLs', async () => {
    const result = await handleRebuildProjectionRequest(
      makeRequest('/admin/files/p/f', 'DELETE'),
      makeEnv(),
    )
    expect(result).toBeNull()
  })

  it('returns 405 for non-POST methods', async () => {
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/p1/rebuild-projection', 'GET'),
      makeEnv(),
    ) as Response
    expect(res.status).toBe(405)
  })

  it('returns 500 when SYNC_SECRET_KEY is not configured', async () => {
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/p1/rebuild-projection', 'POST', ''),
      { AQUILLA_DB: makeInMemoryD1(), SYNC_SECRET_KEY: undefined },
    ) as Response
    expect(res.status).toBe(500)
  })

  it('returns 401 when Authorization header has wrong key', async () => {
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/p1/rebuild-projection', 'POST', 'wrong-key'),
      makeEnv(makeInMemoryD1()),
    ) as Response
    expect(res.status).toBe(401)
  })

  it('returns 500 when AQUILLA_DB binding is not configured', async () => {
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/p1/rebuild-projection'),
      makeEnv(undefined),
    ) as Response
    expect(res.status).toBe(500)
  })
})

describe('handleRebuildProjectionRequest — empty + decode', () => {
  it('replays 0 events and wipes existing projection rows', async () => {
    const db = makeInMemoryD1({
      cells: [{
        project_id: 'proj-1', file_id: 'file-a', cell_id: 'cell-1',
        side: 'target', value: 'stale', event_id: 'old', last_editor: 'x',
        last_edit_at: 1, validated: 0, word_count: 1,
      }],
    })
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/proj-1/rebuild-projection'),
      makeEnv(db),
    ) as Response
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.eventsRead).toBe(0)
    expect(body.cellsAfter).toBe(0)
    expect((db as any)._tables().cells).toHaveLength(0)
  })

  it('decodes URL-encoded projectId', async () => {
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/proj%20one/rebuild-projection'),
      makeEnv(makeInMemoryD1()),
    ) as Response
    expect(res.status).toBe(200)
  })
})

describe('handleRebuildProjectionRequest — successful replay', () => {
  it('projects a target.cell.create → target.cell.commit chain', async () => {
    const db = makeInMemoryD1({
      events: [
        evt({
          id: 'evt-create',
          kind: 'target.cell.create',
          parent_id: null,
          payload: JSON.stringify({ cellId: 'cell-1', value: 'first', valueHtml: '<p>first</p>' }),
          server_seq: 1,
          server_ts: 100,
        }),
        evt({
          id: 'evt-commit',
          kind: 'target.cell.commit',
          parent_id: 'evt-create',
          payload: JSON.stringify({ value: 'second', valueHtml: '<p>second</p>', sourceEventId: 'src-1' }),
          server_seq: 2,
          server_ts: 200,
        }),
      ],
    })
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/proj-1/rebuild-projection'),
      makeEnv(db),
    ) as Response
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.eventsRead).toBe(2)
    expect(body.eventsProjected).toBe(2)

    const cells = (db as any)._tables().cells
    expect(cells).toHaveLength(1)
    expect(cells[0].value).toBe('second')
    expect(cells[0].event_id).toBe('evt-commit')
    expect(cells[0].source_event_id).toBe('src-1')
    expect(cells[0].side).toBe('target')
  })

  it('cell commits replay last-write-wins: the highest server_seq commit takes the projection', async () => {
    // Two commits on the same cell — replayed in server_seq order, the later
    // one wins (LWW, matching the live route). The first-child rule still
    // governs creates/reorders/deletes, just not commits.
    const db = makeInMemoryD1({
      events: [
        evt({
          id: 'evt-create',
          kind: 'target.cell.create',
          parent_id: null,
          payload: JSON.stringify({ cellId: 'cell-1', value: 'genesis' }),
          server_seq: 1,
        }),
        evt({
          id: 'evt-earlier',
          kind: 'target.cell.commit',
          parent_id: 'evt-create',
          payload: JSON.stringify({ value: 'EARLIER' }),
          server_seq: 2,
        }),
        evt({
          id: 'evt-latest',
          kind: 'target.cell.commit',
          parent_id: 'evt-create',
          payload: JSON.stringify({ value: 'LATEST' }),
          server_seq: 3,
        }),
      ],
    })
    await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/proj-1/rebuild-projection'),
      makeEnv(db),
    )
    const cells = (db as any)._tables().cells
    expect(cells).toHaveLength(1)
    expect(cells[0].value).toBe('LATEST')
    expect(cells[0].event_id).toBe('evt-latest')
  })

  it('cell_validators are written and cells.validated reflects the current chain head', async () => {
    const db = makeInMemoryD1({
      events: [
        evt({
          id: 'evt-create',
          kind: 'target.cell.create',
          parent_id: null,
          payload: JSON.stringify({ cellId: 'cell-1', value: 'hi' }),
          server_seq: 1,
        }),
        evt({
          id: 'evt-validate',
          kind: 'cell.validate',
          parent_id: 'evt-create',
          author: 'bob',
          payload: JSON.stringify({ editEventId: 'evt-create' }),
          server_seq: 2,
        }),
      ],
    })
    await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/proj-1/rebuild-projection'),
      makeEnv(db),
    )
    const tables = (db as any)._tables()
    expect(tables.cell_validators).toHaveLength(1)
    expect(tables.cell_validators[0].username).toBe('bob')
    // 0012: DELETE-on-unvalidate — a row's presence = active (no is_active column)
    expect(tables.cell_validators[0].event_id).toBeDefined()
    expect(tables.cells[0].validated).toBe(1)
  })

  it('returns 500 for an unknown event kind in the log', async () => {
    const db = makeInMemoryD1({
      events: [evt({
        id: 'evt-bad',
        kind: 'cell.future.unknown',
        parent_id: null,
        payload: '{}',
        server_seq: 1,
      })],
    })
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/proj-1/rebuild-projection'),
      makeEnv(db),
    ) as Response
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('unknown event kind')
  })
})
