// Project-wide cell search (Phase 2b). FTS5-backed.
//
//   GET /api/v1/projects/:projectId/search?q=&side=&limit=
//
// Query params:
//   q     — required, the user's search text. We MATCH against the
//           `cells_fts` virtual table (created by frontier-server migration
//           0003_cells_reshape.sql against `cells.value`). The string is
//           sanitized — special FTS5 syntax characters are stripped so a
//           translator typing `"`, `*`, `(`, `:`, or a stray AND/OR doesn't
//           explode the query. Phrase matching is achieved by wrapping the
//           sanitized terms in double quotes.
//   side  — optional. "source" | "target". Filters to one side of the
//           paired cells; useful for "find source matches" UX. When omitted,
//           both sides are returned and the client merges by `cellId`.
//   limit — optional. Default 50, max 500.
//
// Returns `{ results: [{ cellId, fileId, side, value, snippet, rank }] }`.
// Ordering is FTS5 rank ASC (best matches first; rank is a negative log
// likelihood — smaller is better).
//
// Auth: sync-token JWT scoped to `projectId`; minimum role viewer (100).

import { verifyTokenForProject } from "../auth"

export interface SearchReadEnv {
  AQUILLA_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

interface SearchRowRaw {
  cell_id: string
  file_id: string
  side: "source" | "target"
  value: string
  snippet: string
  rank: number
}

interface SearchResultOut {
  cellId: string
  fileId: string
  side: "source" | "target"
  value: string
  /** FTS5 snippet with `<mark>...</mark>` highlights around matched terms. */
  snippet: string
  rank: number
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/search$/

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

/**
 * Sanitize a free-text query for FTS5 MATCH. FTS5's parser blows up on
 * unbalanced parens, bare colons, double quotes mid-token, and the reserved
 * keywords AND/OR/NOT/NEAR. We strip those out and wrap the survivors in
 * double quotes to force phrase matching, which is the closest UX to
 * "what the translator typed".
 *
 * Returns null when the resulting query is empty (e.g. the user typed only
 * punctuation). Callers should treat null as "no results".
 */
export function sanitizeFtsQuery(raw: string): string | null {
  // Drop FTS5 syntax punctuation: quotes, parens, colons, asterisks, pluses,
  // minuses. Keep letters, digits, whitespace, and dashes-internal-to-words
  // (we collapse runs of non-word into a single space below).
  const cleaned = raw.replace(/["()*:+\-]/g, " ")
  // Split into bare tokens; reject the FTS reserved keywords case-insensitively
  // by lowercasing the comparison.
  const RESERVED = new Set(["and", "or", "not", "near"])
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !RESERVED.has(t.toLowerCase()))
  if (tokens.length === 0) return null
  // Wrap each token in double quotes — FTS5 treats `"foo"` as a single-token
  // phrase, sidestepping any remaining parse ambiguity.
  return tokens.map((t) => `"${t}"`).join(" ")
}

export async function handleSearchReadRequest(
  request: Request,
  env: SearchReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== "GET") return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  }
  if (!env.AQUILLA_DB) {
    return new Response("AQUILLA_DB binding not configured", { status: 500 })
  }

  const projectId = decodeURIComponent(match[1])

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) {
    return new Response("missing Authorization header", { status: 401 })
  }

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    return new Response(auth.reason, { status: auth.status })
  }

  const q = url.searchParams.get("q")
  if (q === null || q.trim() === "") {
    return new Response("missing q", { status: 400 })
  }

  const qSide = url.searchParams.get("side")
  let sideFilter: "source" | "target" | null = null
  if (qSide !== null) {
    if (qSide !== "source" && qSide !== "target") {
      return new Response("invalid side: must be source or target", { status: 400 })
    }
    sideFilter = qSide
  }

  let limit = DEFAULT_LIMIT
  const qLimit = url.searchParams.get("limit")
  if (qLimit !== null) {
    const parsed = parseInt(qLimit, 10)
    if (!isNaN(parsed)) {
      limit = Math.min(MAX_LIMIT, Math.max(1, parsed))
    }
  }

  const ftsQuery = sanitizeFtsQuery(q)
  if (!ftsQuery) {
    return Response.json({ results: [] })
  }

  // FTS5 JOIN: cells_fts.rowid lines up with cells.rowid via the virtual
  // table's external-content binding (migration 0003).
  //   snippet(table, col, start, end, ellipsis, max_tokens)
  //     col=0 → the only column we indexed ("value")
  //     start/end → <mark>/</mark> highlight tags
  //     ellipsis → "..." for truncated tails
  //     max_tokens → 16, plenty for "saw the match in context" UX
  const parts: string[] = [
    "SELECT",
    "  cells.cell_id   AS cell_id,",
    "  cells.file_id   AS file_id,",
    "  cells.side      AS side,",
    "  cells.value     AS value,",
    "  snippet(cells_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet,",
    "  cells_fts.rank  AS rank",
    "FROM cells_fts",
    "JOIN cells ON cells.rowid = cells_fts.rowid",
    "WHERE cells_fts MATCH ?",
    "AND cells.project_id = ?",
  ]
  const binds: unknown[] = [ftsQuery, projectId]
  if (sideFilter !== null) {
    parts.push("AND cells.side = ?")
    binds.push(sideFilter)
  }
  parts.push("ORDER BY rank ASC")
  parts.push("LIMIT ?")
  binds.push(limit)

  const sql = parts.join(" ")

  try {
    const result = await env.AQUILLA_DB.prepare(sql).bind(...binds).all<SearchRowRaw>()
    const out: SearchResultOut[] = result.results.map((row) => ({
      cellId: row.cell_id,
      fileId: row.file_id,
      side: row.side,
      value: row.value,
      snippet: row.snippet,
      rank: row.rank,
    }))
    return Response.json({ results: out })
  } catch (err) {
    // FTS5 syntax errors (e.g. the user wrote `"` un-balanced before our
    // sanitizer rolled out) surface as D1 prepare/exec failures. Surface
    // them as a 400 rather than 500 so the client can fall back to a
    // "no results" UI instead of an error banner.
    const message = err instanceof Error ? err.message : String(err)
    if (/syntax error|fts5/i.test(message)) {
      return new Response(`invalid search query: ${message}`, { status: 400 })
    }
    return new Response(`search failed: ${message}`, { status: 500 })
  }
}
