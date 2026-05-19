// Shared in-memory D1 fake for sync-worker tests.
//
// Recognizes the SQL patterns the events / cells code actually issues. SQL
// strings are normalized (collapse whitespace) before matching so a code
// change that only reformats SQL doesn't silently break the fake.

export interface Tables {
  events: EventRow[]
  cells: CellRow[]
  cell_validators: ValidatorRow[]
  files: FileRow[]
  /** AD-9: projects rows expose `source_project_id` for the stale-source
   *  route. The auth-worker side of the codebase owns this table; we
   *  model just the columns the sync-worker reads. */
  projects: ProjectRow[]
  /** Per-project settings JSON. Identity owns the writes; sync reads the
   *  blob for AD-13 / AD-14 tunables. We model just the columns we read. */
  project_settings: ProjectSettingsRow[]
}

export interface ProjectSettingsRow {
  project_id: string
  /** Raw JSON string as stored in D1 (no parsing done here — matches what
   *  the loader sees in production). */
  settings: string | null
  version?: number
}

export interface ProjectRow {
  id: string
  source_project_id: string | null
  name?: string
  archived_at?: string | null
}

export interface EventRow {
  id: string
  schema_version: number
  project_id: string
  file_id: string | null
  cell_id: string | null
  parent_id: string | null
  kind: string
  author: string
  payload: string
  client_ts: number
  server_ts: number
  server_seq: number
}

/**
 * New `cells` shape per AD-2 / AD-9 (spec 03-data-model §"Indicative schemas").
 * Composite PK is (project_id, file_id, cell_id).
 */
export interface CellRow {
  project_id: string
  file_id: string
  cell_id: string
  side: 'source' | 'target'
  value: string
  value_html?: string | null
  type?: string | null
  canonical_ref?: string | null
  anchor_cell_id?: string | null
  event_id: string
  source_event_id?: string | null
  last_editor: string | null
  last_edit_at: number
  validated: number
  endorsement_count?: number
  word_count: number
  content_hash?: string | null
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
  name?: string
  file_type?: string
  source_language?: string | null
  target_language?: string | null
  cell_count?: number
  approved_count?: number
  word_count?: number
  last_edit_at?: number | null
  projected_from?: string | null
  // Spec §"File" columns added in migration 0008.
  role?: string | null
  kind?: string | null
  book_code?: string | null
  source_file_id?: string | null
  anchor_file_id?: string | null
  r2_key?: string | null
  import_format?: string | null
  parser_version?: string | null
}

export type InMemoryD1 = D1Database & {
  _tables(): Tables
  _issuedStmts(): Array<{ sql: string; args: unknown[] }>
}

export function makeInMemoryD1(tables: Partial<Tables> = {}): InMemoryD1 {
  const db: Tables = {
    events: tables.events ?? [],
    cells: (tables.cells ?? []).map((cell) => ({
      ...cell,
      endorsement_count: cell.endorsement_count ?? 0,
    })),
    cell_validators: tables.cell_validators ?? [],
    files: tables.files ?? [],
    projects: tables.projects ?? [],
    project_settings: tables.project_settings ?? [],
  }

  const issuedStmts: Array<{ sql: string; args: unknown[] }> = []

  function findCell(projectId: string, fileId: string, cellId: string): CellRow | undefined {
    return db.cells.find(
      (c) => c.project_id === projectId && c.file_id === fileId && c.cell_id === cellId,
    )
  }

  /** Extract the quoted kinds from an `... AND kind IN ('a', 'b', ...) ...` clause. */
  function parseKindList(sql: string): Set<string> {
    const match = sql.match(/kind IN \(([^)]*)\)/)
    if (!match) return new Set()
    const set = new Set<string>()
    for (const part of match[1].split(',')) {
      const trimmed = part.trim()
      if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
        set.add(trimmed.slice(1, -1))
      }
    }
    return set
  }

  function execSql(sql: string, args: unknown[]): unknown[] {
    const normalized = sql.replace(/\s+/g, ' ').trim()

    // ── COUNT(*) cells (rebuild + diagnostics) ──────────────────────────
    if (/^SELECT COUNT\(\*\) as cnt FROM cells WHERE project_id = \?/.test(normalized)) {
      const pid = args[0] as string
      const cnt = db.cells.filter((c) => c.project_id === pid).length
      return [{ cnt }]
    }

    if (/^SELECT COUNT\(\*\) as cnt FROM cell_validators WHERE project_id = \?/.test(normalized)) {
      const pid = args[0] as string
      const cnt = db.cell_validators.filter((v) => v.project_id === pid).length
      return [{ cnt }]
    }

    // ── COALESCE(MAX(server_seq), 0) + 1 — next-seq assignment ──────────
    if (/^SELECT COALESCE\(MAX\(server_seq\), 0\) \+ 1 AS next_seq FROM events WHERE project_id = \?$/.test(normalized)) {
      const pid = args[0] as string
      let max = 0
      for (const e of db.events) {
        if (e.project_id === pid && e.server_seq > max) max = e.server_seq
      }
      return [{ next_seq: max + 1 }]
    }

    // ── AD-2 first-child-of-parent lookup ───────────────────────────────
    // SQL filters by chain-mutating kinds (see event-projection.ts
    // CHAIN_MUTATING_KINDS). The fake extracts the kinds from the IN(...)
    // clause to keep itself in sync with the source.
    if (
	      /^SELECT id, server_seq FROM events WHERE project_id = \? AND file_id = \? AND cell_id = \? AND parent_id IS NULL AND kind IN \([^)]*\) AND kind LIKE \? ORDER BY server_seq ASC, id ASC LIMIT 1$/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      const fid = args[1] as string
	      const cid = args[2] as string
	      const sideLike = args[3] as string
	      const kinds = parseKindList(normalized)
	      const matches = db.events
	        .filter((e) => e.project_id === pid && e.file_id === fid && e.cell_id === cid && e.parent_id === null && kinds.has(e.kind) && e.kind.startsWith(sideLike.replace('%', '')))
        .sort((a, b) => (a.server_seq - b.server_seq) || a.id.localeCompare(b.id))
      return matches.length ? [{ id: matches[0].id, server_seq: matches[0].server_seq }] : []
    }
    if (
	      /^SELECT id, server_seq FROM events WHERE project_id = \? AND file_id = \? AND cell_id = \? AND parent_id = \? AND kind IN \([^)]*\) AND kind LIKE \? ORDER BY server_seq ASC, id ASC LIMIT 1$/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      const fid = args[1] as string
      const cid = args[2] as string
	      const parent = args[3] as string
	      const sideLike = args[4] as string
	      const kinds = parseKindList(normalized)
	      const matches = db.events
	        .filter((e) => e.project_id === pid && e.file_id === fid && e.cell_id === cid && e.parent_id === parent && kinds.has(e.kind) && e.kind.startsWith(sideLike.replace('%', '')))
        .sort((a, b) => (a.server_seq - b.server_seq) || a.id.localeCompare(b.id))
      return matches.length ? [{ id: matches[0].id, server_seq: matches[0].server_seq }] : []
    }

    // ── Idempotency probe: existing event row ───────────────────────────
    if (/^SELECT server_ts, server_seq FROM events WHERE id = \?$/.test(normalized)) {
      const id = args[0] as string
      const row = db.events.find((e) => e.id === id)
      return row ? [{ server_ts: row.server_ts, server_seq: row.server_seq }] : []
    }

    // ── GET /events read route ──────────────────────────────────────────
    if (/^SELECT id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq FROM events/.test(normalized)) {
      // Two variants: rebuild (ASC) and read-route (DESC, with optional cell/before/limit).
      const isAsc = /ORDER BY server_seq ASC/.test(normalized)
      const projectIdIdx = 0
      const fileIdIdx = isAsc ? 1 : 1
      const pid = args[projectIdIdx] as string
      const fid = args[fileIdIdx] as string | undefined

      let rows = db.events.filter((e) => e.project_id === pid)
      if (typeof fid === 'string') rows = rows.filter((e) => e.file_id === fid)

      if (isAsc) {
        return rows.sort((a, b) => (a.server_seq - b.server_seq) || (a.server_ts - b.server_ts) || a.id.localeCompare(b.id))
      }

      // DESC = read-route
      let i = 2
      if (normalized.includes('AND cell_id = ?')) {
        const cellId = args[i++] as string
        rows = rows.filter((e) => e.cell_id === cellId)
      }
      if (normalized.includes('AND server_seq < ?')) {
        const before = args[i++] as number
        rows = rows.filter((e) => e.server_seq < before)
      }
      const limit = args[i] as number
      rows = rows.sort((a, b) => b.server_seq - a.server_seq).slice(0, limit)
      return rows
    }

    // ── GET cell history read route ─────────────────────────────────────
    // SELECT id, parent_id, kind, author, payload, client_ts, server_ts, server_seq
    //   FROM events
    //  WHERE project_id = ? AND file_id = ? AND cell_id = ?
    //  ORDER BY server_seq DESC, id DESC
    //  LIMIT ?
    if (
      /^SELECT id, parent_id, kind, author, payload, client_ts, server_ts, server_seq FROM events WHERE project_id = \? AND file_id = \? AND cell_id = \? ORDER BY server_seq DESC, id DESC LIMIT \?$/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      const fid = args[1] as string
      const cid = args[2] as string
      const limit = args[3] as number
      return db.events
        .filter((e) => e.project_id === pid && e.file_id === fid && e.cell_id === cid)
        .sort((a, b) => (b.server_seq - a.server_seq) || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map((e) => ({
          id: e.id,
          parent_id: e.parent_id,
          kind: e.kind,
          author: e.author,
          payload: e.payload,
          client_ts: e.client_ts,
          server_ts: e.server_ts,
          server_seq: e.server_seq,
        }))
    }

    // ── GET /api/v1/projects/:projectId/search ─────────────────────────
    // The route's SQL is multi-line; after whitespace-collapse:
    //   SELECT cells.cell_id AS cell_id, cells.file_id AS file_id,
    //          cells.side AS side, cells.value AS value,
    //          snippet(cells_fts, ...) AS snippet, cells_fts.rank AS rank
    //     FROM cells_fts
    //     JOIN cells ON cells.rowid = cells_fts.rowid
    //    WHERE cells_fts MATCH ? AND cells.project_id = ?
    //      [AND cells.side = ?]
    //    ORDER BY rank ASC LIMIT ?
    //
    // We model the FTS5 query as a naive substring match against the
    // sanitized FTS query (which is a quoted-tokens string like '"foo" "bar"').
    // Tests can assert on the result set ordering / filtering without us
    // needing to reproduce FTS5 ranking.
    if (
      /^SELECT cells\.cell_id AS cell_id, cells\.file_id AS file_id, cells\.side AS side, cells\.value AS value, snippet\(cells_fts, 0, '<mark>', '<\/mark>', '\.\.\.', 16\) AS snippet, cells_fts\.rank AS rank FROM cells_fts JOIN cells ON cells\.rowid = cells_fts\.rowid WHERE cells_fts MATCH \? AND cells\.project_id = \?/.test(
        normalized,
      )
    ) {
      const ftsQuery = args[0] as string
      const pid = args[1] as string
      const hasSide = normalized.includes("AND cells.side = ?")
      const side = hasSide ? (args[2] as string) : null
      const limit = args[hasSide ? 3 : 2] as number

      // Parse out the quoted tokens.
      const tokens = (ftsQuery.match(/"[^"]+"/g) ?? []).map((t) =>
        t.slice(1, -1).toLowerCase(),
      )

      const matched = db.cells
        .filter((c) => c.project_id === pid)
        .filter((c) => side === null || c.side === side)
        .filter((c) => {
          if (tokens.length === 0) return false
          const v = c.value.toLowerCase()
          return tokens.every((t) => v.includes(t))
        })
        .map((c, idx) => ({
          cell_id: c.cell_id,
          file_id: c.file_id,
          side: c.side,
          value: c.value,
          snippet: c.value,
          // Fake "rank" — lower is better. Use the iteration index so the
          // first inserted matching cell sorts first in tests.
          rank: idx,
        }))
        .slice(0, limit)
      return matched
    }

    // ── GET /cell-validators read route ─────────────────────────────────
    if (
      /^SELECT edit_event_id, username, is_active, decided_ts FROM cell_validators WHERE project_id = \? AND file_id = \? AND cell_id = \? ORDER BY decided_ts DESC/.test(
        normalized,
      )
    ) {
      const projectId = args[0] as string
      const fileId = args[1] as string
      const cellId = args[2] as string
      return db.cell_validators
        .filter((v) => v.project_id === projectId && v.file_id === fileId && v.cell_id === cellId)
        .sort((a, b) => b.decided_ts - a.decided_ts)
        .map((v) => ({
          edit_event_id: v.edit_event_id,
          username: v.username,
          is_active: v.is_active,
          decided_ts: v.decided_ts,
        }))
    }

    // ── GET /cells/audit-stats — cells select ──────────────────────────
    if (
      /SELECT cell_id, side, content_hash, last_edit_at, event_id\s+AS last_edit_event_id, source_event_id FROM cells WHERE project_id = \? AND file_id = \?/.test(
        normalized,
      )
    ) {
      const projectId = args[0] as string
      const fileId = args[1] as string
      return db.cells
        .filter((c) => c.project_id === projectId && c.file_id === fileId)
        .map((c) => ({
          cell_id: c.cell_id,
          side: c.side,
          content_hash: c.content_hash ?? null,
          last_edit_at: c.last_edit_at,
          last_edit_event_id: c.event_id,
          source_event_id: c.source_event_id ?? null,
        }))
    }

    // ── GET /cells/audit-stats — validators select ─────────────────────
    if (
      /^SELECT cell_id, edit_event_id, username FROM cell_validators WHERE project_id = \? AND file_id = \? AND is_active = 1$/.test(
        normalized,
      )
    ) {
      const projectId = args[0] as string
      const fileId = args[1] as string
      return db.cell_validators
        .filter((v) => v.project_id === projectId && v.file_id === fileId && v.is_active === 1)
        .map((v) => ({
          cell_id: v.cell_id,
          edit_event_id: v.edit_event_id,
          username: v.username,
        }))
    }

    // ── GET /api/v1/projects/:projectId/files (list) ──────────────────
    if (
      /^SELECT id, project_id, name, file_type, source_language, target_language, cell_count, approved_count, word_count, last_edit_at FROM files WHERE project_id = \? ORDER BY/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      return db.files
        .filter((f) => f.project_id === pid)
        .map((f) => ({
          id: f.id,
          project_id: f.project_id,
          name: f.name ?? "",
          file_type: f.file_type ?? "",
          source_language: f.source_language ?? null,
          target_language: f.target_language ?? null,
          cell_count: f.cell_count ?? 0,
          approved_count: f.approved_count ?? 0,
          word_count: f.word_count ?? 0,
          last_edit_at: f.last_edit_at ?? null,
        }))
        .sort((a, b) => {
          const aEdit = a.last_edit_at
          const bEdit = b.last_edit_at
          if (aEdit !== null && bEdit !== null) return bEdit - aEdit
          if (aEdit === null && bEdit !== null) return 1
          if (aEdit !== null && bEdit === null) return -1
          return a.name.localeCompare(b.name)
        })
    }

    // ── GET /api/v1/projects/:projectId/files/:fileId (single) ────────
    if (
      /^SELECT id, project_id, name, file_type, source_language, target_language, cell_count, approved_count, word_count, last_edit_at FROM files WHERE project_id = \? AND id = \?$/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      const fid = args[1] as string
      const f = db.files.find((row) => row.project_id === pid && row.id === fid)
      if (!f) return []
      return [
        {
          id: f.id,
          project_id: f.project_id,
          name: f.name ?? "",
          file_type: f.file_type ?? "",
          source_language: f.source_language ?? null,
          target_language: f.target_language ?? null,
          cell_count: f.cell_count ?? 0,
          approved_count: f.approved_count ?? 0,
          word_count: f.word_count ?? 0,
          last_edit_at: f.last_edit_at ?? null,
        },
      ]
    }

    // ── GET /api/v1/projects/:projectId/files/:fileId/cells ────────────
    if (
      /^SELECT p\.source_project_id AS source_project_id, f\.source_file_id AS source_file_id FROM projects p LEFT JOIN files f ON f\.project_id = p\.id AND f\.id = \? WHERE p\.id = \?$/.test(
        normalized,
      )
    ) {
      const fileId = args[0] as string
      const projectId = args[1] as string
      const project = db.projects.find((p) => p.id === projectId)
      const file = db.files.find((f) => f.project_id === projectId && f.id === fileId)
      return project
        ? [{
            source_project_id: project.source_project_id,
            source_file_id: file?.source_file_id ?? null,
          }]
        : []
    }
    if (
      /^SELECT cell_id, side, value, value_html, type, canonical_ref, anchor_cell_id, event_id, source_event_id, last_editor, last_edit_at, validated, endorsement_count, word_count FROM cells WHERE project_id = \? AND file_id = \?/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      const fid = args[1] as string
      const hasSide = normalized.includes("AND side = ?")
      const side = hasSide ? (args[2] as string) : null
      return db.cells
        .filter(
          (c) =>
            c.project_id === pid &&
            c.file_id === fid &&
            (side === null || c.side === side),
        )
        .map((c) => ({
          cell_id: c.cell_id,
          side: c.side,
          value: c.value,
          value_html: c.value_html ?? null,
          type: c.type ?? null,
          canonical_ref: c.canonical_ref ?? null,
          anchor_cell_id: c.anchor_cell_id ?? null,
          event_id: c.event_id,
          source_event_id: c.source_event_id ?? null,
	          last_editor: c.last_editor,
	          last_edit_at: c.last_edit_at,
	          validated: c.validated,
	          endorsement_count: c.endorsement_count ?? 0,
	          word_count: c.word_count,
	        }))
	    }

    // ── Rebuild DELETE ─────────────────────────────────────────────────
    if (/^DELETE FROM cell_validators WHERE project_id = \?$/.test(normalized)) {
      const pid = args[0] as string
      db.cell_validators = db.cell_validators.filter((v) => v.project_id !== pid)
      return []
    }
    if (/^DELETE FROM cells WHERE project_id = \?$/.test(normalized)) {
      const pid = args[0] as string
      db.cells = db.cells.filter((c) => c.project_id !== pid)
      return []
    }

    // ── Single-cell DELETE (source.cell.delete / target.cell.delete) ────
	    if (/^DELETE FROM cells WHERE project_id = \? AND file_id = \? AND cell_id = \?$/.test(normalized)) {
	      const pid = args[0] as string
      const fid = args[1] as string
      const cid = args[2] as string
      db.cells = db.cells.filter(
        (c) => !(c.project_id === pid && c.file_id === fid && c.cell_id === cid),
      )
      return []
    }

    // ── INSERT events (canonical audit row) ────────────────────────────
    // Bind order from handlers/cell-events.ts and file-create.ts:
	    //   0=id, 1=schema_version, 2=project_id, 3=file_id, 4=cell_id,
	    //   5=parent_id, 6=kind, 7=author, 8=payload, 9=client_ts,
	    //   10=server_ts, 11=server_seq
	    if (
	      /^INSERT OR IGNORE INTO events \( id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq \) VALUES \(\?, 1, \?, \?, \?, NULL, 'cell\.endorsement'/.test(
	        normalized,
	      )
	    ) {
	      const row: EventRow = {
	        id: args[0] as string,
	        schema_version: 1,
	        project_id: args[1] as string,
	        file_id: args[2] as string | null,
	        cell_id: args[3] as string | null,
	        parent_id: null,
	        kind: 'cell.endorsement',
	        author: args[4] as string,
	        payload: args[5] as string,
	        client_ts: args[6] as number,
	        server_ts: args[7] as number,
	        server_seq: args[8] as number,
	      }
	      if (!db.events.some((e) => e.id === row.id)) db.events.push(row)
	      return []
	    }

	    // ── AD-14 validation endorsement prelude ───────────────────────────
	    if (
	      /^SELECT event_id FROM cells WHERE project_id = \? AND file_id = \? AND cell_id = \? AND side = 'target'$/.test(
	        normalized,
	      )
	    ) {
	      const cell = db.cells.find(
	        (c) =>
	          c.project_id === args[0] &&
	          c.file_id === args[1] &&
	          c.cell_id === args[2] &&
	          c.side === 'target',
	      )
	      return cell ? [{ event_id: cell.event_id }] : []
	    }

	    if (
	      /^SELECT e\.id FROM events e WHERE e\.project_id = \? AND e\.kind = 'cell\.endorsement'/.test(
	        normalized,
	      )
	    ) {
	      const projectId = args[0] as string
	      const endorsingCellId = args[1] as string
	      const validatorUserId = args[2] as number
	      return db.events
	        .filter((event) => {
	          if (event.project_id !== projectId || event.kind !== 'cell.endorsement') {
	            return false
	          }
	          const payload = JSON.parse(event.payload) as {
	            endorsingCellId?: string
	            validatorUserId?: number
	          }
	          if (
	            payload.endorsingCellId !== endorsingCellId ||
	            payload.validatorUserId !== validatorUserId
	          ) {
	            return false
	          }
	          return !db.events.some((rev) => {
	            if (
	              rev.project_id !== projectId ||
	              rev.kind !== 'cell.endorsement.revoke'
	            ) {
	              return false
	            }
	            const revPayload = JSON.parse(rev.payload) as {
	              endorsementEventId?: string
	            }
	            return revPayload.endorsementEventId === event.id
	          })
	        })
	        .sort((a, b) => a.server_seq - b.server_seq)
	        .map((event) => ({ id: event.id }))
	    }
	    if (
	      /^INSERT OR IGNORE INTO events \( id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq \) VALUES \(\?, 1, \?, \?, \?, NULL, 'cell\.endorsement\.revoke'/.test(
	        normalized,
	      )
	    ) {
	      const row: EventRow = {
	        id: args[0] as string,
	        schema_version: 1,
	        project_id: args[1] as string,
	        file_id: args[2] as string | null,
	        cell_id: args[3] as string | null,
	        parent_id: null,
	        kind: 'cell.endorsement.revoke',
	        author: args[4] as string,
	        payload: args[5] as string,
	        client_ts: args[6] as number,
	        server_ts: args[7] as number,
	        server_seq: args[8] as number,
	      }
	      if (!db.events.some((e) => e.id === row.id)) db.events.push(row)
	      return []
	    }
	    if (/^INSERT OR IGNORE INTO events\s*\(/.test(normalized)) {
      const row: EventRow = {
        id: args[0] as string,
        schema_version: args[1] as number,
        project_id: args[2] as string,
        file_id: args[3] as string | null,
        cell_id: args[4] as string | null,
        parent_id: args[5] as string | null,
        kind: args[6] as string,
        author: args[7] as string,
        payload: args[8] as string,
        client_ts: args[9] as number,
        server_ts: args[10] as number,
        server_seq: args[11] as number,
      }
      const exists = db.events.some((e) => e.id === row.id)
      if (!exists) db.events.push(row)
      return []
    }

    // ── INSERT cells (cell create handlers) ─────────────────────────────
	    if (/^INSERT INTO cells \(\s*project_id, file_id, cell_id, side, value, value_html, type, canonical_ref, anchor_cell_id, event_id, source_event_id, last_editor, last_edit_at, validated, word_count, content_hash\s*\)/.test(
      normalized,
    )) {
      const row: CellRow = {
        project_id: args[0] as string,
        file_id: args[1] as string,
        cell_id: args[2] as string,
        side: args[3] as 'source' | 'target',
        value: args[4] as string,
        value_html: args[5] as string | null,
        type: args[6] as string | null,
        canonical_ref: args[7] as string | null,
        anchor_cell_id: args[8] as string | null,
        event_id: args[9] as string,
        source_event_id: null,
        last_editor: args[10] as string | null,
        last_edit_at: args[11] as number,
        validated: 0,
        endorsement_count: 0,
        word_count: args[12] as number,
        content_hash: args[13] as string | null,
      }
      const existing = findCell(row.project_id, row.file_id, row.cell_id)
      if (!existing) {
        db.cells.push(row)
      } else {
        // ON CONFLICT clause from the SQL — overwrite the value-level
        // fields; reset source_event_id to NULL (create is genesis).
        existing.side = row.side
        existing.value = row.value
        existing.value_html = row.value_html
        existing.type = row.type
        existing.canonical_ref = row.canonical_ref
        existing.anchor_cell_id = row.anchor_cell_id
        existing.event_id = row.event_id
        existing.source_event_id = null
        existing.last_editor = row.last_editor
        existing.last_edit_at = row.last_edit_at
        existing.word_count = row.word_count
        existing.content_hash = row.content_hash
      }
      return []
    }

    // ── UPDATE cells (target.cell.commit) ───────────────────────────────
    if (/^UPDATE cells SET value = \?, value_html = \?, event_id = \?, source_event_id = \?, last_editor = \?, last_edit_at = \?, word_count = \?, content_hash = \?, validated = 0 WHERE project_id = \? AND file_id = \? AND cell_id = \?$/.test(
      normalized,
    )) {
      const value = args[0] as string
      const valueHtml = args[1] as string | null
      const eventId = args[2] as string
      const sourceEventId = args[3] as string | null
      const lastEditor = args[4] as string | null
      const lastEditAt = args[5] as number
      const wordCount = args[6] as number
      const contentHash = args[7] as string | null
      const projectId = args[8] as string
      const fileId = args[9] as string
      const cellId = args[10] as string
      const cell = findCell(projectId, fileId, cellId)
      if (cell) {
        cell.value = value
        cell.value_html = valueHtml
        cell.event_id = eventId
        cell.source_event_id = sourceEventId
        cell.last_editor = lastEditor
        cell.last_edit_at = lastEditAt
        cell.word_count = wordCount
        cell.content_hash = contentHash
        cell.validated = 0
      }
      return []
    }

    // ── UPDATE cells (source.cell.commit) ───────────────────────────────
    if (/^UPDATE cells SET value = \?, value_html = \?, event_id = \?, last_editor = \?, last_edit_at = \?, word_count = \?, content_hash = \? WHERE project_id = \? AND file_id = \? AND cell_id = \?$/.test(
      normalized,
    )) {
      const value = args[0] as string
      const valueHtml = args[1] as string | null
      const eventId = args[2] as string
      const lastEditor = args[3] as string | null
      const lastEditAt = args[4] as number
      const wordCount = args[5] as number
      const contentHash = args[6] as string | null
      const projectId = args[7] as string
      const fileId = args[8] as string
      const cellId = args[9] as string
      const cell = findCell(projectId, fileId, cellId)
      if (cell) {
        cell.value = value
        cell.value_html = valueHtml
        cell.event_id = eventId
        cell.last_editor = lastEditor
        cell.last_edit_at = lastEditAt
        cell.word_count = wordCount
        cell.content_hash = contentHash
      }
      return []
    }

    // ── UPDATE cells (reorder) ──────────────────────────────────────────
    if (/^UPDATE cells SET anchor_cell_id = \?, event_id = \?, last_editor = \?, last_edit_at = \? WHERE project_id = \? AND file_id = \? AND cell_id = \?$/.test(
      normalized,
    )) {
      const anchor = args[0] as string | null
      const eventId = args[1] as string
      const lastEditor = args[2] as string | null
      const lastEditAt = args[3] as number
      const projectId = args[4] as string
      const fileId = args[5] as string
      const cellId = args[6] as string
      const cell = findCell(projectId, fileId, cellId)
      if (cell) {
        cell.anchor_cell_id = anchor
        cell.event_id = eventId
        cell.last_editor = lastEditor
        cell.last_edit_at = lastEditAt
      }
      return []
    }

    // ── INSERT files (UPSERT from file.create handler) ───────────────────
    // Spec §"File" added 8 spec metadata columns after `projected_from`
    // (`role, kind, book_code, source_file_id, anchor_file_id, r2_key,
    // import_format, parser_version`). The pre-spec shape is kept matching
    // too (older handlers / tests may still emit it) — branched on whether
    // 8 extra `?` placeholders trail the timestamp expression.
    if (
      /^INSERT INTO files \([^)]*\) VALUES \(\?, \?, \?, \?, \?, \?, 0, 0, 0, NULL, \?, unixepoch\('now'\) \* 1000, \?, \?, \?, \?, \?, \?, \?, \?\)/.test(
        normalized,
      )
    ) {
      const row: FileRow = {
        id: args[0] as string,
        project_id: args[1] as string,
        name: args[2] as string,
        file_type: args[3] as string,
        source_language: args[4] as string | null,
        target_language: args[5] as string | null,
        cell_count: 0,
        approved_count: 0,
        word_count: 0,
        last_edit_at: null,
        projected_from: args[6] as string,
        role: args[7] as string | null,
        kind: args[8] as string | null,
        book_code: args[9] as string | null,
        source_file_id: args[10] as string | null,
        anchor_file_id: args[11] as string | null,
        r2_key: args[12] as string | null,
        import_format: args[13] as string | null,
        parser_version: args[14] as string | null,
      }
      const idx = db.files.findIndex((f) => f.id === row.id)
      if (idx === -1) {
        db.files.push(row)
      } else {
        db.files[idx] = {
          ...db.files[idx],
          name: row.name,
          file_type: row.file_type,
          source_language: row.source_language,
          target_language: row.target_language,
          role: row.role,
          kind: row.kind,
          book_code: row.book_code,
          source_file_id: row.source_file_id,
          anchor_file_id: row.anchor_file_id,
          r2_key: row.r2_key,
          import_format: row.import_format,
          parser_version: row.parser_version,
        }
      }
      return []
    }

    // ── INSERT files (UPSERT — pre-spec shape kept for older emitters) ──
    if (
      /^INSERT INTO files \([^)]*\) VALUES \(\?, \?, \?, \?, \?, \?, 0, 0, 0, NULL, \?, unixepoch\('now'\) \* 1000\)/.test(
        normalized,
      )
    ) {
      const row: FileRow = {
        id: args[0] as string,
        project_id: args[1] as string,
        name: args[2] as string,
        file_type: args[3] as string,
        source_language: args[4] as string | null,
        target_language: args[5] as string | null,
        cell_count: 0,
        approved_count: 0,
        word_count: 0,
        last_edit_at: null,
        projected_from: args[6] as string,
      }
      const idx = db.files.findIndex((f) => f.id === row.id)
      if (idx === -1) {
        db.files.push(row)
      } else {
        db.files[idx] = {
          ...db.files[idx],
          name: row.name,
          file_type: row.file_type,
          source_language: row.source_language,
          target_language: row.target_language,
        }
      }
      return []
    }

    // ── INSERT files (writeProjection rollup) ──────────────────────────
    if (
      /^INSERT INTO files \([^)]*\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, unixepoch\('now'\) \* 1000\)/.test(
        normalized,
      )
    ) {
      const row: FileRow = {
        id: args[0] as string,
        project_id: args[1] as string,
        name: args[2] as string,
        file_type: args[3] as string,
        source_language: args[4] as string | null,
        target_language: args[5] as string | null,
        cell_count: args[6] as number,
        approved_count: args[7] as number,
        word_count: args[8] as number,
        last_edit_at: args[9] as number | null,
        projected_from: args[10] as string,
      }
      const idx = db.files.findIndex((f) => f.id === row.id)
      if (idx === -1) {
        db.files.push(row)
      } else {
        db.files[idx] = { ...db.files[idx], ...row }
      }
      return []
    }

    // ── INSERT cell_validators (UPSERT) ────────────────────────────────
    if (/^INSERT INTO cell_validators/.test(normalized)) {
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
      } else if (row.decided_ts > db.cell_validators[idx].decided_ts) {
        db.cell_validators[idx] = row
      }
      return []
    }

    // ── GET projects.source_project_id (stale-source route prelude) ────
    if (/^SELECT source_project_id FROM projects WHERE id = \?$/.test(normalized)) {
      const id = args[0] as string
      const project = db.projects.find((p) => p.id === id)
      return project ? [{ source_project_id: project.source_project_id }] : []
    }

    // ── AD-9 stale-source JOIN ─────────────────────────────────────────
    // Bind order: 0=upstream_or_null, 1=project_id, 2=file_id.
    // Whitespace-collapsed, the route's SQL becomes:
    //   SELECT t.cell_id AS cell_id FROM cells t JOIN cells s
    //     ON s.project_id = COALESCE(?, t.project_id) AND s.cell_id = t.cell_id
    //    AND s.side = 'source'
    //   WHERE t.project_id = ? AND t.file_id = ? AND t.side = 'target'
    //     AND t.source_event_id IS NOT NULL AND s.event_id != t.source_event_id
    if (
      /^SELECT t\.cell_id AS cell_id FROM cells t JOIN cells s ON s\.project_id = COALESCE\(\?, t\.project_id\) AND s\.cell_id = t\.cell_id AND s\.side = 'source' WHERE t\.project_id = \? AND t\.file_id = \? AND t\.side = 'target' AND t\.source_event_id IS NOT NULL AND s\.event_id != t\.source_event_id$/.test(
        normalized,
      )
    ) {
      const upstreamArg = args[0] as string | null
      const projectId = args[1] as string
      const fileId = args[2] as string
      const sourceProjectId = upstreamArg ?? projectId
      const stale: Array<{ cell_id: string }> = []
      for (const t of db.cells) {
        if (
          t.project_id === projectId &&
          t.file_id === fileId &&
          t.side === "target" &&
          t.source_event_id != null
        ) {
          const sourceRow = db.cells.find(
            (s) =>
              s.project_id === sourceProjectId &&
              s.cell_id === t.cell_id &&
              s.side === "source",
          )
          if (sourceRow && sourceRow.event_id !== t.source_event_id) {
            stale.push({ cell_id: t.cell_id })
          }
        }
      }
      return stale
    }

    // ── AD-13 cache: max source event_id for a project ─────────────────
    // `SELECT MAX(event_id) AS max_id FROM cells WHERE project_id = ? AND side = 'source'`
    if (
      /^SELECT MAX\(event_id\) AS max_id FROM cells WHERE project_id = \? AND side = 'source'$/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      let max: string | null = null
      for (const c of db.cells) {
        if (c.project_id !== pid) continue
        if (c.side !== "source") continue
        if (max === null || c.event_id > max) max = c.event_id
      }
      return [{ max_id: max }]
    }

    // ── AD-13 / AD-14 project_settings loader ──────────────────────────
    // `SELECT settings FROM project_settings WHERE project_id = ?`
    if (
      /^SELECT settings FROM project_settings WHERE project_id = \?$/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      const row = db.project_settings.find((r) => r.project_id === pid)
      return row ? [{ settings: row.settings }] : []
    }

    // ── AD-13 branching-search corpus load ─────────────────────────────
    // From apps/sync/src/lib/branching-search/corpus.ts. Reads source rows
    // from `COALESCE(upstream, projectId)`; LEFT JOINs target rows from the
    // calling project. Optional `validatedOnly` and `excludeCellId` clauses.
    //
    // Bind order: 0=projectId (target side, always), 1=upstream_or_null,
    //             2=projectId (source-side fallback), 3=excludeCellId (only
    //             when the exclude clause is present).
    {
      const corpusRe =
        /^SELECT s\.cell_id AS cell_id, s\.file_id AS file_id, s\.anchor_cell_id AS anchor_cell_id, s\.value AS source_text, s\.event_id AS source_event_id, COALESCE\(t\.value, ''\) AS target_text, COALESCE\(t\.validated, 0\) AS target_validated FROM cells s LEFT JOIN cells t ON t\.project_id = \? AND t\.cell_id = s\.cell_id AND t\.side = 'target' WHERE s\.project_id = COALESCE\(\?, \?\) AND s\.side = 'source'( AND t\.validated = 1)?( AND s\.cell_id != \?)? ORDER BY s\.cell_id$/
      const m = normalized.match(corpusRe)
      if (m) {
        const targetSideProjectId = args[0] as string
        const upstreamOrNull = args[1] as string | null
        const sourceFallbackProjectId = args[2] as string
        const validatedOnly = m[1] !== undefined
        const hasExcludeCell = m[2] !== undefined
        const excludeCellId = hasExcludeCell ? (args[3] as string) : null

        const sourceProjectId = upstreamOrNull ?? sourceFallbackProjectId
        type CorpusRow = {
          cell_id: string
          file_id: string
          anchor_cell_id: string | null
          source_text: string
          source_event_id: string
          target_text: string
          target_validated: number
        }
        const rows: CorpusRow[] = []
        for (const s of db.cells) {
          if (s.project_id !== sourceProjectId) continue
          if (s.side !== "source") continue
          if (excludeCellId && s.cell_id === excludeCellId) continue
          const t = db.cells.find(
            (c) =>
              c.project_id === targetSideProjectId &&
              c.cell_id === s.cell_id &&
              c.side === "target",
          )
          if (validatedOnly && (!t || t.validated !== 1)) continue
          rows.push({
            cell_id: s.cell_id,
            file_id: s.file_id,
            anchor_cell_id: s.anchor_cell_id ?? null,
            source_text: s.value,
            source_event_id: s.event_id,
            target_text: t?.value ?? "",
            target_validated: t?.validated ?? 0,
          })
        }
        rows.sort((a, b) =>
          a.cell_id < b.cell_id ? -1 : a.cell_id > b.cell_id ? 1 : 0,
        )
        return rows
      }
    }

    // ── UPDATE cells SET validated = (...) ─────────────────────────────
    // From validate/unvalidate: re-evaluate validated against the current
    // chain head (cells.event_id).
    // Bind order: 0=project_id, 1=file_id, 2=cell_id (subquery), 3=project_id, 4=file_id, 5=cell_id (WHERE).
	    if (/^UPDATE cells SET validated/.test(normalized)) {
	      const projectId = args[0] as string
      const fileId = args[4] as string
      const cellId = args[5] as string
      const cell = findCell(projectId, fileId, cellId)
      if (cell) {
        const activeForHead = db.cell_validators.some(
          (v) =>
            v.project_id === projectId &&
            v.file_id === fileId &&
            v.cell_id === cellId &&
            v.is_active === 1 &&
            v.edit_event_id === cell.event_id,
        )
        cell.validated = activeForHead ? 1 : 0
	      }
	      return []
	    }

	    if (
	      /^UPDATE cells SET endorsement_count = endorsement_count \+ 1 WHERE project_id = \? AND cell_id = \? AND side = 'target'$/.test(
	        normalized,
	      )
	    ) {
	      const projectId = args[0] as string
	      const cellId = args[1] as string
	      for (const cell of db.cells) {
	        if (
	          cell.project_id === projectId &&
	          cell.cell_id === cellId &&
	          cell.side === 'target'
	        ) {
	          cell.endorsement_count = (cell.endorsement_count ?? 0) + 1
	        }
	      }
	      return []
	    }

	    if (
	      /^UPDATE cells SET endorsement_count = max\(0, endorsement_count - 1\) WHERE project_id = \? AND cell_id =/.test(
	        normalized,
	      )
	    ) {
	      const projectId = args[0] as string
	      const endorsementEventId = args[1] as string
	      const endorsement = db.events.find(
	        (event) => event.id === endorsementEventId && event.kind === 'cell.endorsement',
	      )
	      if (!endorsement) return []
	      const payload = JSON.parse(endorsement.payload) as { endorsedCellId?: string }
	      for (const cell of db.cells) {
	        if (
	          cell.project_id === projectId &&
	          cell.cell_id === payload.endorsedCellId &&
	          cell.side === 'target'
	        ) {
	          cell.endorsement_count = Math.max(0, (cell.endorsement_count ?? 0) - 1)
	        }
	      }
	      return []
	    }

	    if (
	      /^UPDATE projects SET source_project_id = \?, updated_at = CURRENT_TIMESTAMP WHERE id = \?$/.test(
	        normalized,
	      )
	    ) {
	      const sourceProjectId = args[0] as string | null
	      const projectId = args[1] as string
	      const project = db.projects.find((p) => p.id === projectId)
	      if (project) project.source_project_id = sourceProjectId
	      return []
	    }

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
    _tables() {
      return db
    },
    _issuedStmts() {
      return issuedStmts
    },
  } as unknown as InMemoryD1

  return d1
}
