// Scoped search helpers — Step 5 of the v3 search permission model.
//
// This module is the SINGLE choke-point for all FTS5 cell-search queries.
// Every search surface MUST route through `queryScopedSearch` or
// `queryScopedExact` — both accept a `VerifiedProjectId` rather than a raw
// string, so passing an un-verified projectId is a TypeScript compile error.
//
// The permission boundary is structural, not advisory:
//   - `VerifiedProjectId` is a branded type that only `makeVerifiedProjectId`
//     can produce.
//   - `makeVerifiedProjectId` only accepts a `SyncTokenClaims` object — which
//     can only be obtained after JWT verification passes in auth.ts.
//   - The `AND cells.project_id = ?` predicate is hardcoded here, not supplied
//     by the caller, so it cannot be accidentally omitted.

import type { SyncTokenClaims } from "../auth"

// ---------------------------------------------------------------------------
// Branded type — the permission gate
// ---------------------------------------------------------------------------

/**
 * A projectId that has been verified against a decoded JWT claim. The brand
 * prevents any raw `string` from being passed where a scoped-query expects
 * a verified origin.
 *
 * Construction: only via `makeVerifiedProjectId(claims)` — never via a cast
 * at the call site.
 */
export type VerifiedProjectId = string & { __brand: "verified-project-id" }

/**
 * Produce a `VerifiedProjectId` from verified JWT claims. The caller is
 * responsible for obtaining `claims` via `verifyTokenForProject` (or similar)
 * before calling this. The type system enforces that `SyncTokenClaims` must
 * be satisfied — a raw `{ projectId: "abc" }` literal won't compile here
 * because it lacks the other required fields.
 */
export function makeVerifiedProjectId(claims: SyncTokenClaims): VerifiedProjectId {
  return claims.projectId as VerifiedProjectId
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface SearchResultOut {
  cellId: string
  fileId: string
  side: "source" | "target"
  value: string
  /** FTS5 snippet with `<mark>...</mark>` highlights around matched terms. */
  snippet: string
  rank: number
}

export interface ParallelPassageRow extends SearchResultOut {
  /**
   * The opposite-side cell value at the same (file_id, cell_id), if it
   * exists. null when there is no paired cell (e.g. orphaned source row, or
   * the project hasn't translated that cell yet).
   */
  pairedValue: string | null
}

// ---------------------------------------------------------------------------
// Raw DB row shapes (internal only)
// ---------------------------------------------------------------------------

interface SearchRowRaw {
  cell_id: string
  file_id: string
  side: "source" | "target"
  value: string
  snippet: string
  rank: number
}

interface ExactRowRaw extends SearchRowRaw {
  paired_value: string | null
}

// ---------------------------------------------------------------------------
// Sanitizers — exported so search-route.ts can import them (Step 6 will
// remove the duplicate in search-route.ts; for now both coexist).
// ---------------------------------------------------------------------------

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

/**
 * Sanitize a phrase for FTS5 adjacent-phrase (ordered) matching. Like
 * `sanitizeFtsQuery` in cleanup, but wraps the whole token sequence in a
 * single pair of double quotes so FTS5 treats them as a contiguous phrase —
 * `"token1 token2 token3"` matches cells where those tokens appear in that
 * exact order with no gaps.
 *
 * Differs from `sanitizeFtsQuery` (which emits `"t1" "t2"` — all tokens
 * present, any order) — this is the right choice when the caller wants
 * "find cells containing this exact phrase".
 *
 * Returns null for empty / all-reserved input; callers should treat null as
 * "no results".
 */
export function sanitizeFtsExactPhrase(raw: string): string | null {
  const cleaned = raw.replace(/["()*:+\-]/g, " ")
  const RESERVED = new Set(["and", "or", "not", "near"])
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !RESERVED.has(t.toLowerCase()))
  if (tokens.length === 0) return null
  // Single quoted phrase — FTS5 matches the exact token sequence in order.
  return '"' + tokens.join(" ") + '"'
}

// ---------------------------------------------------------------------------
// Limit helpers
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

function clampLimit(n: number | undefined): number {
  if (n === undefined) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, n))
}

// ---------------------------------------------------------------------------
// queryScopedSearch — ranked free-text search
// ---------------------------------------------------------------------------

/**
 * Run an FTS5 ranked search over `cells_fts` for the given project. The
 * project scope (`AND cells.project_id = ?`) is hardcoded — the caller
 * cannot bypass it.
 *
 * Throws on FTS5 syntax errors so the route layer can decide 400 vs 500.
 * Returns [] when the sanitizer reduces `q` to nothing.
 */
export async function queryScopedSearch(
  db: D1Database,
  verifiedProjectId: VerifiedProjectId,
  q: string,
  opts: { side?: "source" | "target"; limit?: number },
): Promise<SearchResultOut[]> {
  const ftsQuery = sanitizeFtsQuery(q)
  if (!ftsQuery) return []

  const limit = clampLimit(opts.limit)

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
  const binds: unknown[] = [ftsQuery, verifiedProjectId]

  if (opts.side !== undefined) {
    parts.push("AND cells.side = ?")
    binds.push(opts.side)
  }
  parts.push("ORDER BY rank ASC")
  parts.push("LIMIT ?")
  binds.push(limit)

  const sql = parts.join(" ")

  // Let FTS5 syntax errors propagate — the route layer converts them to 400.
  const result = await db.prepare(sql).bind(...binds).all<SearchRowRaw>()
  return result.results.map((row) => ({
    cellId: row.cell_id,
    fileId: row.file_id,
    side: row.side,
    value: row.value,
    snippet: row.snippet,
    rank: row.rank,
  }))
}

// ---------------------------------------------------------------------------
// queryScopedExact — ordered-phrase search with paired-side value
// ---------------------------------------------------------------------------

/**
 * Run an FTS5 exact-phrase search over `cells_fts` for the given project,
 * and LEFT JOIN back to `cells` to fetch the opposite-side cell value at
 * the same (file_id, cell_id). Useful for the parallel-passages UI that
 * shows a source match next to its translation (or vice-versa).
 *
 * The project scope (`AND cells.project_id = ?`) is hardcoded — the caller
 * cannot bypass it.
 *
 * Throws on FTS5 syntax errors. Returns [] when `exactText` sanitizes away.
 */
export async function queryScopedExact(
  db: D1Database,
  verifiedProjectId: VerifiedProjectId,
  exactText: string,
  opts: { side?: "source" | "target"; limit?: number },
): Promise<ParallelPassageRow[]> {
  const ftsQuery = sanitizeFtsExactPhrase(exactText)
  if (!ftsQuery) return []

  const limit = clampLimit(opts.limit)

  // The LEFT JOIN on `paired` fetches the opposite-side cell at the same
  // logical address. CASE flips source↔target so one query covers both
  // directions. `paired.value` is null when no paired row exists.
  const parts: string[] = [
    "SELECT",
    "  cells.cell_id   AS cell_id,",
    "  cells.file_id   AS file_id,",
    "  cells.side      AS side,",
    "  cells.value     AS value,",
    "  snippet(cells_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet,",
    "  cells_fts.rank  AS rank,",
    "  paired.value    AS paired_value",
    "FROM cells_fts",
    "JOIN cells ON cells.rowid = cells_fts.rowid",
    "LEFT JOIN cells AS paired",
    "  ON  paired.project_id = cells.project_id",
    "  AND paired.file_id    = cells.file_id",
    "  AND paired.cell_id    = cells.cell_id",
    "  AND paired.side       = CASE cells.side WHEN 'source' THEN 'target' ELSE 'source' END",
    "WHERE cells_fts MATCH ?",
    "AND cells.project_id = ?",
  ]
  const binds: unknown[] = [ftsQuery, verifiedProjectId]

  if (opts.side !== undefined) {
    parts.push("AND cells.side = ?")
    binds.push(opts.side)
  }
  parts.push("ORDER BY rank ASC")
  parts.push("LIMIT ?")
  binds.push(limit)

  const sql = parts.join(" ")

  const result = await db.prepare(sql).bind(...binds).all<ExactRowRaw>()
  return result.results.map((row) => ({
    cellId: row.cell_id,
    fileId: row.file_id,
    side: row.side,
    value: row.value,
    snippet: row.snippet,
    rank: row.rank,
    pairedValue: row.paired_value,
  }))
}
