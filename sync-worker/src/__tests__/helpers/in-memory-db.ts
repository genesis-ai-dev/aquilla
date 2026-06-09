// Shared in-memory DB fake for sync-worker tests.
//
// Recognizes the SQL patterns the events / cells code actually issues. SQL
// strings are normalized (collapse whitespace) before matching so a code
// change that only reformats SQL doesn't silently break the fake.

/** Mirrors a single row in the cells_fts virtual table (external-content). */
export interface CellsFtsRow {
  rowid: number
  value: string
}

export interface Tables {
  events: EventRow[]
  cells: CellRow[]
  cell_validators: ValidatorRow[]
  cell_waivers: WaiverRow[]
  files: FileRow[]
  comments: CommentRow[]
  cells_fts: CellsFtsRow[]
  assignments: AssignmentRow[]
  assignment_cells: AssignmentCellRow[]
}

export interface AssignmentRow {
  assignment_id: string
  project_id: string
  assignee_user_id: number
  scope_kind: string
  scope_label: string
  cells_total: number
  deadline: string | null
  note: string | null
  created_by: number
  created_at: number
  unassigned_at: number | null
  completed_at: number | null
}

export interface AssignmentCellRow {
  assignment_id: string
  file_id: string
  cell_id: string
}

export interface WaiverRow {
  project_id: string
  file_id: string
  cell_id: string
  rule_id: string
  reason: string | null
  waived_by: string
  waived_ts: number
}

export interface CommentRow {
  comment_id: string
  project_id: string
  scope_kind: string
  file_id: string | null
  cell_id: string | null
  parent_comment_id: string | null
  body: string
  resolved: number
  author_id: string
  author_label: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
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
  word_count: number
  content_hash?: string | null
  endorsement_count?: number
  start_ms?: number | null
  end_ms?: number | null
}

export interface ValidatorRow {
  project_id: string
  file_id: string
  cell_id: string
  /** The validated commit's event_id (renamed from edit_event_id in 0012). */
  event_id: string
  username: string
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
  updated_at?: number
  projected_from?: string | null
}

export type InMemoryDb = AquillaDb & {
  _tables(): Tables
  _issuedStmts(): Array<{ sql: string; args: unknown[] }>
  /** Assign stable rowids to cells (1-based index order) so FTS tests can
   *  assert against them. Call after seeding cells. */
  _assignRowids(): void
}

export function makeInMemoryDb(tables: Partial<Tables> = {}): InMemoryDb {
  const db: Tables = {
    events: tables.events ?? [],
    cells: tables.cells ?? [],
    cell_validators: tables.cell_validators ?? [],
    cell_waivers: tables.cell_waivers ?? [],
    files: tables.files ?? [],
    comments: tables.comments ?? [],
    cells_fts: tables.cells_fts ?? [],
    assignments: tables.assignments ?? [],
    assignment_cells: tables.assignment_cells ?? [],
  }

  // Stable rowid map: cell array-index → 1-based rowid. Populated lazily on
  // the first cells_fts SELECT so callers don't need to call _assignRowids()
  // manually. Each new cell pushed after the map was built gets the next id.
  const rowidMap = new Map<CellRow, number>()
  let nextRowid = 1

  function getRowid(cell: CellRow): number {
    if (!rowidMap.has(cell)) {
      rowidMap.set(cell, nextRowid++)
    }
    return rowidMap.get(cell)!
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
      /^SELECT id, server_seq FROM events WHERE project_id = \? AND file_id = \? AND cell_id = \? AND parent_id IS NULL AND kind IN \([^)]*\) ORDER BY server_seq ASC, id ASC LIMIT 1$/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      const fid = args[1] as string
      const cid = args[2] as string
      const kinds = parseKindList(normalized)
      const matches = db.events
        .filter((e) => e.project_id === pid && e.file_id === fid && e.cell_id === cid && e.parent_id === null && kinds.has(e.kind))
        .sort((a, b) => (a.server_seq - b.server_seq) || a.id.localeCompare(b.id))
      return matches.length ? [{ id: matches[0].id, server_seq: matches[0].server_seq }] : []
    }
    if (
      /^SELECT id, server_seq FROM events WHERE project_id = \? AND file_id = \? AND cell_id = \? AND parent_id = \? AND kind IN \([^)]*\) ORDER BY server_seq ASC, id ASC LIMIT 1$/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      const fid = args[1] as string
      const cid = args[2] as string
      const parent = args[3] as string
      const kinds = parseKindList(normalized)
      const matches = db.events
        .filter((e) => e.project_id === pid && e.file_id === fid && e.cell_id === cid && e.parent_id === parent && kinds.has(e.kind))
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

    // ── GET /api/v1/projects/:projectId/search/passages ───────────────────
    // queryScopedExact SQL (after whitespace-collapse):
    //   SELECT cells.cell_id AS cell_id, cells.file_id AS file_id,
    //          cells.side AS side, cells.value AS value,
    //          snippet(cells_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet,
    //          cells_fts.rank AS rank, paired.value AS paired_value
    //     FROM cells_fts
    //     JOIN cells ON cells.rowid = cells_fts.rowid
    //     LEFT JOIN cells AS paired
    //       ON paired.project_id = cells.project_id
    //      AND paired.file_id = cells.file_id
    //      AND paired.cell_id = cells.cell_id
    //      AND paired.side = CASE cells.side WHEN 'source' THEN 'target' ELSE 'source' END
    //    WHERE cells_fts MATCH ? AND cells.project_id = ?
    //      [AND cells.side = ?]
    //    ORDER BY rank ASC LIMIT ?
    if (
      /^SELECT cells\.cell_id AS cell_id, cells\.file_id AS file_id, cells\.side AS side, cells\.value AS value, snippet\(cells_fts, 0, '<mark>', '<\/mark>', '\.\.\.', 16\) AS snippet, cells_fts\.rank AS rank, paired\.value AS paired_value FROM cells_fts JOIN cells ON cells\.rowid = cells_fts\.rowid LEFT JOIN cells AS paired ON paired\.project_id = cells\.project_id AND paired\.file_id = cells\.file_id AND paired\.cell_id = cells\.cell_id AND paired\.side = CASE cells\.side WHEN 'source' THEN 'target' ELSE 'source' END WHERE cells_fts MATCH \? AND cells\.project_id = \?/.test(
        normalized,
      )
    ) {
      const ftsQuery = args[0] as string
      const pid = args[1] as string
      const hasSide = normalized.includes("AND cells.side = ?")
      const side = hasSide ? (args[2] as string) : null
      const limit = args[hasSide ? 3 : 2] as number

      // Parse quoted tokens from the sanitized FTS query (exact phrase is one
      // double-quoted token containing spaces, e.g. `"foo bar"`).
      const tokens = (ftsQuery.match(/"[^"]+"/g) ?? []).map((t) =>
        t.slice(1, -1).toLowerCase(),
      )

      const matched = db.cells
        .filter((c) => c.project_id === pid)
        .filter((c) => side === null || c.side === side)
        .filter((c) => {
          if (tokens.length === 0) return false
          const v = c.value.toLowerCase()
          // For the exact-phrase fake, each token string is the full phrase
          // (possibly multi-word). Check that every token appears in the value.
          return tokens.every((t) => v.includes(t))
        })
        .map((c, idx) => {
          // Resolve the paired-side cell at the same (project_id, file_id, cell_id).
          const pairedSide = c.side === 'source' ? 'target' : 'source'
          const paired = db.cells.find(
            (p) =>
              p.project_id === c.project_id &&
              p.file_id === c.file_id &&
              p.cell_id === c.cell_id &&
              p.side === pairedSide,
          )
          return {
            cell_id: c.cell_id,
            file_id: c.file_id,
            side: c.side,
            value: c.value,
            snippet: c.value,
            rank: idx,
            paired_value: paired?.value ?? null,
          }
        })
        .slice(0, limit)
      return matched
    }

    // ── GET /cell-validators read route ─────────────────────────────────
    if (
      /^SELECT event_id, username, decided_ts FROM cell_validators WHERE project_id = \? AND file_id = \? AND cell_id = \? ORDER BY decided_ts DESC/.test(
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
          event_id: v.event_id,
          username: v.username,
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
    // DELETE-on-unvalidate: every row is active, no is_active filter.
    if (
      /^SELECT cell_id, event_id, username FROM cell_validators WHERE project_id = \? AND file_id = \?$/.test(
        normalized,
      )
    ) {
      const projectId = args[0] as string
      const fileId = args[1] as string
      return db.cell_validators
        .filter((v) => v.project_id === projectId && v.file_id === fileId)
        .map((v) => ({
          cell_id: v.cell_id,
          event_id: v.event_id,
          username: v.username,
        }))
    }

    // ── GET /cells/audit-stats — waivers select ────────────────────────
    // DELETE-on-unwaive: every row present is an active waiver.
    if (
      /^SELECT cell_id, rule_id, reason, waived_by, waived_ts FROM cell_waivers WHERE project_id = \? AND file_id = \?$/.test(
        normalized,
      )
    ) {
      const projectId = args[0] as string
      const fileId = args[1] as string
      return db.cell_waivers
        .filter((w) => w.project_id === projectId && w.file_id === fileId)
        .map((w) => ({
          cell_id: w.cell_id,
          rule_id: w.rule_id,
          reason: w.reason,
          waived_by: w.waived_by,
          waived_ts: w.waived_ts,
        }))
    }

    // ── GET /api/v1/projects/:projectId/files (list) ──────────────────
    // v3 schema: columns are role, kind, event_id, meta instead of file_type, source_language, target_language
    if (
      /^SELECT id, project_id, name, role, kind, event_id, meta, cell_count, approved_count, word_count, last_edit_at FROM files WHERE project_id = \? ORDER BY/.test(
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
          role: null,
          kind: f.file_type ?? null,
          event_id: "",
          meta: JSON.stringify({
            source_language: f.source_language ?? null,
            target_language: f.target_language ?? null,
          }),
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
    // v3 schema: columns are role, kind, event_id, meta instead of file_type, source_language, target_language
    if (
      /^SELECT id, project_id, name, role, kind, event_id, meta, cell_count, approved_count, word_count, last_edit_at FROM files WHERE project_id = \? AND id = \?$/.test(
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
          role: null,
          kind: f.file_type ?? null,
          event_id: "",
          meta: JSON.stringify({
            source_language: f.source_language ?? null,
            target_language: f.target_language ?? null,
          }),
          cell_count: f.cell_count ?? 0,
          approved_count: f.approved_count ?? 0,
          word_count: f.word_count ?? 0,
          last_edit_at: f.last_edit_at ?? null,
        },
      ]
    }

    // ── GET /api/v1/projects/:projectId/files/:fileId/cells ────────────
    // Prefix-match intentional: the production SELECT always appends start_ms, end_ms after
    // endorsement_count, so matching only through endorsement_count handles both
    // timecode-aware and older column lists. The hasTimecodes check below conditionally
    // includes start_ms/end_ms in the returned rows.
    if (
      /^SELECT cell_id, side, value, value_html, type, canonical_ref, anchor_cell_id, event_id, source_event_id, last_editor, last_edit_at, validated, word_count, endorsement_count/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      const fid = args[1] as string
      const hasSide = normalized.includes("AND side = ?")
      const inMatch = normalized.match(/AND cell_id IN \(([^)]*)\)/)
      const hasTimecodes = normalized.includes("start_ms") && normalized.includes("end_ms")
      // bind order: [pid, fid, side?, ...cellIds]
      let bindIdx = 2
      const side: string | null = hasSide ? (args[bindIdx++] as string) : null
      const cellIdsFilter: string[] | null = inMatch
        ? (() => {
            const count = inMatch[1].split(",").length
            const ids: string[] = []
            for (let i = 0; i < count; i++) ids.push(args[bindIdx++] as string)
            return ids
          })()
        : null
      return db.cells
        .filter(
          (c) =>
            c.project_id === pid &&
            c.file_id === fid &&
            (side === null || c.side === side) &&
            (cellIdsFilter === null || cellIdsFilter.includes(c.cell_id)),
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
          word_count: c.word_count,
          endorsement_count: c.endorsement_count ?? 0,
          ...(hasTimecodes ? { start_ms: c.start_ms ?? null, end_ms: c.end_ms ?? null } : {}),
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

    // ── Single-cell DELETE scoped by side (event-projection *.cell.delete) ─
    if (/^DELETE FROM cells WHERE project_id = \? AND file_id = \? AND cell_id = \? AND side = \?$/.test(normalized)) {
      const pid = args[0] as string
      const fid = args[1] as string
      const cid = args[2] as string
      const side = args[3] as string
      db.cells = db.cells.filter(
        (c) => !(c.project_id === pid && c.file_id === fid && c.cell_id === cid && c.side === side),
      )
      return []
    }

    // ── INSERT events (canonical audit row) ────────────────────────────
    // Production uses `INSERT … SELECT … COALESCE((SELECT MAX(server_seq) …))
    // + 1` so the per-project monotonic seq is derived atomically inside the
    // statement (no read-modify-write race across concurrent batches).
    //
    // Two callers, two bind shapes:
    //   - handlers/{cell-events,file-create,comment-events}.ts bind 12 args
    //     (id, schema_version, project_id, file_id, cell_id, parent_id, kind,
    //      author, payload, client_ts, server_ts, project_id-for-subquery).
    //   - events/import-route.ts inlines schema_version=1 as a literal and
    //     binds 11 args (project_id is the last bind, used by the subquery).
    if (/^INSERT OR IGNORE INTO events\s*\(/.test(normalized)) {
      const importVariant = /SELECT \?, 1,/.test(normalized)
      const projectId = importVariant
        ? (args[1] as string)
        : (args[2] as string)
      // Derive the next per-project seq atomically — same as production SQL.
      let maxSeq = 0
      for (const e of db.events) {
        if (e.project_id === projectId && e.server_seq > maxSeq) maxSeq = e.server_seq
      }
      const row: EventRow = importVariant
        ? {
            id: args[0] as string,
            schema_version: 1,
            project_id: projectId,
            file_id: args[2] as string | null,
            cell_id: args[3] as string | null,
            parent_id: args[4] as string | null,
            kind: args[5] as string,
            author: args[6] as string,
            payload: args[7] as string,
            client_ts: args[8] as number,
            server_ts: args[9] as number,
            server_seq: maxSeq + 1,
          }
        : {
            id: args[0] as string,
            schema_version: args[1] as number,
            project_id: projectId,
            file_id: args[3] as string | null,
            cell_id: args[4] as string | null,
            parent_id: args[5] as string | null,
            kind: args[6] as string,
            author: args[7] as string,
            payload: args[8] as string,
            client_ts: args[9] as number,
            server_ts: args[10] as number,
            server_seq: maxSeq + 1,
          }
      // INSERT OR IGNORE skips id-replays (the canonical idempotency path).
      const exists = db.events.some((e) => e.id === row.id)
      if (exists) return []
      // The unique-on-(project_id, server_seq) index is unreachable with
      // atomic derivation, but mirror it so any future code path that
      // bypasses the subquery and produces a duplicate seq trips loudly.
      const seqClash = db.events.some(
        (e) => e.project_id === row.project_id && e.server_seq === row.server_seq,
      )
      if (seqClash) {
        throw new Error(
          `UNIQUE constraint failed: events.project_id, events.server_seq ` +
            `(project=${row.project_id}, seq=${row.server_seq})`,
        )
      }
      db.events.push(row)
      return []
    }

    // ── INSERT cells (target.cell.commit UPSERT — literal 'target' in VALUES) ─
    // Bind order: 0=project_id, 1=file_id, 2=cell_id, 3=value, 4=value_html,
    //             5=event_id, 6=source_event_id, 7=last_editor, 8=last_edit_at,
    //             9=word_count, 10=content_hash
    if (/^INSERT INTO cells \(\s*project_id, file_id, cell_id, side, value, value_html, type, canonical_ref, anchor_cell_id, event_id, source_event_id, last_editor, last_edit_at, validated, word_count, content_hash\s*\) VALUES \(\?, \?, \?, 'target',/.test(
      normalized,
    )) {
      const projectId = args[0] as string
      const fileId = args[1] as string
      const cellId = args[2] as string
      const value = args[3] as string
      const valueHtml = args[4] as string | null
      const eventId = args[5] as string
      const sourceEventId = args[6] as string | null
      const lastEditor = args[7] as string | null
      const lastEditAt = args[8] as number
      const wordCount = args[9] as number
      const contentHash = args[10] as string | null

      const existing = db.cells.find(
        (c) => c.project_id === projectId && c.file_id === fileId && c.cell_id === cellId && c.side === 'target',
      )
      if (!existing) {
        db.cells.push({
          project_id: projectId,
          file_id: fileId,
          cell_id: cellId,
          side: 'target',
          value,
          value_html: valueHtml,
          type: null,
          canonical_ref: null,
          anchor_cell_id: null,
          event_id: eventId,
          source_event_id: sourceEventId,
          last_editor: lastEditor,
          last_edit_at: lastEditAt,
          validated: 0,
          word_count: wordCount,
          content_hash: contentHash,
        })
      } else {
        existing.value = value
        existing.value_html = valueHtml
        existing.event_id = eventId
        existing.source_event_id = sourceEventId
        existing.last_editor = lastEditor
        existing.last_edit_at = lastEditAt
        existing.word_count = wordCount
        existing.content_hash = contentHash
        existing.validated = 0
      }
      return []
    }

    // ── INSERT cells (cell create handlers) ─────────────────────────────
    // Prefix-match intentional: the production query always appends start_ms, end_ms after
    // content_hash, so matching only through content_hash lets this handler cover both
    // the timecode-carrying (new) and legacy (old) column lists without forking.
    if (/^INSERT INTO cells \(\s*project_id, file_id, cell_id, side, value, value_html, type, canonical_ref, anchor_cell_id, event_id, source_event_id, last_editor, last_edit_at, validated, word_count, content_hash/.test(
      normalized,
    )) {
      const hasTimecodes = normalized.includes('start_ms') && normalized.includes('end_ms')
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
        word_count: args[12] as number,
        content_hash: args[13] as string | null,
        start_ms: hasTimecodes ? (args[14] as number | null) : null,
        end_ms: hasTimecodes ? (args[15] as number | null) : null,
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
        if (hasTimecodes) {
          existing.start_ms = row.start_ms
          existing.end_ms = row.end_ms
        }
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
    if (/^UPDATE cells SET value = \?, value_html = \?, event_id = \?, last_editor = \?, last_edit_at = \?, word_count = \?, content_hash = \? WHERE project_id = \? AND file_id = \? AND cell_id = \?( AND side = 'source')?$/.test(
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
      // Find the source-side cell (the literal `AND side = 'source'` in SQL
      // ensures only the source row is updated in real Postgres; replicate that here).
      const cell = db.cells.find(
        (c) => c.project_id === projectId && c.file_id === fileId && c.cell_id === cellId && c.side === 'source',
      )
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

    // ── INSERT files (UPSERT) ───────────────────────────────────────────
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

    // ── INSERT cell_validators (UPSERT — cell.validate, 0012) ──────────
    if (/^INSERT INTO cell_validators/.test(normalized)) {
      const row: ValidatorRow = {
        project_id: args[0] as string,
        file_id: args[1] as string,
        cell_id: args[2] as string,
        event_id: args[3] as string,
        username: args[4] as string,
        decided_ts: args[5] as number,
      }
      const idx = db.cell_validators.findIndex(
        (v) =>
          v.project_id === row.project_id &&
          v.file_id === row.file_id &&
          v.cell_id === row.cell_id &&
          v.username === row.username,
      )
      if (idx === -1) {
        db.cell_validators.push(row)
      } else if (row.decided_ts > db.cell_validators[idx].decided_ts) {
        db.cell_validators[idx] = row
      }
      return []
    }

    // ── DELETE cell_validators (cell.unvalidate, 0012) ─────────────────
    if (
      /^DELETE FROM cell_validators WHERE project_id = \? AND file_id = \? AND cell_id = \? AND username = \?$/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      const fid = args[1] as string
      const cid = args[2] as string
      const user = args[3] as string
      db.cell_validators = db.cell_validators.filter(
        (v) => !(v.project_id === pid && v.file_id === fid && v.cell_id === cid && v.username === user),
      )
      return []
    }

    // ── UPDATE cells SET validated = (...) ─────────────────────────────
    // From validate/unvalidate: re-evaluate validated against the current
    // chain head (cells.event_id). side='target' filter matches 0012 SQL.
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
            v.event_id === cell.event_id,
        )
        cell.validated = activeForHead ? 1 : 0
      }
      return []
    }

    // ── INSERT cell_waivers (UPSERT — cell.waive, 0017) ────────────────
    if (/^INSERT INTO cell_waivers/.test(normalized)) {
      const row: WaiverRow = {
        project_id: args[0] as string,
        file_id: args[1] as string,
        cell_id: args[2] as string,
        rule_id: args[3] as string,
        reason: (args[4] as string | null) ?? null,
        waived_by: args[5] as string,
        waived_ts: args[6] as number,
      }
      const idx = db.cell_waivers.findIndex(
        (w) =>
          w.project_id === row.project_id &&
          w.file_id === row.file_id &&
          w.cell_id === row.cell_id &&
          w.rule_id === row.rule_id,
      )
      if (idx === -1) {
        db.cell_waivers.push(row)
      } else if (row.waived_ts > db.cell_waivers[idx].waived_ts) {
        db.cell_waivers[idx] = row
      }
      return []
    }

    // ── DELETE cell_waivers (cell.unwaive, 0017) ───────────────────────
    if (
      /^DELETE FROM cell_waivers WHERE project_id = \? AND file_id = \? AND cell_id = \? AND rule_id = \?$/.test(
        normalized,
      )
    ) {
      const pid = args[0] as string
      const fid = args[1] as string
      const cid = args[2] as string
      const rid = args[3] as string
      db.cell_waivers = db.cell_waivers.filter(
        (w) => !(w.project_id === pid && w.file_id === fid && w.cell_id === cid && w.rule_id === rid),
      )
      return []
    }

    // ── INSERT INTO comments (comment.create) ───────────────────────────
    if (/^INSERT INTO comments \(/.test(normalized)) {
      const row: CommentRow = {
        comment_id: args[0] as string,
        project_id: args[1] as string,
        scope_kind: args[2] as string,
        file_id: args[3] as string | null,
        cell_id: args[4] as string | null,
        parent_comment_id: args[5] as string | null,
        body: args[6] as string,
        resolved: 0,
        author_id: args[7] as string,
        author_label: args[8] as string | null,
        created_at: args[9] as number,
        updated_at: args[10] as number,
        deleted_at: null,
      }
      const exists = db.comments.some((c) => c.comment_id === row.comment_id)
      if (!exists) db.comments.push(row)
      return []
    }

    // ── UPDATE comments SET body = ?, updated_at = ? (comment.edit) ────
    if (/^UPDATE comments SET body = \?, updated_at = \? WHERE comment_id = \? AND author_id = \? AND deleted_at IS NULL$/.test(normalized)) {
      const body = args[0] as string
      const updatedAt = args[1] as number
      const commentId = args[2] as string
      const authorId = args[3] as string
      const row = db.comments.find((c) => c.comment_id === commentId && c.author_id === authorId && c.deleted_at === null)
      if (row) {
        row.body = body
        row.updated_at = updatedAt
      }
      return []
    }

    // ── UPDATE comments SET body = '', deleted_at = ? (comment.delete) ──
    if (/^UPDATE comments SET body = '', deleted_at = \?, updated_at = \? WHERE comment_id = \? AND author_id = \? AND deleted_at IS NULL$/.test(normalized)) {
      const deletedAt = args[0] as number
      const updatedAt = args[1] as number
      const commentId = args[2] as string
      const authorId = args[3] as string
      const row = db.comments.find((c) => c.comment_id === commentId && c.author_id === authorId && c.deleted_at === null)
      if (row) {
        row.body = ''
        row.deleted_at = deletedAt
        row.updated_at = updatedAt
      }
      return []
    }

    // ── UPDATE comments SET resolved = ? (comment.resolve) ─────────────
    if (/^UPDATE comments SET resolved = \?, updated_at = \? WHERE comment_id = \? AND parent_comment_id IS NULL AND deleted_at IS NULL$/.test(normalized)) {
      const resolved = args[0] as number
      const updatedAt = args[1] as number
      const commentId = args[2] as string
      const row = db.comments.find((c) => c.comment_id === commentId && c.parent_comment_id === null && c.deleted_at === null)
      if (row) {
        row.resolved = resolved
        row.updated_at = updatedAt
      }
      return []
    }

    // ── SELECT rowid, value FROM cells (rebuild-fts cursor page) ──────────
    // Pattern: SELECT rowid, value FROM cells WHERE project_id = ? AND rowid > ? ORDER BY rowid LIMIT 1000
    if (/^SELECT rowid, value FROM cells WHERE project_id = \? AND rowid > \? ORDER BY rowid LIMIT 1000$/.test(normalized)) {
      const pid = args[0] as string
      const afterRowid = args[1] as number
      // Ensure every cell in the project has a stable rowid assigned.
      for (const c of db.cells) getRowid(c)
      return db.cells
        .filter((c) => c.project_id === pid && getRowid(c) > afterRowid)
        .sort((a, b) => getRowid(a) - getRowid(b))
        .slice(0, 1000)
        .map((c) => ({ rowid: getRowid(c), value: c.value }))
    }

    // ── INSERT INTO cells_fts(cells_fts, rowid, value) — FTS5 delete ─────
    // VALUES form (from rebuild-fts, direct rowid):
    if (/^INSERT INTO cells_fts\(cells_fts, rowid, value\) VALUES \(\?, \?, \?\)$/.test(normalized)) {
      const cmd = args[0] as string
      const rowid = args[1] as number
      if (cmd === 'delete') {
        db.cells_fts = db.cells_fts.filter((r) => r.rowid !== rowid)
      }
      return []
    }

    // SELECT form (from event-projection.ts ftsDeleteStmt):
    //   INSERT INTO cells_fts(cells_fts, rowid, value)
    //     SELECT 'delete', rowid, value FROM cells
    //     WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = ?
    if (/^INSERT INTO cells_fts\(cells_fts, rowid, value\) SELECT 'delete', rowid, value FROM cells WHERE project_id = \? AND file_id = \? AND cell_id = \? AND side = \?$/.test(normalized)) {
      const pid = args[0] as string
      const fid = args[1] as string
      const cid = args[2] as string
      const side = args[3] as string
      // Find the matching cells row to get its rowid, then remove from cells_fts.
      const cellRow = db.cells.find(
        (c) => c.project_id === pid && c.file_id === fid && c.cell_id === cid && c.side === side,
      )
      if (cellRow) {
        const rowid = getRowid(cellRow)
        db.cells_fts = db.cells_fts.filter((r) => r.rowid !== rowid)
      }
      // No-op if no matching cells row exists (genuine first create).
      return []
    }

    // ── INSERT INTO cells_fts(rowid, value) — FTS5 insert ─────────────────
    // VALUES form (from rebuild-fts, direct rowid):
    if (/^INSERT INTO cells_fts\(rowid, value\) VALUES \(\?, \?\)$/.test(normalized)) {
      const rowid = args[0] as number
      const value = args[1] as string
      // Remove any stale entry then add fresh (idempotent within the fake).
      db.cells_fts = db.cells_fts.filter((r) => r.rowid !== rowid)
      db.cells_fts.push({ rowid, value })
      return []
    }

    // SELECT form (from event-projection.ts ftsInsertStmt):
    //   INSERT INTO cells_fts(rowid, value)
    //     SELECT rowid, value FROM cells
    //     WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = ?
    if (/^INSERT INTO cells_fts\(rowid, value\) SELECT rowid, value FROM cells WHERE project_id = \? AND file_id = \? AND cell_id = \? AND side = \?$/.test(normalized)) {
      const pid = args[0] as string
      const fid = args[1] as string
      const cid = args[2] as string
      const side = args[3] as string
      const cellRow = db.cells.find(
        (c) => c.project_id === pid && c.file_id === fid && c.cell_id === cid && c.side === side,
      )
      if (cellRow) {
        const rowid = getRowid(cellRow)
        // Remove any stale entry then add fresh (idempotent within the fake).
        db.cells_fts = db.cells_fts.filter((r) => r.rowid !== rowid)
        db.cells_fts.push({ rowid, value: cellRow.value })
      }
      return []
    }

    // ── UPDATE files SET cell_count/... (fileCountersRecomputeStmt) ──────
    // Recomputes the denormalized files rollup from the live cells rows.
    // Binds: pid,fid (x4 subqueries), serverTs, then fid,pid in the WHERE.
    if (/^UPDATE files SET cell_count = \(SELECT COUNT\(DISTINCT cell_id\) FROM cells WHERE project_id = \? AND file_id = \?\), approved_count = \(SELECT COUNT\(\*\) FROM cells WHERE project_id = \? AND file_id = \? AND validated = 1\), word_count = \(SELECT COALESCE\(SUM\(word_count\), 0\) FROM cells WHERE project_id = \? AND file_id = \? AND side = 'target'\), last_edit_at = \(SELECT MAX\(last_edit_at\) FROM cells WHERE project_id = \? AND file_id = \?\), updated_at = \? WHERE id = \? AND project_id = \?$/.test(normalized)) {
      const pid = args[0] as string
      const fid = args[1] as string
      const serverTs = args[8] as number
      const file = db.files.find((f) => f.id === fid && f.project_id === pid)
      if (file) {
        const fileCells = db.cells.filter((c) => c.project_id === pid && c.file_id === fid)
        file.cell_count = new Set(fileCells.map((c) => c.cell_id)).size
        file.approved_count = fileCells.filter((c) => c.validated === 1).length
        file.word_count = fileCells
          .filter((c) => c.side === 'target')
          .reduce((sum, c) => sum + (c.word_count ?? 0), 0)
        const editTimes = fileCells
          .map((c) => c.last_edit_at)
          .filter((t): t is number => typeof t === 'number')
        file.last_edit_at = editTimes.length > 0 ? Math.max(...editTimes) : null
        file.updated_at = serverTs
      }
      return []
    }

    // ── SELECT comments (comments-read-route) ────────────────────────────
    if (/^SELECT comment_id, project_id, scope_kind, file_id, cell_id, parent_comment_id, body, resolved, author_id, author_label, created_at, updated_at, deleted_at FROM comments WHERE project_id = \?/.test(normalized)) {
      const pid = args[0] as string
      let rows = db.comments.filter((c) => c.project_id === pid)
      // Optional fileId / cellId filters.
      if (normalized.includes("AND scope_kind = 'cell' AND file_id = ? AND cell_id = ?")) {
        const fileId = args[1] as string
        const cellId = args[2] as string
        rows = rows.filter((c) => c.scope_kind === 'cell' && c.file_id === fileId && c.cell_id === cellId)
      } else if (normalized.includes('AND file_id = ?')) {
        const fileId = args[1] as string
        rows = rows.filter((c) => c.file_id === fileId)
      }
      return rows.sort((a, b) => a.created_at - b.created_at)
    }

    // ── INSERT OR IGNORE INTO assignments (assignment.create) ──────────────
    if (/^INSERT OR IGNORE INTO assignments \(/.test(normalized)) {
      const row: AssignmentRow = {
        assignment_id: args[0] as string,
        project_id: args[1] as string,
        assignee_user_id: args[2] as number,
        scope_kind: args[3] as string,
        scope_label: args[4] as string,
        cells_total: 0,
        deadline: (args[5] as string | null) ?? null,
        note: (args[6] as string | null) ?? null,
        created_by: args[7] as number,
        created_at: args[8] as number,
        unassigned_at: null,
        completed_at: null,
      }
      if (!db.assignments.some((a) => a.assignment_id === row.assignment_id)) {
        db.assignments.push(row)
      }
      return []
    }

    // ── INSERT OR IGNORE INTO assignment_cells ... SELECT ... FROM cells ───
    // Resolves a book (no chapter) or chapter (canonical_ref LIKE 'BOOK CH:%')
    // scope into the assignment's source-cell set. INSERT OR IGNORE dedupes on
    // the (assignment_id, file_id, cell_id) PK.
    if (
      /^INSERT OR IGNORE INTO assignment_cells \(assignment_id, file_id, cell_id\) SELECT \?, file_id, cell_id FROM cells WHERE project_id = \? AND file_id = \? AND side = 'source'( AND canonical_ref LIKE \?)?$/.test(
        normalized,
      )
    ) {
      const assignmentId = args[0] as string
      const projectId = args[1] as string
      const fileId = args[2] as string
      const hasLike = normalized.includes('canonical_ref LIKE ?')
      // Patterns are always a prefix + '%' (e.g. 'GEN 1:%'); strip the '%'.
      const likePrefix = hasLike ? (args[3] as string).replace(/%$/, '') : null
      for (const c of db.cells) {
        if (c.project_id !== projectId || c.file_id !== fileId || c.side !== 'source') continue
        if (likePrefix !== null && !(c.canonical_ref ?? '').startsWith(likePrefix)) continue
        const exists = db.assignment_cells.some(
          (ac) => ac.assignment_id === assignmentId && ac.file_id === c.file_id && ac.cell_id === c.cell_id,
        )
        if (!exists) {
          db.assignment_cells.push({ assignment_id: assignmentId, file_id: c.file_id, cell_id: c.cell_id })
        }
      }
      return []
    }

    // ── UPDATE assignments SET cells_total = (SELECT COUNT(*) ...) ─────────
    if (
      /^UPDATE assignments SET cells_total = \(SELECT COUNT\(\*\) FROM assignment_cells WHERE assignment_id = \?\) WHERE assignment_id = \?$/.test(
        normalized,
      )
    ) {
      const countId = args[0] as string
      const whereId = args[1] as string
      const n = db.assignment_cells.filter((ac) => ac.assignment_id === countId).length
      const row = db.assignments.find((a) => a.assignment_id === whereId)
      if (row) row.cells_total = n
      return []
    }

    // ── UPDATE assignments SET assignee_user_id (assignment.reassign) ─────
    if (/^UPDATE assignments SET assignee_user_id = \? WHERE assignment_id = \? AND project_id = \?$/.test(normalized)) {
      const assignee = args[0] as number
      const assignmentId = args[1] as string
      const projectId = args[2] as string
      const row = db.assignments.find((a) => a.assignment_id === assignmentId && a.project_id === projectId)
      if (row) row.assignee_user_id = assignee
      return []
    }

    // ── UPDATE assignments SET unassigned_at (assignment.unassign) ────────
    if (/^UPDATE assignments SET unassigned_at = \? WHERE assignment_id = \? AND project_id = \?$/.test(normalized)) {
      const ts = args[0] as number
      const assignmentId = args[1] as string
      const projectId = args[2] as string
      const row = db.assignments.find((a) => a.assignment_id === assignmentId && a.project_id === projectId)
      if (row) row.unassigned_at = ts
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
    } as unknown as AquillaStatement

    ;(stmt as any).__sql = sql
    ;(stmt as any).__getArgs = () => boundArgs

    return stmt
  }

  const d1 = {
    prepare(sql: string) {
      return makePrepared(sql)
    },
    async batch(stmts: AquillaStatement[]) {
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
    _assignRowids() {
      for (const c of db.cells) getRowid(c)
    },
  } as unknown as InMemoryDb

  return d1
}
