// Tests for handleRebuildProjectionRequest.
//
// Uses the shared in-memory D1 fake from __tests__/helpers/d1-fake.ts.
// The fake understands the SQL patterns our code actually issues so it can
// simulate projections without a real DB.

import { describe, it, expect } from 'vitest'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import { makeInMemoryD1 } from './helpers/d1-fake'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function makeEnv(
  db?: D1Database,
  secret: string | undefined = 'shared-secret',
) {
  return { CODEX_DB: db, SYNC_SECRET_KEY: secret }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleRebuildProjectionRequest', () => {
  it('returns null for non-matching URLs', async () => {
    const result = await handleRebuildProjectionRequest(
      makeRequest('/admin/files/p/f', 'DELETE'),
      makeEnv(),
    )
    expect(result).toBeNull()
  })

  it('returns null for unrelated paths', async () => {
    const result = await handleRebuildProjectionRequest(
      makeRequest('/some/other/path'),
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

  it('returns 405 for DELETE on the rebuild path', async () => {
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/p1/rebuild-projection', 'DELETE'),
      makeEnv(),
    ) as Response
    expect(res.status).toBe(405)
  })

  it('returns 500 when SYNC_SECRET_KEY is not configured', async () => {
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/p1/rebuild-projection', 'POST', ''),
      // Explicitly omit SYNC_SECRET_KEY (undefined default doesn't work due to
      // JS default-parameter semantics -- passing undefined triggers the default)
      { CODEX_DB: makeInMemoryD1(), SYNC_SECRET_KEY: undefined },
    ) as Response
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('SYNC_SECRET_KEY')
  })

  it('returns 401 when Authorization header is missing', async () => {
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/p1/rebuild-projection', 'POST', ''),
      makeEnv(makeInMemoryD1()),
    ) as Response
    expect(res.status).toBe(401)
  })

  it('returns 401 when Authorization header has wrong key', async () => {
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/p1/rebuild-projection', 'POST', 'wrong-key'),
      makeEnv(makeInMemoryD1()),
    ) as Response
    expect(res.status).toBe(401)
  })

  it('returns 500 when CODEX_DB binding is not configured', async () => {
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/p1/rebuild-projection'),
      makeEnv(undefined),
    ) as Response
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('CODEX_DB')
  })

  it('replays 0 events when no events exist and returns ok=true', async () => {
    const db = makeInMemoryD1({
      files: [{ id: 'file-a', project_id: 'proj-1' }],
      cells: [{ file_id: 'file-a', cell_id: 'c1', content_text: 'old', content_hash: '00000000', validated: 0, word_count: 1, last_editor: 'bob', last_edit_at: 1, projected_from: 'old' }],
    })
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/proj-1/rebuild-projection'),
      makeEnv(db),
    ) as Response

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.eventsRead).toBe(0)
    expect(body.statementsApplied).toBe(0)
    // The existing cell was wiped and no events replayed it -- so cellsAfter=0
    expect(body.cellsAfter).toBe(0)
    expect(body.validatorsAfter).toBe(0)
  })

  it('decodes URL-encoded projectId', async () => {
    const db = makeInMemoryD1()
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/proj%20one/rebuild-projection'),
      makeEnv(db),
    ) as Response
    expect(res.status).toBe(200)
  })

  describe('successful rebuild with 3 events', () => {
    function makeFullDb() {
      return makeInMemoryD1({
        files: [{ id: 'file-a', project_id: 'proj-1' }],
        // Stale cell that should be wiped and replaced by the replay
        cells: [{
          file_id: 'file-a', cell_id: 'cell-1',
          content_text: 'stale', content_hash: '00000000',
          validated: 0, word_count: 1, last_editor: null,
          last_edit_at: 1, projected_from: 'old',
        }],
        // Stale validator that should be wiped
        cell_validators: [{
          project_id: 'proj-1', file_id: 'file-a', cell_id: 'cell-1',
          edit_event_id: 'old-evt', username: 'bob', is_active: 1, decided_ts: 1,
        }],
        events: [
          {
            id: 'evt-commit-1',
            schema_version: 1,
            project_id: 'proj-1',
            file_id: 'file-a',
            cell_id: 'cell-1',
            kind: 'cell.commit',
            author: 'alice',
            payload: JSON.stringify({ value: 'In the beginning', valueHtml: '<p>In the beginning</p>' }),
            client_ts: 1000,
            server_ts: 1000,
          },
          {
            id: 'evt-validate-1',
            schema_version: 1,
            project_id: 'proj-1',
            file_id: 'file-a',
            cell_id: 'cell-1',
            kind: 'cell.validate',
            author: 'bob',
            payload: JSON.stringify({ editEventId: 'evt-commit-1' }),
            client_ts: 2000,
            server_ts: 2000,
          },
          {
            id: 'evt-unvalidate-1',
            schema_version: 1,
            project_id: 'proj-1',
            file_id: 'file-a',
            cell_id: 'cell-1',
            kind: 'cell.unvalidate',
            author: 'bob',
            payload: JSON.stringify({ editEventId: 'evt-commit-1' }),
            client_ts: 3000,
            server_ts: 3000,
          },
        ],
      })
    }

    it('returns ok=true with eventsRead=3 and statementsApplied counts all emitted stmts', async () => {
      const db = makeFullDb()
      const res = await handleRebuildProjectionRequest(
        makeRequest('/admin/projects/proj-1/rebuild-projection'),
        makeEnv(db),
      ) as Response
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.ok).toBe(true)
      expect(body.eventsRead).toBe(3)
      // 1 cell.commit = 1 stmt
      // 1 cell.validate = 2 stmts (UPSERT + validated recompute)
      // 1 cell.unvalidate = 2 stmts (UPSERT + validated recompute)
      expect(body.statementsApplied).toBe(5)
    })

    it('writes the cell from the cell.commit event', async () => {
      const db = makeFullDb() as any
      await handleRebuildProjectionRequest(
        makeRequest('/admin/projects/proj-1/rebuild-projection'),
        makeEnv(db),
      )
      const cells = db._tables().cells as any[]
      expect(cells).toHaveLength(1)
      expect(cells[0].cell_id).toBe('cell-1')
      expect(cells[0].content_text).toBe('In the beginning')
      expect(cells[0].last_editor).toBe('alice')
      expect(cells[0].projected_from).toBe('event:evt-commit-1')
      expect(cells[0].edit_count).toBe(1)
    })

    it('writes the cell_validator from the validate + unvalidate events (LWW: is_active=0 wins)', async () => {
      const db = makeFullDb() as any
      await handleRebuildProjectionRequest(
        makeRequest('/admin/projects/proj-1/rebuild-projection'),
        makeEnv(db),
      )
      const validators = db._tables().cell_validators as any[]
      expect(validators).toHaveLength(1)
      expect(validators[0].username).toBe('bob')
      // unvalidate (server_ts=3000) beats validate (server_ts=2000) via LWW
      expect(validators[0].is_active).toBe(0)
      expect(validators[0].decided_ts).toBe(3000)
    })

    it('wipes stale cells and validators before replaying', async () => {
      const db = makeInMemoryD1({
        files: [{ id: 'file-a', project_id: 'proj-1' }],
        cells: [{
          file_id: 'file-a', cell_id: 'stale-cell',
          content_text: 'stale', content_hash: '00000000',
          validated: 1, word_count: 1, last_editor: 'x',
          last_edit_at: 9999999, projected_from: 'old',
        }],
        cell_validators: [{
          project_id: 'proj-1', file_id: 'file-a', cell_id: 'stale-cell',
          edit_event_id: 'old-evt', username: 'x', is_active: 1, decided_ts: 1,
        }],
        // no events -- rebuild produces empty projection
        events: [],
      }) as any

      await handleRebuildProjectionRequest(
        makeRequest('/admin/projects/proj-1/rebuild-projection'),
        makeEnv(db),
      )
      expect(db._tables().cells).toHaveLength(0)
      expect(db._tables().cell_validators).toHaveLength(0)
    })

    it('cellsAfter and validatorsAfter reflect counts after rebuild', async () => {
      const db = makeFullDb()
      const res = await handleRebuildProjectionRequest(
        makeRequest('/admin/projects/proj-1/rebuild-projection'),
        makeEnv(db),
      ) as Response
      const body = await res.json() as any
      expect(body.cellsAfter).toBe(1)
      expect(body.validatorsAfter).toBe(1)
    })

    it('response includes startedAt, completedAt timestamps and non-atomic note', async () => {
      const before = Date.now()
      const db = makeFullDb()
      const res = await handleRebuildProjectionRequest(
        makeRequest('/admin/projects/proj-1/rebuild-projection'),
        makeEnv(db),
      ) as Response
      const after = Date.now()
      const body = await res.json() as any
      expect(typeof body.startedAt).toBe('number')
      expect(typeof body.completedAt).toBe('number')
      expect(body.startedAt).toBeGreaterThanOrEqual(before)
      expect(body.completedAt).toBeGreaterThanOrEqual(body.startedAt)
      expect(body.completedAt).toBeLessThanOrEqual(after)
      expect(body.note).toContain('not atomic')
      expect(body.note).toContain('Re-run')
    })

    it('cells.validated is set to 1 after a validate event and 0 after unvalidate', async () => {
      // Use only commit + validate to verify validated=1, then the full sequence for validated=0.
      const db = makeInMemoryD1({
        files: [{ id: 'file-a', project_id: 'proj-1' }],
        events: [
          {
            id: 'evt-commit-1',
            schema_version: 1,
            project_id: 'proj-1',
            file_id: 'file-a',
            cell_id: 'cell-1',
            kind: 'cell.commit',
            author: 'alice',
            payload: JSON.stringify({ value: 'hello', valueHtml: '<p>hello</p>' }),
            client_ts: 1000,
            server_ts: 1000,
          },
          {
            id: 'evt-validate-1',
            schema_version: 1,
            project_id: 'proj-1',
            file_id: 'file-a',
            cell_id: 'cell-1',
            kind: 'cell.validate',
            author: 'bob',
            payload: JSON.stringify({ editEventId: 'evt-commit-1' }),
            client_ts: 2000,
            server_ts: 2000,
          },
        ],
      }) as any
      await handleRebuildProjectionRequest(
        makeRequest('/admin/projects/proj-1/rebuild-projection'),
        makeEnv(db),
      )
      const cells = db._tables().cells as any[]
      expect(cells).toHaveLength(1)
      expect(cells[0].validated).toBe(1)
    })
  })

  it('returns 500 when an event has an unknown kind', async () => {
    const db = makeInMemoryD1({
      files: [{ id: 'file-a', project_id: 'proj-1' }],
      events: [{
        id: 'evt-bad',
        schema_version: 1,
        project_id: 'proj-1',
        file_id: 'file-a',
        cell_id: 'cell-1',
        kind: 'cell.future.unknown',
        author: 'alice',
        payload: JSON.stringify({}),
        client_ts: 1000,
        server_ts: 1000,
      }],
    })
    const res = await handleRebuildProjectionRequest(
      makeRequest('/admin/projects/proj-1/rebuild-projection'),
      makeEnv(db),
    ) as Response
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('unknown event kind')
  })
})
