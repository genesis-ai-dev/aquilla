// Shared in-memory D1 fake for sync-worker tests.
//
// Extracted from rebuild.test.ts so that rebuild tests, events-route tests,
// and any future tests that need a D1 stub all use the same implementation.
//
// Supported SQL patterns (keyed on first verb + target table):
//   SELECT * FROM events WHERE project_id = ?
//   SELECT COUNT(*) as cnt FROM cells ...
//   SELECT COUNT(*) as cnt FROM cell_validators ...
//   DELETE FROM cell_validators WHERE project_id = ?
//   DELETE FROM cells WHERE file_id IN (SELECT id FROM files WHERE project_id = ?)
//   INSERT INTO events (...) -- canonical event audit row
//   INSERT INTO cells (...) ON CONFLICT ... -- from event-projection
//   INSERT INTO cell_validators (...) ON CONFLICT ... -- from event-projection
//   UPDATE cells SET validated = (...) WHERE ... -- from validate/unvalidate

export interface Tables {
  events: EventRow[]
  cells: CellRow[]
  cell_validators: ValidatorRow[]
  files: FileRow[]
}

export interface EventRow {
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

export interface CellRow {
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

export interface ValidatorRow {
  project_id: string
  file_id: string
  cell_id: string
  edit_event_id: string
  username: string
  is_active: number
  decided_ts: number
}

export interface FileRow {
  id: string
  project_id: string
}

export type InMemoryD1 = D1Database & {
  _tables(): Tables
  _issuedStmts(): Array<{ sql: string; args: unknown[] }>
}

export function makeInMemoryD1(tables: Partial<Tables> = {}): InMemoryD1 {
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
      return db.events
        .filter((e) => e.project_id === pid)
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
    if (
      /^DELETE FROM cells WHERE file_id IN \(SELECT id FROM files WHERE project_id = \?\)$/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      const fileIds = db.files.filter((f) => f.project_id === pid).map((f) => f.id)
      db.cells = db.cells.filter((c) => !fileIds.includes(c.file_id))
      return []
    }

    // ── INSERT INTO events (canonical audit row) ───────────────────────────
    // Bind order (from cell-commit.ts):
    // 0=id, 1=schema_version, 2=project_id, 3=file_id, 4=cell_id,
    // 5=kind, 6=author, 7=payload (JSON), 8=client_ts, 9=server_ts
    // TODO: when Phase 2+ adds INSERT OR IGNORE INTO cell_validators, add a parallel branch above this one.
    if (/^INSERT OR IGNORE INTO events\s*\(/.test(normalized)) {
      const row: EventRow = {
        id: args[0] as string,
        schema_version: args[1] as number,
        project_id: args[2] as string,
        file_id: args[3] as string | null,
        cell_id: args[4] as string | null,
        kind: args[5] as string,
        author: args[6] as string,
        payload: args[7] as string,
        client_ts: args[8] as number,
        server_ts: args[9] as number,
      }
      // INSERT OR IGNORE: only insert if id not already present
      const exists = db.events.some((e) => e.id === row.id)
      if (!exists) {
        db.events.push(row)
      }
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
    _tables() {
      return db
    },
    _issuedStmts() {
      return issuedStmts
    },
  } as unknown as InMemoryD1

  return d1
}
