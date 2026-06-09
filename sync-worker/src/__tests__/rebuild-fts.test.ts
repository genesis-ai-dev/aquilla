// Tests for handleRebuildFtsRequest.
//
// Uses the in-memory DB fake. The endpoint deletes stale FTS rows for the
// project then re-inserts from cells — idempotent and project-scoped.

import { describe, it, expect } from 'vitest'
import { handleRebuildFtsRequest } from '../events/rebuild-fts'
import { type CellRow } from './helpers/in-memory-db'
import { makeTestDb } from './helpers/pg-test-db'

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

function makeEnv(db?: AquillaDb, secret: string | undefined = 'shared-secret') {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: secret }
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
      { AQUILLA_PG: undefined, SYNC_SECRET_KEY: undefined },
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

  it('returns 500 when AQUILLA_PG is not bound', async () => {
    const res = await handleRebuildFtsRequest(
      makeRequest('/admin/projects/p1/rebuild-fts'),
      { SYNC_SECRET_KEY: 'shared-secret' },
    ) as Response
    expect(res.status).toBe(500)
  })
})

// ── No-op on Postgres (FTS auto-maintained by the value_tsv generated column) ─

describe('handleRebuildFtsRequest — no-op on Postgres', () => {
  it('returns ok with insertedRows=0 (nothing to rebuild)', async () => {
    const { db } = await makeTestDb({
      cells: [
        cell({ project_id: 'proj-A', cell_id: 'c1', value: 'alpha' }),
        cell({ project_id: 'proj-A', cell_id: 'c2', value: 'beta' }),
      ],
    })
    const res = (await handleRebuildFtsRequest(
      makeRequest('/admin/projects/proj-A/rebuild-fts'),
      makeEnv(db),
    )) as Response
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.insertedRows).toBe(0)
    expect(body.batches).toBe(0)
    expect(body.projectId).toBe('proj-A')
  })

  it('URL-decodes the projectId', async () => {
    const { db } = await makeTestDb()
    const res = (await handleRebuildFtsRequest(
      makeRequest('/admin/projects/proj%20A/rebuild-fts'),
      makeEnv(db),
    )) as Response
    const body = (await res.json()) as any
    expect(body.projectId).toBe('proj A')
  })

  it('FTS is searchable without any rebuild — value_tsv indexes on insert', async () => {
    const { db } = await makeTestDb({
      cells: [
        cell({ project_id: 'proj-A', cell_id: 'c1', value: 'the quick brown fox' }),
        cell({ project_id: 'proj-B', cell_id: 'c2', value: 'unrelated text' }),
      ],
    })
    // No rebuild-fts call — the generated column already indexed the rows.
    const m = await db
      .prepare("SELECT cell_id FROM cells WHERE project_id = ? AND value_tsv @@ plainto_tsquery('simple', ?)")
      .bind('proj-A', 'brown')
      .all()
    expect(m.results).toHaveLength(1)
  })
})
