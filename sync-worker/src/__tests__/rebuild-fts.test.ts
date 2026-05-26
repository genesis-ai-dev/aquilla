// Tests for handleRebuildFtsRequest.
//
// Uses the in-memory D1 fake. The endpoint deletes stale FTS rows for the
// project then re-inserts from cells — idempotent and project-scoped.

import { describe, it, expect } from 'vitest'
import { handleRebuildFtsRequest } from '../events/rebuild-fts'
import { makeInMemoryD1, type CellRow } from './helpers/d1-fake'

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

function cell(overrides: Partial<CellRow> & Pick<CellRow, 'project_id' | 'cell_id'>): CellRow {
  return {
    file_id: 'file-a',
    side: 'target',
    value: 'hello world',
    event_id: 'evt-1',
    last_editor: null,
    last_edit_at: 0,
    validated: 0,
    word_count: 2,
    ...overrides,
  }
}

// ── URL / method / auth ─────────────────────────────────────────────────────

describe('handleRebuildFtsRequest — URL/method/auth', () => {
  it('returns null for non-matching URLs', async () => {
    const result = await handleRebuildFtsRequest(
      makeRequest('/admin/files/p/f', 'DELETE'),
      makeEnv(),
    )
    expect(result).toBeNull()
  })

  it('returns null for the projection-rebuild path (different endpoint)', async () => {
    const result = await handleRebuildFtsRequest(
      makeRequest('/admin/projects/p1/rebuild-projection', 'POST'),
      makeEnv(),
    )
    expect(result).toBeNull()
  })

  it('returns 405 for non-POST methods', async () => {
    const res = await handleRebuildFtsRequest(
      makeRequest('/admin/projects/p1/rebuild-fts', 'GET'),
      makeEnv(),
    ) as Response
    expect(res.status).toBe(405)
  })

  it('returns 500 when SYNC_SECRET_KEY is not configured', async () => {
    const res = await handleRebuildFtsRequest(
      makeRequest('/admin/projects/p1/rebuild-fts'),
      // Bypass makeEnv default to get a truly unconfigured env.
      { AQUILLA_DB: undefined, SYNC_SECRET_KEY: undefined },
    ) as Response
    expect(res.status).toBe(500)
  })

  it('returns 401 for a wrong bearer token', async () => {
    const res = await handleRebuildFtsRequest(
      makeRequest('/admin/projects/p1/rebuild-fts', 'POST', 'wrong'),
      makeEnv(undefined, 'right'),
    ) as Response
    expect(res.status).toBe(401)
  })

  it('returns 500 when AQUILLA_DB is not bound', async () => {
    const res = await handleRebuildFtsRequest(
      makeRequest('/admin/projects/p1/rebuild-fts'),
      { SYNC_SECRET_KEY: 'shared-secret' },
    ) as Response
    expect(res.status).toBe(500)
  })
})

// ── Core backfill behaviour ─────────────────────────────────────────────────

describe('handleRebuildFtsRequest — backfill', () => {
  it('returns insertedRows=5, batches=1 for 5 cells in a single project', async () => {
    const db = makeInMemoryD1({
      cells: [
        cell({ project_id: 'proj-A', cell_id: 'c1', value: 'alpha' }),
        cell({ project_id: 'proj-A', cell_id: 'c2', value: 'beta' }),
        cell({ project_id: 'proj-A', cell_id: 'c3', value: 'gamma' }),
        cell({ project_id: 'proj-A', cell_id: 'c4', value: 'delta' }),
        cell({ project_id: 'proj-A', cell_id: 'c5', value: 'epsilon' }),
      ],
    })

    const res = await handleRebuildFtsRequest(
      makeRequest('/admin/projects/proj-A/rebuild-fts'),
      makeEnv(db),
    ) as Response
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.insertedRows).toBe(5)
    expect(body.batches).toBe(1)
    expect(body.projectId).toBe('proj-A')
  })

  it('only indexes cells belonging to the requested project', async () => {
    const db = makeInMemoryD1({
      cells: [
        cell({ project_id: 'proj-A', cell_id: 'c1', value: 'aaa' }),
        cell({ project_id: 'proj-A', cell_id: 'c2', value: 'bbb' }),
        cell({ project_id: 'proj-B', cell_id: 'c3', value: 'ccc' }),
        cell({ project_id: 'proj-B', cell_id: 'c4', value: 'ddd' }),
        cell({ project_id: 'proj-B', cell_id: 'c5', value: 'eee' }),
      ],
    })

    const res = await handleRebuildFtsRequest(
      makeRequest('/admin/projects/proj-A/rebuild-fts'),
      makeEnv(db),
    ) as Response
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.insertedRows).toBe(2)

    // FTS table should only contain proj-A's cells.
    const ftsRows = db._tables().cells_fts
    expect(ftsRows).toHaveLength(2)
    expect(ftsRows.map((r) => r.value).sort()).toEqual(['aaa', 'bbb'])
  })

  it('is idempotent — re-running produces the same final state', async () => {
    const db = makeInMemoryD1({
      cells: [
        cell({ project_id: 'proj-A', cell_id: 'c1', value: 'hello' }),
        cell({ project_id: 'proj-A', cell_id: 'c2', value: 'world' }),
      ],
    })

    const req = () => makeRequest('/admin/projects/proj-A/rebuild-fts')
    const env = makeEnv(db)

    // First run.
    const res1 = await handleRebuildFtsRequest(req(), env) as Response
    expect(res1.status).toBe(200)
    const body1 = (await res1.json()) as any
    expect(body1.insertedRows).toBe(2)

    // Second run on the same DB — delete pass clears stale rows, insert pass
    // re-populates. Final FTS row count must still be 2, not 4.
    const res2 = await handleRebuildFtsRequest(req(), env) as Response
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as any
    expect(body2.insertedRows).toBe(2)

    const ftsRows = db._tables().cells_fts
    expect(ftsRows).toHaveLength(2)
  })

  it('returns deletedRows>0 on the second run (prior FTS rows cleared)', async () => {
    const db = makeInMemoryD1({
      cells: [
        cell({ project_id: 'proj-A', cell_id: 'c1', value: 'first' }),
      ],
    })

    const req = () => makeRequest('/admin/projects/proj-A/rebuild-fts')
    const env = makeEnv(db)

    await handleRebuildFtsRequest(req(), env)
    const res2 = await handleRebuildFtsRequest(req(), env) as Response
    const body2 = (await res2.json()) as any
    // The delete pass on the second run found 1 existing FTS row to delete.
    expect(body2.deletedRows).toBe(1)
    expect(body2.insertedRows).toBe(1)
  })

  it('returns ok with insertedRows=0 when the project has no cells', async () => {
    const db = makeInMemoryD1({ cells: [] })

    const res = await handleRebuildFtsRequest(
      makeRequest('/admin/projects/ghost/rebuild-fts'),
      makeEnv(db),
    ) as Response
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.insertedRows).toBe(0)
    expect(body.batches).toBe(0)
  })

  it('URL-decoded projectId is used for DB query', async () => {
    const db = makeInMemoryD1({
      cells: [
        cell({ project_id: 'proj A', cell_id: 'c1', value: 'test' }),
      ],
    })

    const res = await handleRebuildFtsRequest(
      makeRequest('/admin/projects/proj%20A/rebuild-fts'),
      makeEnv(db),
    ) as Response
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.projectId).toBe('proj A')
    expect(body.insertedRows).toBe(1)
  })
})
