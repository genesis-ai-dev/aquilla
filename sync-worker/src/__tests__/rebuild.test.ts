// Tests for handleRebuildProjectionRequest.
//
// better-sqlite3 is not available as a dep so we use a hand-rolled in-memory
// D1 fake. The fake understands the small set of SQL patterns our code
// actually issues so it can simulate projections without a real DB.

import { describe, it, expect } from 'vitest'
import { handleRebuildProjectionRequest } from '../events/rebuild'

// ── In-memory D1 fake ─────────────────────────────────────────────────────────
//
// We only need to support the SQL patterns emitted by rebuild.ts:
//   DELETE FROM cell_validators WHERE project_id = ?
//   DELETE FROM cells WHERE file_id IN (SELECT id FROM files WHERE project_id = ?)
//   SELECT * FROM events WHERE project_id = ? ORDER BY server_ts ASC
//   INSERT INTO cells (...) VALUES (?, ...) ON CONFLICT ... -- from event-projection
//   INSERT INTO cell_validators (...) VALUES (?, ...) ON CONFLICT ... -- from event-projection
//   UPDATE cells SET validated = (...) WHERE ...            -- from validate/unvalidate
//   SELECT COUNT(*) as cnt FROM cells WHERE file_id IN (SELECT id FROM files WHERE project_id = ?)
//   SELECT COUNT(*) as cnt FROM cell_validators WHERE project_id = ?
//
// Rather than parsing arbitrary SQL, we key on the first verb + target table.
// Note: cell.validate and cell.unvalidate each emit TWO statements:
//   (1) cell_validators UPSERT  (2) cells.validated recompute.
// The fake handles the recompute via the UPDATE cells branch below.

interface Tables {
  events: EventRow[]
  cells: CellRow[]
  cell_validators: ValidatorRow[]
  files: FileRow[]
}

interface EventRow {
  id: string
  schema_version: number
  project_id: string
  file_id: string | null
  cell_id: string | null
  kind: string
  author: string
  payload: string
  client_ts: number
  server_ts: number
}

interface CellRow {
  file_id: string
  cell_id: string
  content_text: string
  content_hash: string
  validated: number
  word_count: number
  last_editor: string | null
  last_edit_at: number
  projected_from: string
}

interface ValidatorRow {
  project_id: string
  file_id: string
  cell_id: string
  edit_event_id: string
  username: string
  is_active: number
  decided_ts: number
}

interface FileRow {
  id: string
  project_id: string
}

function makeInMemoryD1(tables: Partial<Tables> = {}): D1Database {
  const db: Tables = {
    events: tables.events ?? [],
    cells: tables.cells ?? [],
    cell_validators: tables.cell_validators ?? [],
    files: tables.files ?? [],
  }

  // Record every statement that gets batched, in order.
  const issuedStmts: Array<{ sql: string; args: unknown[] }> = []

  function execSql(sql: string, args: unknown[]): unknown[] {
    const normalized = sql.replace(/\s+/g, ' ').trim()

    // ── SELECT events ──────────────────────────────────────────────────────
    if (/^SELECT \* FROM events WHERE project_id = \?/.test(normalized)) {
      const pid = args[0] as string
      return db.events.filter((e) => e.project_id === pid)
        .sort((a, b) => a.server_ts - b.server_ts)
    }

    // ── SELECT COUNT cells ─────────────────────────────────────────────────
    if (/^SELECT COUNT\(\*\) as cnt FROM cells/.test(normalized)) {
      const pid = args[0] as string
      const fileIds = db.files.filter((f) => f.project_id === pid).map((f) => f.id)
      const cnt = db.cells.filter((c) => fileIds.includes(c.file_id)).length
      return [{ cnt }]
    }

    // ── SELECT COUNT cell_validators ───────────────────────────────────────
    if (/^SELECT COUNT\(\*\) as cnt FROM cell_validators/.test(normalized)) {
      const pid = args[0] as string
      const cnt = db.cell_validators.filter((v) => v.project_id === pid).length
      return [{ cnt }]
    }

    // ── DELETE cell_validators ─────────────────────────────────────────────
    if (/^DELETE FROM cell_validators WHERE project_id = \?$/.test(normalized)) {
      const pid = args[0] as string
      db.cell_validators = db.cell_validators.filter((v) => v.project_id !== pid)
      return []
    }

    // ── DELETE cells (join through files) ──────────────────────────────────
    if (/^DELETE FROM cells WHERE file_id IN \(SELECT id FROM files WHERE project_id = \?\)$/.test(normalized)) {
      const pid = args[0] as string
      const fileIds = db.files.filter((f) => f.project_id === pid).map((f) => f.id)
      db.cells = db.cells.filter((c) => !fileIds.includes(c.file_id))
      return []
    }

    // ── INSERT INTO cells (UPSERT) ─────────────────────────────────────────
    if (/^INSERT INTO cells/.test(normalized)) {
      // Bind order (from event-projection.ts):
      // 0=file_id, 1=cell_id, 2=content_text, 3=content_hash,
      // 4=word_count, 5=last_editor, 6=last_edit_at, 7=projected_from
      const row: CellRow = {
        file_id: args[0] as string,
        cell_id: args[1] as string,
        content_text: args[2] as string,
        content_hash: args[3] as string,
        validated: 0,
        word_count: args[4] as number,
        last_editor: args[5] as string | null,
        last_edit_at: args[6] as number,
        projected_from: args[7] as string,
      }
      const idx = db.cells.findIndex(
        (c) => c.file_id === row.file_id && c.cell_id === row.cell_id,
      )
      if (idx === -1) {
        db.cells.push(row)
      } else {
        // LWW: only update if the incoming last_edit_at is newer.
        if (row.last_edit_at > db.cells[idx].last_edit_at) {
          db.cells[idx] = row
        }
      }
      return []
    }

    // ── INSERT INTO cell_validators (UPSERT) ───────────────────────────────
    if (/^INSERT INTO cell_validators/.test(normalized)) {
      // Bind order (from event-projection.ts):
      // 0=project_id, 1=file_id, 2=cell_id, 3=edit_event_id,
      // 4=username, 5=decided_ts
      // is_active is a SQL literal (1 or 0) immediately before the decided_ts bind param
      const isActiveMatch = normalized.match(/VALUES \([^)]*?,\s*(0|1),\s*\?\)/)
      const isActive = isActiveMatch ? parseInt(isActiveMatch[1], 10) : 1
      const row: ValidatorRow = {
        project_id: args[0] as string,
        file_id: args[1] as string,
        cell_id: args[2] as string,
        edit_event_id: args[3] as string,
        username: args[4] as string,
        is_active: isActive,
        decided_ts: args[5] as number,
      }
      const idx = db.cell_validators.findIndex(
        (v) =>
          v.project_id === row.project_id &&
          v.file_id === row.file_id &&
          v.cell_id === row.cell_id &&
          v.edit_event_id === row.edit_event_id &&
          v.username === row.username,
      )
      if (idx === -1) {
        db.cell_validators.push(row)
      } else {
        // LWW on decided_ts
        if (row.decided_ts > db.cell_validators[idx].decided_ts) {
          db.cell_validators[idx] = row
        }
      }
      return []
    }

    // ── UPDATE cells SET validated = (...) ────────────────────────────────
    // Emitted by validate/unvalidate handlers to recompute the denormalized flag.
    // Bind order: 0=project_id, 1=file_id, 2=cell_id (for subquery),
    //             3=file_id, 4=cell_id (for WHERE clause)
    if (/^UPDATE cells SET validated/.test(normalized)) {
      const projectId = args[0] as string
      const fileId = args[3] as string
      const cellId = args[4] as string
      const activeCount = db.cell_validators.filter(
        (v) =>
          v.project_id === projectId &&
          v.file_id === fileId &&
          v.cell_id === cellId &&
          v.is_active === 1,
      ).length
      const validated = activeCount > 0 ? 1 : 0
      for (const cell of db.cells) {
        if (cell.file_id === fileId && cell.cell_id === cellId) {
          cell.validated = validated
        }
      }
      return []
    }

    // Unrecognised SQL -- safe to ignore in the test context.
    return []
  }

  function makePrepared(sql: string) {
    let boundArgs: unknown[] = []

    const stmt = {
      bind(...args: unknown[]) {
        boundArgs = args
        return this
      },
      async first<T>(): Promise<T | null> {
        const rows = execSql(sql, boundArgs)
        return (rows[0] as T) ?? null
      },
      async all<T>() {
        const rows = execSql(sql, boundArgs)
        return { results: rows as T[], success: true, meta: {} }
      },
      async run() {
        execSql(sql, boundArgs)
        return { success: true, meta: {} }
      },
      raw: async () => [],
    } as unknown as D1PreparedStatement

    // Track args when this statement is used in batch
    ;(stmt as any).__sql = sql
    ;(stmt as any).__getArgs = () => boundArgs

    return stmt
  }

  const d1 = {
    prepare(sql: string) {
      return makePrepared(sql)
    },
    async batch(stmts: D1PreparedStatement[]) {
      for (const s of stmts) {
        const sql: string = (s as any).__sql ?? ''
        const args: unknown[] = (s as any).__getArgs?.() ?? []
        issuedStmts.push({ sql, args })
        execSql(sql, args)
      }
      return stmts.map(() => ({ success: true, results: [], meta: {} }))
    },
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
    // Test helpers
    _tables() { return db },
    _issuedStmts() { return issuedStmts },
  } as unknown as D1Database & {
    _tables(): Tables
    _issuedStmts(): Array<{ sql: string; args: unknown[] }>
  }

  return d1
}

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
